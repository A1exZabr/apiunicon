import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createMcpServer, observeToolCall, toolAnnotations, z, type ToolResultEvent } from "../../src/mcp/server.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 23),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.example.test"],
  credentialBindings: [{ fieldName: "Api-Key", target: "header", headerName: "Api-Key" }],
  operations: [{
    id: "list_orders",
    description: "List recent orders",
    risk: "read",
    method: "GET",
    path: "/orders",
    input: { q: { type: "string", location: "query", required: false } },
    documentationRefs: [],
  }],
};

const KEYS = ["adapterId", "connectionId", "detail", "draftId", "durationMs", "httpStatus", "kind", "ok", "operationId", "tool"];

describe("the outcome of every tool call", () => {
  let application: Application;
  let clients: Client[];
  let events: ToolResultEvent[];
  let hostEvents: ToolResultEvent<"get_account">[];
  let connectionId: string;
  let adapterId: string;
  let hooked: Client;
  let plain: Client;
  let answer: () => Promise<Response>;

  async function connect(server: ReturnType<typeof createMcpServer>): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "tool-results-test", version: "1.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    clients = [];
    events = [];
    hostEvents = [];
    answer = async () => new Response(JSON.stringify({ error: "response-secret" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => answer(),
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    application.vault.storeFields("credentials-1", { "Api-Key": "key-secret" });
    adapterId = application.adapters.create({
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      documentationSourceId: source.id,
      dsl,
    }).id;
    connectionId = application.connections.createConnection({
      label: "First connection",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-1",
      adapterId,
    }).id;
    hooked = await connect(createMcpServer(application.mcpDependencies, { onToolResult: (event) => events.push(event) }));
    plain = await connect(createMcpServer(application.mcpDependencies));
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    application.db.close();
  });

  it("reports a successful call without identifiers it was not given", async () => {
    await hooked.callTool({ name: "list_connections", arguments: {} });

    expect(events).toEqual([{ tool: "list_connections", ok: true, kind: null, httpStatus: null, detail: null, connectionId: null, adapterId: null, operationId: null, draftId: null, durationMs: expect.any(Number) }]);
    expect(Number.isInteger(events[0]!.durationMs) && events[0]!.durationMs >= 0).toBe(true);
  });

  it("reports a thrown error by its class and passes the same error on to the client", async () => {
    const missing = randomUUID();

    const reply = await hooked.callTool({ name: "get_connection", arguments: { connectionId: missing } });

    expect(reply).toEqual(await plain.callTool({ name: "get_connection", arguments: { connectionId: missing } }));
    expect(reply.isError).toBe(true);
    expect(events).toEqual([expect.objectContaining({ tool: "get_connection", ok: false, kind: "NotFoundError", connectionId: missing, httpStatus: null })]);
  });

  it("reports a non-2xx answer of the service as upstream_http with its status and the request ids", async () => {
    const reply = await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "list_orders", args: { q: "argument-secret" } } });

    expect(reply.structuredContent).toMatchObject({ result: { ok: false, status: 401 } });
    expect(events).toEqual([{ tool: "test_adapter_operation", ok: false, kind: "upstream_http", httpStatus: 401, detail: '{"error":"response-secret"}', connectionId, adapterId, operationId: "list_orders", draftId: null, durationMs: expect.any(Number) }]);
  });

  it("answers exactly as without the hook when the hook itself throws", async () => {
    let hookCalls = 0;
    const throwing = await connect(createMcpServer(application.mcpDependencies, {
      onToolResult: () => {
        hookCalls += 1;
        throw new Error("hook failed");
      },
    }));

    for (const call of [{ name: "list_connections", arguments: {} }, { name: "get_connection", arguments: { connectionId: randomUUID() } }]) {
      expect(await throwing.callTool(call)).toEqual(await plain.callTool(call));
    }
    // The hook did run for each call, so the equal answers above are not just a hook that was never reached.
    expect(hookCalls).toBe(2);
  });

  // The SDK answers these before the tool's callback runs, so the hook never hears of them. This is accepted for now.
  it("does not report a call the SDK rejects before the tool runs, and the client still gets the SDK's answer", async () => {
    const calls = [
      { name: "get_connection", arguments: { connectionId: "not-a-uuid" } },
      { name: "no_such_tool", arguments: {} },
    ];
    const omitting = await connect(createMcpServer(application.mcpDependencies, { omitTools: ["get_adapter"], onToolResult: (event) => events.push(event) }));
    const plainOmitting = await connect(createMcpServer(application.mcpDependencies, { omitTools: ["get_adapter"] }));

    for (const call of calls) {
      const reply = await hooked.callTool(call);
      expect(reply.isError).toBe(true);
      expect(reply).toEqual(await plain.callTool(call));
    }
    const disabled = { name: "get_adapter", arguments: { adapterId: adapterId } };
    expect((await omitting.callTool(disabled)).isError).toBe(true);
    expect(await omitting.callTool(disabled)).toEqual(await plainOmitting.callTool(disabled));

    expect(events).toEqual([]);
  });

  it("puts no argument values or keys into the event, and the service's error text only into a failed call", async () => {
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "list_orders", args: { q: "argument-secret" } } });
    await hooked.callTool({ name: "call_adapter", arguments: { connectionId, operationId: "Drop everything secret-operation", args: { q: "argument-secret" } } });

    expect(events[0]).toMatchObject({ tool: "test_adapter_operation", ok: false, detail: '{"error":"response-secret"}' });
    expect(events[1]).toMatchObject({ tool: "call_adapter", ok: false, operationId: null, detail: "Adapter must be working before normal calls" });
    const text = JSON.stringify(events);
    for (const value of ["argument-secret", "key-secret", "secret-operation"]) expect(text).not.toContain(value);
    for (const event of events) expect(Object.keys(event).sort()).toEqual(KEYS);
  });

  it("does not repeat an operation id that is not one in the refusal of a call that reaches the runtime", async () => {
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "Drop everything secret-operation", args: {} } });
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "no_such_operation", args: {} } });

    expect(events.map(({ detail }) => detail)).toEqual(["Unknown adapter operation", "Unknown adapter operation: no_such_operation"]);
  });

  it("does not repeat an argument name that is not one in the refusal", async () => {
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "list_orders", args: { "Drop everything secret-argument": 1 } } });

    expect(events.map(({ detail }) => detail)).toEqual(["Unknown argument"]);
  });

  it("masks the connection's key in the text of a thrown error, and the runtime's redaction stays in an answer", async () => {
    answer = async () => {
      throw new TypeError("fetch failed for key-secret");
    };
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "list_orders", args: {} } });
    answer = async () => new Response(JSON.stringify({ error: "bad key-secret" }), { status: 403 });
    await hooked.callTool({ name: "test_adapter_operation", arguments: { connectionId, adapterId, operationId: "list_orders", args: {} } });

    expect(events.map(({ detail }) => detail)).toEqual(["fetch failed for [REDACTED]", '{"error":"bad [REDACTED]"}']);
  });

  it("wraps a host's own tool the same way and takes the error's code before its name", async () => {
    const failures = [
      Object.assign(new Error("host secret"), { code: "E_HOST" }),
      Object.assign(new Error("x"), { code: "bad code!" }),
    ];
    const host = await connect(createMcpServer(application.mcpDependencies, {
      extend: (server) => {
        server.registerTool("get_account", {
          title: "Get account",
          description: "Plan and usage.",
          inputSchema: z.object({ adapterId: z.string() }),
          annotations: toolAnnotations.storedRead,
        }, observeToolCall("get_account", async (_input: { adapterId: string }) => {
          throw failures.shift()!;
        }, (event) => hostEvents.push(event)));
      },
    }));

    await host.callTool({ name: "get_account", arguments: { adapterId: "not an id" } });
    await host.callTool({ name: "get_account", arguments: { adapterId: "not an id" } });

    expect(hostEvents.map(({ tool, ok, kind, adapterId: reported }) => ({ tool, ok, kind, adapterId: reported }))).toEqual([
      { tool: "get_account", ok: false, kind: "E_HOST", adapterId: null },
      { tool: "get_account", ok: false, kind: "Error", adapterId: null },
    ]);
  });
});

describe("observeToolCall on its own", () => {
  const UPPER_ID = "0A1B2C3D-0000-4000-8000-0123456789AB";

  async function observe(callback: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>, ...args: unknown[]) {
    const seen: ToolResultEvent<"probe">[] = [];
    const response = await observeToolCall("probe", callback, (event) => seen.push(event))(...args);
    return { seen, response };
  }

  it("throws the very object the tool threw and names only what is safe to name", async () => {
    const thrown: unknown[] = [
      Object.assign(new Error("m"), { code: "404" }),
      Object.assign(new Error("m"), { code: 404 }),
      new DOMException("x", "TimeoutError"),
      new DOMException("x", "AbortError"),
      Object.assign(new Error("m"), { code: "x".repeat(61) }),
      Object.assign(new Error("m"), { name: "Bad Name" }),
      new RangeError("m"),
      "plain text",
      null,
    ];
    const kinds: Array<string | null> = [];
    for (const value of thrown) {
      const seen: ToolResultEvent<"probe">[] = [];
      const wrapped = observeToolCall("probe", async () => { throw value; }, (event) => seen.push(event));
      await expect(wrapped()).rejects.toBe(value);
      expect(seen).toHaveLength(1);
      kinds.push(seen[0]!.kind);
    }

    // A numeric code is ignored: a DOMException carries a legacy one (23 for a timeout, 20 for an abort) that says less than its name.
    expect(kinds).toEqual(["404", "Error", "TimeoutError", "AbortError", "Error", "Error", "RangeError", "unknown", "unknown"]);
  });

  it("reads the status of any result that carries one, but only a real HTTP status", async () => {
    const result = (value: unknown) => ({ content: [], structuredContent: { result: value } });

    expect((await observe(() => result({ ok: true, status: 200, data: [] }))).seen[0]).toMatchObject({ ok: true, kind: null, httpStatus: 200 });
    expect((await observe(() => result({ ok: false, status: 503, error: "x" }))).seen[0]).toMatchObject({ ok: false, kind: "upstream_http", httpStatus: 503 });
    for (const status of [99, 600, 200.5, "200", null]) {
      expect((await observe(() => result({ ok: false, status }))).seen[0]).toMatchObject({ ok: false, kind: "upstream_http", httpStatus: null });
    }
    for (const value of [[{ ok: false }], "ok", 7, null]) {
      expect((await observe(() => result(value))).seen[0]).toMatchObject({ ok: true, kind: null, httpStatus: null });
    }
    expect((await observe(() => ({ content: [] }))).seen[0]).toMatchObject({ ok: true, kind: null, httpStatus: null });
  });

  it("takes ids only in their own shape and only from the first argument", async () => {
    const callback = () => ({ content: [] });

    expect((await observe(callback, { connectionId: UPPER_ID, adapterId: "not-a-uuid", operationId: "list_orders" })).seen[0])
      .toMatchObject({ connectionId: UPPER_ID, adapterId: null, operationId: "list_orders" });
    expect((await observe(callback, { operationId: "List Orders" })).seen[0]).toMatchObject({ operationId: null });
    expect((await observe(callback, { operationId: "a".repeat(101) })).seen[0]).toMatchObject({ operationId: null });
    expect((await observe(callback, { connectionId: 5, adapterId: [UPPER_ID] })).seen[0]).toMatchObject({ connectionId: null, adapterId: null });
    for (const first of [undefined, null, "text", 3]) {
      expect((await observe(callback, first, { connectionId: UPPER_ID })).seen[0]).toMatchObject({ connectionId: null, adapterId: null, operationId: null });
    }
  });

  it("returns the very response and survives an observer that throws or rejects", async () => {
    const response = { content: [], structuredContent: { result: { ok: true } } };
    let throwingCalls = 0;
    let rejectingCalls = 0;
    const returned = await observeToolCall("probe", async () => response, () => { throwingCalls += 1; throw new Error("sync"); })();
    const rejected = await observeToolCall("probe", () => response, async () => { rejectingCalls += 1; throw new Error("async"); })();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(returned).toBe(response);
    expect(rejected).toBe(response);
    // Both observers did run, so the untouched responses above are not just observers that were never reached.
    expect(throwingCalls).toBe(1);
    expect(rejectingCalls).toBe(1);
  });

  it("reads no keys for a successful call and gives no text when the keys cannot be read", async () => {
    const secretsFor = vi.fn(() => ["k".repeat(9)]);
    const seen: ToolResultEvent<"probe">[] = [];

    await observeToolCall("probe", () => ({ content: [] }), (event) => seen.push(event), { secretsFor })();
    expect(secretsFor).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ ok: true, detail: null });

    const failing = observeToolCall("probe", async () => {
      throw new Error("x");
    }, (event) => seen.push(event), {
      secretsFor: () => {
        throw new Error("vault");
      },
    });
    await expect(failing()).rejects.toThrow("x");
    expect(seen[1]).toMatchObject({ ok: false, kind: "Error", detail: null });
  });

  it("takes the text of a returned error result and cuts a long message to 500 characters", async () => {
    expect((await observe(() => ({ content: [{ type: "text", text: "host said no" }], isError: true }))).seen[0])
      .toMatchObject({ detail: "host said no" });
    const seen: ToolResultEvent<"probe">[] = [];
    await expect(observeToolCall("probe", async () => {
      throw new Error("e".repeat(700));
    }, (event) => seen.push(event))()).rejects.toThrow();
    expect(Array.from(seen[0]!.detail!)).toHaveLength(500);
  });

  it("takes a draft id only in its own shape", async () => {
    expect((await observe(() => ({ content: [] }), { draftId: UPPER_ID })).seen[0]).toMatchObject({ draftId: UPPER_ID });
    expect((await observe(() => ({ content: [] }), { draftId: "draft-1" })).seen[0]).toMatchObject({ draftId: null });
  });

  it("reports a returned error result as a failed call, naming the service's answer when there is one", async () => {
    const failed = { ok: false, kind: "tool_error", httpStatus: null };

    expect((await observe(() => ({ content: [], isError: true }))).seen[0]).toMatchObject(failed);
    expect((await observe(() => ({ content: [], isError: true, structuredContent: { result: { ok: true, status: 200 } } }))).seen[0])
      .toMatchObject({ ok: false, kind: "tool_error", httpStatus: 200 });
    expect((await observe(() => ({ content: [], isError: true, structuredContent: { result: { ok: false, status: 502 } } }))).seen[0])
      .toMatchObject({ ok: false, kind: "upstream_http", httpStatus: 502 });
    expect((await observe(() => ({ content: [], isError: false }))).seen[0]).toMatchObject({ ok: true, kind: null });
  });
});
