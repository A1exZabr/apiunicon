import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl, AdapterOperation } from "../../src/adapters/schema.js";
import type { CatalogSource } from "../../src/catalog/source.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createMcpServer, type ToolResultEvent } from "../../src/mcp/server.js";
import { awaitsReadApproval, createToolHandlers, type ReadApprovalRequired } from "../../src/mcp/tools.js";
import { WB_ENTRY_ID, WB_LINK, wbEntry } from "../fixtures/catalog.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 46),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const ORIGIN = "https://api.shop.test";

const read = (overrides: Partial<AdapterOperation> & Pick<AdapterOperation, "id">): AdapterOperation => ({
  description: "List orders", risk: "read", method: "POST", path: "/orders/list", input: {}, documentationRefs: [], ...overrides,
});

// The way Ozon and Wildberries read: through POST. And a GET read beside it.
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [
    read({ id: "list_orders" }),
    read({ id: "get_stock", description: "Stock left", method: "GET", path: "/stock" }),
  ],
};

type Sent = { method: string; url: string };

describe("reads sent with POST through the assistant's tools", () => {
  let application: Application;
  let sent: Sent[];
  let connectionId: string;

  function build(catalog?: CatalogSource): Application {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push({ method: init?.method ?? "GET", url: input.toString() });
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      ...(catalog ? { catalog } : {}),
    });
    return application;
  }

  function connection(label = "Shop"): string {
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    const keys = `keys-${label}`;
    application.vault.storeFields(keys, { "X-Shop-Key": "shop-secret" });
    return application.connections.createConnection({
      label, documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: keys,
    }).id;
  }

  // The person's click on the page the link opens, through the same service the page calls.
  function approveFrom(url: string): void {
    const target = new URL(url);
    const id = target.pathname.split("/").at(-1)!;
    const token = target.searchParams.get("t")!;
    const view = application.readApprovals.open(id, token)!;
    expect(application.readApprovals.approve(id, token, view.fingerprint).kind).toBe("approved");
  }

  function refusal(result: object): ReadApprovalRequired {
    if (!awaitsReadApproval(result)) throw new Error("Expected a refusal for approval");
    return result;
  }

  beforeEach(() => {
    build();
    connectionId = connection();
  });

  afterEach(() => application.db.close());

  it("refuses an unapproved read sent with POST with a link, even with changing data on and confirmation off, and runs it once approved", async () => {
    const tools = createToolHandlers(application.mcpDependencies);
    application.changes.setWrites(connectionId, true);
    application.changes.setConfirmChanges(connectionId, false);
    application.changes.setSkipConfirmationEverywhere(true);
    const adapter = await tools.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = refusal(await tools.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));
    expect(tested).toMatchObject({ status: "approval_required", operationId: "list_orders", readApproval: { connectionId, operationIds: ["list_orders"] } });
    expect(tested.readApproval.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:3210/confirm/reads/${connectionId}\\?t=[A-Za-z0-9_-]{43}$`, "u"));
    expect(tested.nextStep).toContain(`If it only reads, show the person this link: ${tested.readApproval.url} .`);
    expect(tested.nextStep).toContain("call test_adapter_operation again with the same arguments");
    expect(tested.nextStep).toContain("label it write or destructive with patch_adapter and use request_change");
    // Nothing was sent, so nothing is recorded as a test.
    expect(application.db.prepare("select count(*) as n from adapter_test_outcomes").get()).toEqual({ n: 0 });
    // A GET read runs as before, and makes the draft work.
    expect(await tools.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "get_stock", args: {} })).toMatchObject({ ok: true });
    const called = refusal(await tools.call_adapter({ connectionId, operationId: "list_orders", args: {} }));
    expect(called.nextStep).toContain("call call_adapter again with the same arguments");
    expect(sent).toEqual([{ method: "GET", url: `${ORIGIN}/stock` }]);

    approveFrom(called.readApproval.url);
    expect(await tools.call_adapter({ connectionId, operationId: "list_orders", args: {} })).toMatchObject({ ok: true, status: 200 });
    expect(await tools.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }))
      .toMatchObject({ ok: true });
    expect(sent.map(({ method }) => method)).toEqual(["GET", "POST", "POST"]);
  });

  it("gives the link with a new adapter, counts what waits on the connection, and asks again after a patch of that read", async () => {
    const tools = createToolHandlers(application.mcpDependencies);
    const plain = await tools.create_adapter({ connectionId, slug: "plain", displayName: "Plain", dsl: { ...dsl, operations: [dsl.operations[1]!] } });
    expect(plain).not.toHaveProperty("readApprovals");
    expect(plain).not.toHaveProperty("nextStep");
    expect(await tools.get_connection({ connectionId })).not.toHaveProperty("readsAwaitingApproval");

    const created = await tools.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });
    expect(created).toMatchObject({ slug: "shop", readApprovals: [{ connectionId, operationIds: ["list_orders"] }] });
    if (!("readApprovals" in created)) throw new Error("Expected approval links");
    expect(created.nextStep).toContain(`Reads sent with POST in this adapter wait for the person's approval: list_orders.`);
    expect(created.nextStep).toContain(`show the person this link: ${created.readApprovals[0]!.url} .`);
    expect(await tools.get_connection({ connectionId })).toMatchObject({ readsAwaitingApproval: 1 });
    expect((await tools.list_connections({})).map((item) => item.readsAwaitingApproval)).toEqual([1]);

    approveFrom(created.readApprovals[0]!.url);
    expect(await tools.get_connection({ connectionId })).not.toHaveProperty("readsAwaitingApproval");
    expect(await tools.test_adapter_operation({ connectionId, adapterId: created.id, operationId: "list_orders", args: {} })).toMatchObject({ ok: true });

    // A patch that leaves the read as it was keeps its approval.
    const stockOnly = await tools.patch_adapter({
      adapterId: created.id, expectedVersion: application.adapters.get(created.id).version,
      dsl: { ...dsl, operations: [dsl.operations[0]!, { ...dsl.operations[1]!, description: "Stock left in every warehouse" }] },
    });
    expect(stockOnly).not.toHaveProperty("readApprovals");
    expect(await tools.test_adapter_operation({ connectionId, adapterId: created.id, operationId: "list_orders", args: {} })).toMatchObject({ ok: true });

    // A patch of the read itself waits for the person again, with a new link in the patch's result.
    const patched = await tools.patch_adapter({
      adapterId: created.id, expectedVersion: application.adapters.get(created.id).version,
      dsl: { ...dsl, operations: [{ ...dsl.operations[0]!, path: "/orders/archive" }, dsl.operations[1]!] },
    });
    expect(patched).toMatchObject({ readApprovals: [{ connectionId, operationIds: ["list_orders"] }] });
    expect(refusal(await tools.test_adapter_operation({ connectionId, adapterId: created.id, operationId: "list_orders", args: {} })).status)
      .toBe("approval_required");
    expect(sent.filter(({ url }) => url.endsWith("/orders/archive"))).toEqual([]);
  });

  it("does not carry one connection's approval to another bound to the same adapter", async () => {
    const tools = createToolHandlers(application.mcpDependencies);
    const created = await tools.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });
    if (!("readApprovals" in created)) throw new Error("Expected approval links");
    approveFrom(created.readApprovals[0]!.url);
    expect(await tools.test_adapter_operation({ connectionId, adapterId: created.id, operationId: "get_stock", args: {} })).toMatchObject({ ok: true });
    const working = application.adapters.get(created.id);
    application.adapters.markReusable(working.id, working.version);
    const second = connection("Shop 2");

    const bound = await tools.bind_adapter({ connectionId: second, adapterId: created.id });
    expect(bound).toMatchObject({ id: second, readsAwaitingApproval: 1, readApprovals: [{ connectionId: second, operationIds: ["list_orders"] }] });
    expect(refusal(await tools.call_adapter({ connectionId: second, operationId: "list_orders", args: {} })).readApproval.connectionId).toBe(second);
    expect(await tools.call_adapter({ connectionId, operationId: "list_orders", args: {} })).toMatchObject({ ok: true });
    expect(sent.map(({ method }) => method)).toEqual(["GET", "POST"]);
  });

  it("runs the catalog's unchanged reads at once and asks for an edited one", async () => {
    const entry = wbEntry({
      dsl: {
        ...wbEntry().dsl,
        operations: [
          wbEntry().dsl.operations[0]!,
          { id: "report_detail", description: "Detailed report", risk: "read", method: "POST", path: "/api/v5/report", input: {}, documentationRefs: [] },
          { id: "report_stock", description: "Stock report", risk: "read", method: "POST", path: "/api/v5/stock", input: {}, documentationRefs: [] },
        ],
      },
    });
    application.db.close();
    build({ lookup: async () => ({ kind: "entry", entry }), entry: async () => ({ kind: "entry", entry }) });
    const tools = createToolHandlers(application.mcpDependencies);
    const draft = application.discovery.startFromCatalog(WB_LINK, entry);
    const copy = application.adapters.findCatalogCopy(draft.documentationSourceId, WB_ENTRY_ID)!;
    const catalogConnection = application.discovery.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "wb-token" },
    }).id;

    expect(await tools.get_connection({ connectionId: catalogConnection })).not.toHaveProperty("readsAwaitingApproval");
    expect(await tools.call_adapter({ connectionId: catalogConnection, operationId: "report_detail", args: {} })).toMatchObject({ ok: true });
    expect(application.db.prepare("select distinct source from read_approvals where connection_id = ?").all(catalogConnection))
      .toEqual([{ source: "catalog" }]);
    expect(await tools.test_adapter_operation({ connectionId: catalogConnection, adapterId: copy.id, operationId: "report_stock", args: {} }))
      .toMatchObject({ ok: true });
    await tools.record_learning({
      adapterId: copy.id, operationId: "report_stock", kind: "behavior", finding: { note: "One row per warehouse" }, evidence: { status: 200 },
    });

    const edited = await tools.patch_adapter({
      adapterId: copy.id, expectedVersion: copy.version,
      dsl: { ...entry.dsl, operations: entry.dsl.operations.map((item) => (item.id === "report_detail" ? { ...item, description: "Detailed report, then reset it" } : item)) },
    });
    // The copy serves this connection alone, so it is changed in place and is no longer a copy of the entry. Its
    // unchanged reads keep the catalog's approval for this connection, the edited one waits.
    expect(edited).toMatchObject({
      id: copy.id, version: copy.version + 1, catalogEntryId: null, catalogVersion: null, visibility: "private", status: "draft",
      readApprovals: [{ connectionId: catalogConnection, operationIds: ["report_detail"] }],
    });
    expect(edited).not.toHaveProperty("copiedFrom");
    if (!("nextStep" in edited)) throw new Error("Expected a next step");
    expect(edited.nextStep).toContain(
      `Adapter ${copy.id} was a copy of a shared catalog entry that only this connection uses, so it was changed in place: it is now version 2, this connection's own adapter and no longer a copy of the entry, and a draft until a test passes.`,
    );
    expect(edited.nextStep).toContain("wait for the person's approval: report_detail.");
    expect(application.adapters.get(copy.id)).toMatchObject({ catalogEntryId: null, catalogVersion: null, version: 2 });
    expect(application.connections.getConnection(catalogConnection).adapterId).toBe(copy.id);
    // Nothing of the adapter's history went with the edit: the call and the test before it, and what was learned.
    expect(application.audits.recent(catalogConnection, 10).map(({ operationId }) => operationId)).toEqual(["report_stock", "report_detail"]);
    expect(await tools.get_adapter_state({ adapterId: copy.id })).toMatchObject({
      knowledgeEventCount: 1, testOutcomes: [{ operationId: "report_stock", adapterVersion: 1, outcome: "success" }],
    });
    expect(refusal(await tools.test_adapter_operation({
      connectionId: catalogConnection, adapterId: copy.id, operationId: "report_detail", args: {},
    })).operationId).toBe("report_detail");
    expect(await tools.test_adapter_operation({ connectionId: catalogConnection, adapterId: copy.id, operationId: "report_stock", args: {} }))
      .toMatchObject({ ok: true });
    expect(sent.map(({ url }) => new URL(url).pathname)).toEqual(["/api/v5/report", "/api/v5/stock", "/api/v5/stock"]);
  });

  it("answers the refusal over MCP as a result, so the link's token stays out of the host's records of failed calls", async () => {
    const events: ToolResultEvent[] = [];
    const tools = createToolHandlers(application.mcpDependencies);
    const adapter = await tools.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });
    await tools.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "get_stock", args: {} });
    sent.length = 0;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(application.mcpDependencies, { onToolResult: (event) => events.push(event) }).connect(serverSide);
    const client = new Client({ name: "read-approvals-test", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const answer = await client.callTool({ name: "call_adapter", arguments: { connectionId, operationId: "list_orders", args: {} } });

      expect(answer.isError).toBeFalsy();
      const result = (answer.structuredContent as { result: ReadApprovalRequired }).result;
      expect(result.status).toBe("approval_required");
      const [text] = answer.content as Array<{ type: string; text: string }>;
      expect(text?.text).toContain(result.readApproval.url);
      expect(events).toMatchObject([{ tool: "call_adapter", ok: true, kind: null, detail: null, connectionId, operationId: "list_orders" }]);
      expect(sent).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
