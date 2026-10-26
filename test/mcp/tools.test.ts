import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository } from "../../src/adapters/repository.js";
import type { AdapterDsl } from "../../src/adapters/schema.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { DocsRepository } from "../../src/docs/repository.js";
import { createToolHandlers, type ToolName } from "../../src/mcp/tools.js";
import { AdapterRuntime } from "../../src/runtime/runtime.js";
import { Vault } from "../../src/vault/vault.js";
import { ran } from "../helpers/results.js";

const draftDsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.example.test"],
  credentialBindings: [
    { fieldName: "Api-Key", target: "header", headerName: "Api-Key" },
  ],
  operations: [
    {
      id: "list_orders",
      description: "List recent orders",
      risk: "read",
      method: "GET",
      path: "/orders",
      input: {},
      documentationRefs: ["orders-doc"],
    },
  ],
};

describe("stable MCP tool workflow", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let docs: DocsRepository;
  let vault: Vault;
  let audits: AuditRepository;
  let calls: ToolName[];
  let connectionId: string;
  let upstreamCall: number;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    docs = new DocsRepository(db);
    vault = new Vault(db, Buffer.alloc(32, 5));
    audits = new AuditRepository(db);
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    docs.replaceSourceChunks(
      source.id,
      [
        {
          id: "orders-doc",
          pageUrl: "https://docs.example.test/orders.html",
          heading: "Orders",
          body: "GET /orders lists recent orders. Authenticate with the Api-Key header.",
          contentHash: "orders-hash",
        },
      ],
      "docs-fingerprint",
    );
    vault.storeFields("credentials-1", { "Api-Key": "first-secret" });
    connectionId = connections.createConnection({
      label: "First connection",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-1",
    }).id;
    calls = [];
    upstreamCall = 0;
  });

  afterEach(() => db.close());

  function buildTools() {
    const runtime = new AdapterRuntime({
      adapters,
      connections,
      vault,
      audits,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        upstreamCall += 1;
        return upstreamCall === 1
          ? new Response(JSON.stringify({ error: "documented path was stale" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify({ orders: [{ id: "order-1" }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      },
      requestTimeoutMs: 1_000,
      maxResponseBytes: 4_096,
    });
    return createToolHandlers({
      db,
      adapters,
      connections,
      docs,
      runtime,
      audits,
      onToolCall: (name) => calls.push(name),
    });
  }

  it("persists a failed test, a repaired adapter, learning, and a successful checkpoint", async () => {
    const tools = buildTools();
    const connection = await tools.get_connection({ connectionId });
    expect(connection.credentials).toEqual([{ fieldName: "Api-Key", configured: true }]);
    expect(JSON.stringify(connection)).not.toContain("first-secret");

    const matches = await tools.search_docs({ connectionId, query: "orders list", limit: 5 });
    expect(matches[0]?.id).toBe("orders-doc");

    const draft = await tools.create_adapter({
      connectionId,
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      dsl: draftDsl,
    });
    const failed = ran(await tools.test_adapter_operation({
      connectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    expect(failed.ok).toBe(false);

    const correctedDsl: AdapterDsl = {
      ...draftDsl,
      operations: [{ ...draftDsl.operations[0]!, description: "List orders using the current endpoint" }],
    };
    const patched = await tools.patch_adapter({
      adapterId: draft.id,
      expectedVersion: draft.version,
      dsl: correctedDsl,
    });
    await tools.record_learning({
      adapterId: draft.id,
      operationId: "list_orders",
      kind: "behavior",
      finding: { oldBehavior: "400", currentBehavior: "200 after repair" },
      evidence: { docsRef: "orders-doc", testRun: "second" },
    });
    const passed = ran(await tools.test_adapter_operation({
      connectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    expect(passed.ok).toBe(true);

    const state = await tools.get_adapter_state({ adapterId: draft.id });
    expect(state).toMatchObject({
      status: "working",
      visibility: "private",
      knowledgeEventCount: 1,
    });
    expect(state.version).toBeGreaterThan(patched.version);
    expect(state.testOutcomes.map(({ outcome }) => outcome)).toEqual(["failure", "success"]);
  });

  it("keeps the version of a working adapter when it is tested again", async () => {
    const tools = buildTools();
    const draft = await tools.create_adapter({ connectionId, slug: "fixture-orders", displayName: "Fixture Orders", dsl: draftDsl });
    const test = async () => ran(await tools.test_adapter_operation({ connectionId, adapterId: draft.id, operationId: "list_orders", args: {} }));
    await test();
    const working = await test();
    const again = await test();

    expect(again.ok).toBe(true);
    expect(again.adapterVersion).toBe(working.adapterVersion);
    expect(adapters.get(draft.id)).toMatchObject({ status: "working", version: working.adapterVersion });
  });

  it("returns every parallel test result even when another test marked the adapter working first", async () => {
    const tools = buildTools();
    const draft = await tools.create_adapter({ connectionId, slug: "fixture-orders", displayName: "Fixture Orders", dsl: draftDsl });
    const test = async () => ran(await tools.test_adapter_operation({ connectionId, adapterId: draft.id, operationId: "list_orders", args: {} }));
    await test();

    const results = await Promise.all([test(), test(), test()]);

    expect(results.map(({ ok }) => ok)).toEqual([true, true, true]);
    expect(adapters.get(draft.id)).toMatchObject({ status: "working", version: draft.version + 1 });
    expect(results.every(({ adapterVersion }) => adapterVersion === draft.version + 1)).toBe(true);
  });

  it("reuses a working adapter for a second connection without docs or mutations", async () => {
    const tools = buildTools();
    const draft = await tools.create_adapter({
      connectionId,
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      dsl: draftDsl,
    });
    ran(await tools.test_adapter_operation({
      connectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    const passed = ran(await tools.test_adapter_operation({
      connectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    const requested = await tools.mark_adapter_reusable({
      adapterId: draft.id,
      expectedVersion: passed.adapterVersion,
    });
    expect(requested).toMatchObject({
      confirmationRequired: true,
      reviewPath: `/adapters/${draft.id}`,
    });
    expect(adapters.get(draft.id).visibility).toBe("private");
    const reusable = adapters.markReusable(draft.id, passed.adapterVersion);

    const sourceId = connections.getConnection(connectionId).documentationSourceId;
    vault.storeFields("credentials-2", { "Api-Key": "second-secret" });
    const second = connections.createConnection({
      label: "Second connection",
      documentationSourceId: sourceId,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-2",
    });

    calls = [];
    const found = await tools.search_adapters({ query: "fixture" });
    expect(found[0]?.id).toBe(reusable.id);
    await tools.get_adapter({ adapterId: reusable.id });
    await tools.bind_adapter({ connectionId: second.id, adapterId: reusable.id });
    const result = ran(await tools.call_adapter({
      connectionId: second.id,
      operationId: "list_orders",
      args: {},
    }));

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["search_adapters", "get_adapter", "bind_adapter", "call_adapter"]);
    expect(calls).not.toEqual(
      expect.arrayContaining(["search_docs", "create_adapter", "patch_adapter"]),
    );
    expect(adapters.get(reusable.id).version).toBe(reusable.version);
  });

  it("replaces the connection's own private adapter instead of leaving it behind", async () => {
    const tools = buildTools();
    const first = await tools.create_adapter({ connectionId, slug: "fixture-orders", displayName: "Fixture Orders", dsl: draftDsl });

    const second = await tools.create_adapter({ connectionId, slug: "fixture-orders", displayName: "Fixture Orders v2", dsl: draftDsl });

    expect(connections.getConnection(connectionId).adapterId).toBe(second.id);
    expect(() => adapters.get(first.id)).toThrow(/not found/u);
  });

  it("keeps a replaced adapter that is reusable or still serves another connection", async () => {
    const tools = buildTools();
    const reusable = await tools.create_adapter({ connectionId, slug: "fixture-reusable", displayName: "Reusable", dsl: draftDsl });
    const working = adapters.markWorking(reusable.id, reusable.version);
    adapters.markReusable(reusable.id, working.version);
    await tools.create_adapter({ connectionId, slug: "fixture-next", displayName: "Next", dsl: draftDsl });
    expect(adapters.get(reusable.id).id).toBe(reusable.id);

    const shared = await tools.create_adapter({ connectionId, slug: "fixture-shared", displayName: "Shared", dsl: draftDsl });
    vault.storeFields("credentials-2", { "Api-Key": "second-secret" });
    connections.createConnection({
      label: "Second",
      documentationSourceId: connections.getConnection(connectionId).documentationSourceId,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-2",
      adapterId: shared.id,
    });
    await tools.create_adapter({ connectionId, slug: "fixture-last", displayName: "Last", dsl: draftDsl });
    expect(adapters.get(shared.id).id).toBe(shared.id);
  });

  it("erases the connection's own private adapter when a reusable one is bound instead", async () => {
    const tools = buildTools();
    const draft = await tools.create_adapter({ connectionId, slug: "fixture-reusable", displayName: "Reusable", dsl: draftDsl });
    const reusable = adapters.markReusable(draft.id, adapters.markWorking(draft.id, draft.version).version);
    vault.storeFields("credentials-2", { "Api-Key": "second-secret" });
    const second = connections.createConnection({
      label: "Second",
      documentationSourceId: connections.getConnection(connectionId).documentationSourceId,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-2",
    });
    const own = await tools.create_adapter({ connectionId: second.id, slug: "fixture-own", displayName: "Own", dsl: draftDsl });

    await tools.bind_adapter({ connectionId: second.id, adapterId: reusable.id });

    expect(connections.getConnection(second.id).adapterId).toBe(reusable.id);
    expect(() => adapters.get(own.id)).toThrow(/not found/u);

    await tools.bind_adapter({ connectionId: second.id, adapterId: reusable.id });

    expect(connections.getConnection(second.id).adapterId).toBe(reusable.id);
    expect(adapters.get(reusable.id).visibility).toBe("reusable");
  });

  it("keeps a private adapter that is bound again to its own connection", async () => {
    const tools = buildTools();
    const own = await tools.create_adapter({ connectionId, slug: "fixture-own", displayName: "Own", dsl: draftDsl });

    connections.replaceAdapter(connectionId, own.id);

    expect(connections.getConnection(connectionId).adapterId).toBe(own.id);
    expect(adapters.get(own.id).id).toBe(own.id);
  });

  it("keeps the old adapter bound when the new one cannot be created", async () => {
    const tools = buildTools();
    const first = await tools.create_adapter({ connectionId, slug: "fixture-orders", displayName: "Fixture Orders", dsl: draftDsl });
    const source = connections.createDocumentationSource({ rootUrl: "https://docs.example.test/other", allowedOrigin: "https://docs.example.test" });
    adapters.create({ slug: "taken-elsewhere", displayName: "Other", documentationSourceId: source.id, dsl: draftDsl });

    await expect(tools.create_adapter({ connectionId, slug: "taken-elsewhere", displayName: "Clash", dsl: draftDsl })).rejects.toThrow();

    expect(connections.getConnection(connectionId).adapterId).toBe(first.id);
    expect(adapters.get(first.id).id).toBe(first.id);
  });
});
