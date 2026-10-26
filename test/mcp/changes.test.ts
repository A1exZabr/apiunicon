import { readdirSync, readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application, type ApplicationOverrides } from "../../src/index.js";
import { createMcpServer, serverInstructions } from "../../src/mcp/server.js";
import { createToolHandlers, type ToolDependencies } from "../../src/mcp/tools.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 43),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [
    { id: "list_prices", description: "List prices", risk: "read", method: "GET", path: "/prices", input: {}, documentationRefs: [] },
    {
      id: "set_price",
      description: "Set the price of a card",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: {
        nmId: { type: "integer", location: "body", required: true, description: "Артикул" },
        price: { type: "integer", location: "body", required: true, description: "Цена, ₽" },
      },
      documentationRefs: [],
    },
  ],
};

function text(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

// What request_change gives the assistant: the JSON of its text, the only part of the result the model is shown.
function answerOf<T>(result: CallToolResult): T {
  expect(result.structuredContent).toBeUndefined();
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("request_change answered without text");
  return JSON.parse(first.text) as T;
}

describe("change tools", () => {
  let application: Application;
  let connectionId: string;
  let sent: string[];
  const clients: Client[] = [];

  async function connect(dependencies: ToolDependencies): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(dependencies).connect(serverSide);
    const client = new Client({ name: "change-tools-test", version: "1.0.0" });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  function setUp(overrides: ApplicationOverrides = {}): void {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? "GET"} ${input.toString()} ${typeof init?.body === "string" ? init.body : ""}`);
        return new Response(JSON.stringify({ updated: true }), { status: 200 });
      },
      ...overrides,
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    application.vault.storeFields("credentials-1", { Authorization: "shop-secret-1" });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1", adapterId: adapter.id,
    }).id;
    application.changes.setWrites(connectionId, true);
  }

  beforeEach(() => setUp());

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    application.db.close();
  });

  it("takes the link base from onboarding and the requester from the host", async () => {
    const onboarding = application.mcpDependencies.onboarding;
    if (!onboarding) throw new Error("The application has no onboarding");
    const client = await connect({
      ...application.mcpDependencies,
      onboarding: { ...onboarding, keyEntryBaseUrl: "https://example.test" },
      requestedVia: "ChatGPT",
    });

    const requested = await client.callTool({
      name: "request_change",
      arguments: { connectionId, operationId: "set_price", args: { nmId: 123456789, price: 349 }, summary: "Set the price to 349" },
    }) as CallToolResult;

    expect(requested.isError).not.toBe(true);
    const result = answerOf<{ status: string; changeId: string; confirmation: { url: string } }>(requested);
    expect(result.status).toBe("pending");
    expect(result.confirmation.url.startsWith(`https://example.test/confirm/change/${result.changeId}?t=`)).toBe(true);
    expect(application.changes.list({ connectionId, limit: 1 })[0]).toMatchObject({ id: result.changeId, requestedVia: "ChatGPT" });
    expect(sent).toEqual([]);

    const state = await client.callTool({ name: "get_change", arguments: { changeId: result.changeId } }) as CallToolResult;
    expect(state.structuredContent).toMatchObject({ result: { changeId: result.changeId, status: "pending" } });

    // The local application names nobody.
    const local = await connect(application.mcpDependencies);
    const plain = await local.callTool({
      name: "request_change",
      arguments: { connectionId, operationId: "set_price", args: { nmId: 123456789, price: 350 }, summary: "Set the price to 350" },
    }) as CallToolResult;
    const localResult = answerOf<{ changeId: string; confirmation: { url: string } }>(plain);
    expect(localResult.confirmation.url.startsWith("http://127.0.0.1:3210/confirm/change/")).toBe(true);
    expect(application.changes.list({ connectionId, limit: 1 })[0]).toMatchObject({ id: localResult.changeId, requestedVia: null });
  });

  it("asks a host's hook which assistant requests a change only when request_change runs", async () => {
    const requestChange = (client: Client, price: number) => client.callTool({
      name: "request_change",
      arguments: { connectionId, operationId: "set_price", args: { nmId: 123456789, price }, summary: `Set the price to ${price}` },
    }) as Promise<CallToolResult>;
    const requester = async (client: Client, price: number) => {
      const result = answerOf<{ changeId: string }>(await requestChange(client, price));
      return application.changes.list({ connectionId, limit: 10 }).find(({ id }) => id === result.changeId)?.requestedVia;
    };

    // A hook given with the tools, as a host that builds them for each request does.
    let asked = 0;
    const perRequest = await connect({
      ...application.mcpDependencies,
      requestedVia: async () => {
        asked += 1;
        return asked === 1 ? "ChatGPT" : null;
      },
    });
    await perRequest.callTool({ name: "list_connections", arguments: {} });
    await perRequest.callTool({ name: "get_connection", arguments: { connectionId } });
    expect(asked).toBe(0);
    expect(await requester(perRequest, 349)).toBe("ChatGPT");
    expect(await requester(perRequest, 350)).toBeNull();
    expect(asked).toBe(2);

    // A hook given to the application, for every change it is asked for.
    application.db.close();
    let built = 0;
    setUp({
      requestedVia: () => {
        built += 1;
        return "Claude Code";
      },
    });
    const hosted = await connect(application.mcpDependencies);
    await hosted.callTool({ name: "list_connections", arguments: {} });
    expect(built).toBe(0);
    expect(await requester(hosted, 351)).toBe("Claude Code");
    expect(built).toBe(1);
    // A name the tools carry still wins over the application's hook.
    expect(await requester(await connect({ ...application.mcpDependencies, requestedVia: "Claude" }), 352)).toBe("Claude");
    expect(built).toBe(1);
    expect(sent).toEqual([]);
  });

  it("answers call_adapter on a write operation with the way to request_change", async () => {
    const client = await connect(application.mcpDependencies);

    const called = await client.callTool({
      name: "call_adapter",
      arguments: { connectionId, operationId: "set_price", args: { nmId: 123456789, price: 349 } },
    }) as CallToolResult;

    expect(called.isError).toBe(true);
    expect(text(called)).toContain(
      "Operation set_price changes data (write). Call request_change instead; its result says whether the change ran at once or needs the person's confirmation on a page first.",
    );
    expect(sent).toEqual([]);
  });

  it("tells with every connection shown that the plan does not include changing data, and nothing where it does", async () => {
    const refusal = "Changing data is available on the Pro and Business plans. The person can choose a plan at https://cloud.test/pricing.";
    application.db.close();
    setUp({ writes: { check: async () => ({ reason: "plan", message: refusal }), settingsUrl: (base, id) => `${base}/connections#${id}` } });
    const tools = createToolHandlers(application.mcpDependencies);
    expect(await tools.list_connections({})).toEqual([expect.objectContaining({ id: connectionId, changingData: refusal })]);
    expect(await tools.get_connection({ connectionId })).toMatchObject({ id: connectionId, changingData: refusal });

    application.db.close();
    setUp();
    const allowed = createToolHandlers(application.mcpDependencies);
    expect((await allowed.list_connections({}))[0]).not.toHaveProperty("changingData");
    expect(await allowed.get_connection({ connectionId })).not.toHaveProperty("changingData");
  });

  it("shows each connection's mode with the account-wide setting taken in, and never the connection's own switch", async () => {
    const tools = createToolHandlers(application.mcpDependencies);
    expect(await tools.list_connections({})).toEqual([expect.objectContaining({ id: connectionId, changesConfirmation: "required" })]);
    expect((await tools.list_connections({}))[0]).not.toHaveProperty("confirmChanges");
    expect(await tools.get_connection({ connectionId })).toMatchObject({ changesConfirmation: "required" });

    application.changes.setSkipConfirmationEverywhere(true);
    expect(await tools.get_connection({ connectionId })).toMatchObject({ changesConfirmation: "off" });
    expect(await tools.list_connections({})).toEqual([expect.objectContaining({ changesConfirmation: "off" })]);
    application.changes.setSkipConfirmationEverywhere(false);
    application.changes.setConfirmChanges(connectionId, false);
    expect(await tools.get_connection({ connectionId })).toMatchObject({ changesConfirmation: "off" });
    expect(await tools.get_connection({ connectionId })).not.toHaveProperty("confirmChanges");
    // The other tools that answer with a connection do not carry the switch either.
    const renamed = await tools.rename_connection({ connectionId, label: "Магазин" });
    expect(renamed).toMatchObject({ label: "Магазин", changesConfirmation: "off" });
    expect(renamed).not.toHaveProperty("confirmChanges");

    // A process that cannot change data shows no mode at all.
    const { changes: _changes, ...withoutChanges } = application.mcpDependencies;
    const readOnly = createToolHandlers(withoutChanges);
    expect((await readOnly.list_connections({}))[0]).not.toHaveProperty("changesConfirmation");
    expect((await readOnly.list_connections({}))[0]).not.toHaveProperty("confirmChanges");
    expect(await readOnly.get_connection({ connectionId })).not.toHaveProperty("changesConfirmation");
  });

  it("shows the mode beside what the plan says of changing data", async () => {
    const refusal = "Changing data is available on the Pro and Business plans.";
    application.db.close();
    setUp({ writes: { check: async () => ({ reason: "plan", message: refusal }), settingsUrl: (base, id) => `${base}/connections#${id}` } });
    const tools = createToolHandlers(application.mcpDependencies);

    expect(await tools.get_connection({ connectionId })).toMatchObject({ changingData: refusal, changesConfirmation: "required" });
    expect((await tools.get_connection({ connectionId }))).not.toHaveProperty("confirmChanges");
  });

  it("makes a write at once through request_change only when the person turned confirmation off, never by an argument", async () => {
    const client = await connect(application.mcpDependencies);
    const input = { connectionId, operationId: "set_price", args: { nmId: 123456789, price: 349 }, summary: "Цена 349 ₽" };

    const asked = await client.callTool({ name: "request_change", arguments: { ...input, changesConfirmation: "off" } }) as CallToolResult;
    if (asked.isError !== true) {
      expect(answerOf<{ status: string }>(asked).status).toBe("pending");
    }
    expect(sent).toEqual([]);
    expect(application.connections.getConnection(connectionId).confirmChanges).toBe(true);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(false);

    // With confirmation off, an operation the person never confirmed still comes as a link the first time.
    application.changes.setConfirmChanges(connectionId, false);
    const first = await client.callTool({ name: "request_change", arguments: input }) as CallToolResult;
    const linked = answerOf<{ status: string; changeId: string; notice: string; confirmation: { url: string } }>(first);
    expect(linked.status).toBe("pending");
    expect(linked.notice).toContain("the person has not yet confirmed this operation in its current form");
    expect(sent).toEqual([]);
    const token = new URL(linked.confirmation.url).searchParams.get("t") ?? "";
    expect(await application.changes.decide(linked.changeId, token, "run", 0)).toMatchObject({ record: { status: "succeeded" } });
    expect(sent).toHaveLength(1);

    const ran = await client.callTool({ name: "request_change", arguments: input }) as CallToolResult;
    expect(ran.isError).not.toBe(true);
    const result = answerOf<{ changeId: string }>(ran);
    expect(result).toMatchObject({ status: "succeeded", changesConfirmation: "off", result: { ok: true, status: 200 } });
    expect(result).not.toHaveProperty("confirmation");
    expect(sent).toHaveLength(2);

    const state = await client.callTool({ name: "get_change", arguments: { changeId: result.changeId } }) as CallToolResult;
    expect(state.structuredContent).toMatchObject({ result: { changeId: result.changeId, status: "succeeded", changesConfirmation: "off" } });
  });

  it("has no tool that changes the confirmation settings or the switch", async () => {
    const dir = new URL("../../src/mcp/", import.meta.url);
    const sources = readdirSync(dir).filter((name) => name.endsWith(".ts")).map((name) => readFileSync(new URL(name, dir), "utf8")).join("\n");
    expect(sources).toContain("createToolHandlers");
    for (const setter of ["setConfirmChanges", "setSkipConfirmationEverywhere", "setWrites", "setWritesEnabled"]) {
      expect(sources, setter).not.toContain(setter);
    }

    const client = await connect(application.mcpDependencies);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/confirm(Changes|ation)|changesConfirmation|skip|writes/iu);
    }
  });

  it("adds the host's facts about the product to the instructions, after the core's own", () => {
    const facts = "Plans: Free reads data; Pro and Business also change it.";
    expect(serverInstructions("APIUniCon", "cloud", facts).endsWith(` ${facts}`)).toBe(true);
    expect(serverInstructions("APIUniCon", "cloud")).toBe(serverInstructions("APIUniCon", "cloud", undefined));
  });

  it("says plainly when this process cannot change data", async () => {
    const { changes: _changes, ...withoutChanges } = application.mcpDependencies;
    const { onboarding: _onboarding, ...withoutOnboarding } = application.mcpDependencies;
    const input = { connectionId, operationId: "set_price", args: { nmId: 1, price: 2 }, summary: "Set the price" };

    for (const dependencies of [withoutChanges, withoutOnboarding]) {
      await expect(createToolHandlers(dependencies).request_change(input)).rejects.toThrow(
        "Changing data is not available in this process",
      );
    }
    await expect(createToolHandlers(withoutChanges).get_change({ changeId: connectionId })).rejects.toThrow(
      "Changing data is not available in this process",
    );
  });
});
