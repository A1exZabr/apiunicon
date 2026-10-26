import { afterEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import type { FetchImplementation } from "../../src/security/network-policy.js";
import { UsageLimitError, type UsageGate } from "../../src/usage/gate.js";
import { draftSetup } from "../helpers/setup.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 23),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const LINK = "https://docs.shop.test/docs/api";
const SPEC = "https://docs.shop.test/api/orders.yaml";
const SPEC_YAML = `openapi: 3.0.1
info: { title: Shop Orders }
servers: [{ url: "https://api.shop.test" }]
paths:
  /orders:
    get:
      operationId: listOrders
      summary: List recent orders
      responses: { "200": { description: ok } }
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Shop-Key }
`;
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [{ id: "list_orders", description: "List orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
};

function recordingGate(overrides: Partial<UsageGate> = {}): { gate: UsageGate; events: string[] } {
  const events: string[] = [];
  const gate: UsageGate = {
    beforeCall: async (context) => {
      events.push(`before:${context.mode}:${context.operationId}`);
      return {};
    },
    afterCall: async (context) => {
      events.push(`after:${context.mode}:${context.dispatched}`);
    },
    beforeDraft: async () => {
      events.push("draft");
    },
    beforeDocumentation: async () => {
      events.push("documentation");
    },
    afterDocumentation: async (bytes) => {
      events.push(`bytes:${bytes}`);
    },
    ...overrides,
  };
  return { gate, events };
}

describe("usage gate", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function connectedApplication(gate: UsageGate, fetchImpl: FetchImplementation, resolved = "8.8.8.8", appConfig: AppConfig = config): string {
    application = buildApplication(appConfig, { resolver: async () => [resolved], fetchImpl, usage: gate });
    const source = application.connections.createDocumentationSource({ rootUrl: LINK, allowedOrigin: "https://docs.shop.test" });
    application.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const adapter = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    application.adapters.markWorking(adapter.id, adapter.version);
    return application.connections.createConnection({
      label: "Shop",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1",
      adapterId: adapter.id,
    }).id;
  }

  it("counts a call that reached the API and passes the gate's notice on", async () => {
    const { gate, events } = recordingGate({
      beforeCall: async (context) => {
        events.push(`before:${context.mode}:${context.operationId}`);
        return { notice: "80% of this month's calls are used." };
      },
    });
    const connectionId = connectedApplication(gate, async () => new Response("{\"orders\":[]}", { status: 200 }));

    const result = await application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" });

    expect(result).toMatchObject({ ok: true, notice: "80% of this month's calls are used." });
    expect(events).toEqual(["before:call:list_orders", "after:call:true"]);
  });

  it("passes the gate's notice on when the call fails after it was sent", async () => {
    const notice = "80% of this month's calls are used.";
    const answers: Record<string, () => Promise<Response>> = {
      redirect: async () => new Response(null, { status: 302, headers: { location: "https://api.shop.test/elsewhere" } }),
      oversized: async () => new Response("x".repeat(config.maxResponseBytes + 1), { status: 200 }),
      timeout: async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    };
    for (const [kind, answer] of Object.entries(answers)) {
      const { gate, events } = recordingGate({ beforeCall: async () => ({ notice }) });
      const connectionId = connectedApplication(gate, answer);

      const error = await application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" })
        .catch((caught: unknown) => caught);

      expect((error as Error).message, kind).toMatch(/\S Notice: 80% of this month's calls are used\.$/u);
      expect(events, kind).toEqual(["after:call:true"]);
      // The notice is added to the message only, so the failure is still recorded under its own category.
      if (kind === "timeout") expect(application!.audits.recent(connectionId, 1)[0]?.errorCategory).toBe("timeout");
      application!.db.close();
      application = undefined;
    }
  });

  it("counts a call that the API answered with an error", async () => {
    const { gate, events } = recordingGate();
    const connectionId = connectedApplication(gate, async () => new Response("{}", { status: 500 }));

    const result = await application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "test" });

    expect(result.ok).toBe(false);
    expect(events).toEqual(["before:test:list_orders", "after:test:true"]);
  });

  it("refuses before sending anything when the gate says no", async () => {
    let fetched = 0;
    const { gate, events } = recordingGate({
      beforeCall: async () => {
        throw new UsageLimitError("This month's calls are used up.");
      },
    });
    const connectionId = connectedApplication(gate, async () => {
      fetched += 1;
      return new Response("{}");
    });

    await expect(application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" }))
      .rejects.toThrow("This month's calls are used up.");
    expect(fetched).toBe(0);
    expect(events).toEqual([]);
  });

  it("does not count a call the network policy stopped", async () => {
    const { gate, events } = recordingGate();
    const connectionId = connectedApplication(gate, async () => new Response("{}"), "10.0.0.7");

    await expect(application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" })).rejects.toThrow();
    expect(events).toEqual(["before:call:list_orders", "after:call:false"]);
  });

  it("counts a call the API answered with a redirect, although redirects are not followed", async () => {
    const { gate, events } = recordingGate();
    const connectionId = connectedApplication(gate, async () => new Response(null, {
      status: 302,
      headers: { location: "https://api.shop.test/elsewhere" },
    }));

    await expect(application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" }))
      .rejects.toThrow("Outbound redirects are disabled");
    expect(events).toEqual(["before:call:list_orders", "after:call:true"]);
  });

  it("counts a call whose response is too large to hand to the AI", async () => {
    const { gate, events } = recordingGate();
    const connectionId = connectedApplication(gate, async () => new Response("x".repeat(config.maxResponseBytes + 1), { status: 200 }));

    await expect(application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" }))
      .rejects.toThrow("larger than the");
    expect(events).toEqual(["before:call:list_orders", "after:call:true"]);
  });

  it("counts a call whose response is cut off at the upstream byte limit", async () => {
    const { gate, events } = recordingGate();
    const small: AppConfig = { ...config, maxResponseBytes: 1_000, maxUpstreamBytes: 1_000 };
    const connectionId = connectedApplication(gate, async () => new Response("x".repeat(1_001), { status: 200 }), "8.8.8.8", small);

    await expect(application!.runtime.execute({ connectionId, operationId: "list_orders", args: {}, mode: "call" }))
      .rejects.toThrow("byte limit");
    expect(events).toEqual(["before:call:list_orders", "after:call:true"]);
  });

  it("checks the daily draft allowance only for a new draft", async () => {
    const { gate, events } = recordingGate();
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("blocked", { status: 498 }),
      usage: gate,
    });
    const tools = createToolHandlers(application.mcpDependencies);

    draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    draftSetup(await tools.start_connection({ documentationUrl: LINK }));

    expect(events.filter((event) => event === "draft")).toHaveLength(1);
  });

  it("charges one draft when two calls start the same new link at once", async () => {
    const { gate, events } = recordingGate({
      beforeDraft: async () => {
        events.push("draft");
        await new Promise((resolve) => setImmediate(resolve));
      },
    });
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("blocked", { status: 498 }),
      usage: gate,
    });
    // Each MCP request gets its own handlers, so the two calls come from separate handler sets.
    const first = createToolHandlers(application.mcpDependencies);
    const second = createToolHandlers(application.mcpDependencies);

    const [a, b] = await Promise.all([
      first.start_connection({ documentationUrl: LINK }),
      second.start_connection({ documentationUrl: LINK }),
    ]);

    expect(draftSetup(a).draftId).toBe(draftSetup(b).draftId);
    expect(events.filter((event) => event === "draft")).toHaveLength(1);
    expect((application.db.prepare("select count(*) as n from connection_drafts").get() as { n: number }).n).toBe(1);
  });

  it("creates no draft when the draft allowance is used up", async () => {
    const { gate } = recordingGate({
      beforeDraft: async () => {
        throw new UsageLimitError("Too many new connections today.");
      },
    });
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response(""), usage: gate });
    const tools = createToolHandlers(application.mcpDependencies);

    await expect(tools.start_connection({ documentationUrl: LINK })).rejects.toThrow("Too many new connections today.");
    expect(application.discovery.findOpen(LINK)).toBeNull();
  });

  it("charges the bytes of documentation it stored", async () => {
    const { gate, events } = recordingGate();
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => input.toString() === SPEC
        ? new Response(SPEC_YAML, { status: 200, headers: { "content-type": "text/yaml" } })
        : new Response("blocked", { status: 498 }),
      usage: gate,
    });
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));

    await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });

    expect(events).toContain("documentation");
    expect(events).toContain(`bytes:${Buffer.byteLength(SPEC_YAML)}`);
  });

  function documentationApplication(gate: UsageGate, routes: Record<string, string>, appConfig: AppConfig = config) {
    const fetched: string[] = [];
    application = buildApplication(appConfig, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        fetched.push(input.toString());
        const body = routes[input.toString()];
        if (body === undefined) return new Response("missing", { status: 404 });
        return new Response(body, { status: 200, headers: { "content-type": body.startsWith("<") ? "text/html" : "text/yaml" } });
      },
      usage: gate,
    });
    return { tools: createToolHandlers(application.mcpDependencies), fetched };
  }

  it("charges every page the crawl downloads and every spec link it follows", async () => {
    const { gate, events } = recordingGate();
    const page = `<html><body><h1>Shop API</h1><p>${"Orders, products, and stock. ".repeat(12)}</p><a href="/api/orders.yaml">Spec</a></body></html>`;
    const { tools } = documentationApplication(gate, { [LINK]: page, [SPEC]: SPEC_YAML });

    draftSetup(await tools.start_connection({ documentationUrl: LINK }));

    // The crawl reads the spec as a page, then the intake downloads it again as a specification.
    const pageBytes = `bytes:${Buffer.byteLength(page)}`;
    const specBytes = `bytes:${Buffer.byteLength(SPEC_YAML)}`;
    expect(events).toEqual(["draft", "documentation", pageBytes, "documentation", specBytes, "documentation", specBytes]);
  });

  it("charges an attached file cut off at the per-document limit, and rejects it", async () => {
    const { gate, events } = recordingGate();
    const { tools } = documentationApplication(gate, { [SPEC]: "x".repeat(4_096) }, { ...config, maxDocumentBytes: 2_048 });
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    events.length = 0;

    const attached = await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });

    expect("results" in attached && attached.results).toEqual([{ url: SPEC, outcome: "rejected", reason: "too_large" }]);
    expect(events).toEqual(["documentation", "bytes:2048"]);
  });

  it("charges AI-supplied text over the document limit only up to that limit", async () => {
    const { gate, events } = recordingGate();
    application = buildApplication({ ...config, maxDocumentBytes: 2_048 }, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("blocked", { status: 498 }),
      usage: gate,
    });
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    events.length = 0;

    const attached = await tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: "https://docs.shop.test/big.txt", mediaType: "text", partIndex: 0, partCount: 1, text: "x".repeat(5_000) },
    });

    expect(attached).toMatchObject({ results: [{ outcome: "rejected", reason: "too_large" }] });
    expect(events).toEqual(["documentation", "bytes:2048"]);
  });

  it("charges a download that turns out to be a duplicate", async () => {
    const { gate, events } = recordingGate();
    const { tools } = documentationApplication(gate, { [SPEC]: SPEC_YAML });
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
    events.length = 0;

    const again = await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });

    expect("results" in again && again.results[0]?.outcome).toBe("duplicate");
    expect(events).toEqual(["documentation", `bytes:${Buffer.byteLength(SPEC_YAML)}`]);
  });

  it("downloads nothing once the documentation allowance is used up", async () => {
    const { gate, events } = recordingGate({
      beforeDocumentation: async () => {
        throw new UsageLimitError("Today's documentation allowance is used up.");
      },
    });
    const { tools, fetched } = documentationApplication(gate, { [LINK]: "<html></html>", [SPEC]: SPEC_YAML });

    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    const attached = await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });

    expect(started.stage).toBe("needs_documentation");
    expect("results" in attached && attached.results).toEqual([{ url: SPEC, outcome: "rejected", reason: "daily_limit" }]);
    expect(fetched).toEqual([]);
    expect(events).toEqual(["draft"]);
  });

  it("asks once for text sent in parts and charges it once when complete", async () => {
    const { gate, events } = recordingGate();
    const { tools } = documentationApplication(gate, {});
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    events.length = 0;
    const parts = [SPEC_YAML.slice(0, 120), SPEC_YAML.slice(120, 240), SPEC_YAML.slice(240)];
    const send = (partIndex: number) => tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: SPEC, mediaType: "openapi-yaml", partIndex, partCount: parts.length, text: parts[partIndex]! },
    });

    expect(await send(0)).toEqual({ received: 1, expected: 3 });
    expect(await send(1)).toEqual({ received: 2, expected: 3 });
    const done = await send(2);

    expect("results" in done && done.results[0]?.outcome).toBe("attached");
    expect(events).toEqual(["documentation", `bytes:${Buffer.byteLength(SPEC_YAML)}`]);
  });

  it("admits parts that arrive together as one document", async () => {
    let hold: Promise<void> | undefined;
    const { gate, events } = recordingGate({
      beforeDocumentation: async () => {
        events.push("documentation");
        await hold;
      },
    });
    const { tools } = documentationApplication(gate, {});
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    events.length = 0;
    let release = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parts = [SPEC_YAML.slice(0, 200), SPEC_YAML.slice(200)];
    const sending = parts.map((text, partIndex) => tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: SPEC, mediaType: "openapi-yaml", partIndex, partCount: parts.length, text },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    release();

    const answers = await Promise.all(sending);

    expect(answers.filter((answer) => "results" in answer)).toHaveLength(1);
    expect(events).toEqual(["documentation", `bytes:${Buffer.byteLength(SPEC_YAML)}`]);
    expect(application!.documents.list(application!.drafts.get(started.draftId).documentationSourceId)).toHaveLength(1);
  });

  it("refuses text sent in parts once the allowance is used up", async () => {
    let refuse = false;
    const { gate, events } = recordingGate({
      beforeDocumentation: async () => {
        if (refuse) throw new UsageLimitError("Today's documentation allowance is used up.");
        events.push("documentation");
      },
    });
    const { tools } = documentationApplication(gate, {});
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    refuse = true;
    events.length = 0;

    const answer = await tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: SPEC, mediaType: "openapi-yaml", partIndex: 0, partCount: 2, text: SPEC_YAML.slice(0, 200) },
    });

    expect("results" in answer && answer.results).toEqual([{ url: SPEC, outcome: "rejected", reason: "daily_limit" }]);
    expect(events).toEqual([]);
  });
});
