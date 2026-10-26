import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository, type AdapterRecord } from "../../src/adapters/repository.js";
import type { AdapterDsl } from "../../src/adapters/schema.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { DocsRepository } from "../../src/docs/repository.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { AdapterRuntime } from "../../src/runtime/runtime.js";
import { unlimitedUsage, type UsageGate } from "../../src/usage/gate.js";
import { Vault } from "../../src/vault/vault.js";
import { ran } from "../helpers/results.js";

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [{ id: "list_orders", description: "List orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
};
const ADVICE = "This adapter is private; offer it to the shared catalog to keep it.";

describe("advice when an adapter starts working", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let connectionId: string;
  let advised: AdapterRecord[];

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    const vault = new Vault(db, Buffer.alloc(32, 33));
    vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const source = connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    connectionId = connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "credentials-1",
    }).id;
    advised = [];
  });

  afterEach(() => db.close());

  function tools(options: { advise?: boolean; failingAdvice?: boolean; advice?: string; usage?: UsageGate } = {}) {
    const audits = new AuditRepository(db);
    const runtime = new AdapterRuntime({
      adapters,
      connections,
      vault: new Vault(db, Buffer.alloc(32, 33)),
      audits,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { "content-type": "application/json" } }),
      requestTimeoutMs: 1_000,
      maxResponseBytes: 4_096,
      usage: options.usage ?? unlimitedUsage,
    });
    return createToolHandlers({
      db, adapters, connections, docs: new DocsRepository(db), runtime, audits,
      ...(options.advise === false ? {} : {
        adviseOnWorkingAdapter: (adapter: AdapterRecord) => {
          advised.push(adapter);
          if (options.failingAdvice) throw new Error("catalog is unreachable");
          return options.advice ?? ADVICE;
        },
      }),
    });
  }

  it("adds the advice once, when an adapter built here first works", async () => {
    const handlers = tools();
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const first = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));
    const retest = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));
    const patched = await handlers.patch_adapter({ adapterId: adapter.id, expectedVersion: first.adapterVersion, dsl });
    const repaired = ran(await handlers.test_adapter_operation({ connectionId, adapterId: patched.id, operationId: "list_orders", args: {} }));

    expect(first).toMatchObject({ ok: true, notice: ADVICE });
    expect(advised.map(({ id, status }) => ({ id, status }))).toEqual([{ id: adapter.id, status: "working" }]);
    expect("notice" in retest).toBe(false);
    expect("notice" in repaired).toBe(false);
  });

  it("gives no advice for a copy from the catalog", async () => {
    const handlers = tools();
    const { documentationSourceId } = connections.getConnection(connectionId);
    const copy = adapters.createCatalogCopy({
      slug: "shop", displayName: "Shop", documentationSourceId, dsl, catalogEntryId: "entry-1", catalogVersion: 2,
    });
    connections.bindAdapter(connectionId, copy.id);
    // A copy that is not working yet, as one whose first test failed would be.
    db.prepare("update adapters set status = 'draft' where id = ?").run(copy.id);

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: copy.id, operationId: "list_orders", args: {} }));

    expect(tested.ok).toBe(true);
    expect(adapters.get(copy.id).status).toBe("working");
    expect(advised).toEqual([]);
    expect("notice" in tested).toBe(false);
  });

  it("advises on an edited copy of a catalog entry, which is the connection's own adapter", async () => {
    const handlers = tools();
    const { documentationSourceId } = connections.getConnection(connectionId);
    const copy = adapters.createCatalogCopy({
      slug: "shop", displayName: "Shop", documentationSourceId, dsl, catalogEntryId: "entry-1", catalogVersion: 2,
    });
    connections.bindAdapter(connectionId, copy.id);
    const edited = await handlers.patch_adapter({ adapterId: copy.id, expectedVersion: copy.version, dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: edited.id, operationId: "list_orders", args: {} }));

    expect(tested).toMatchObject({ ok: true, notice: ADVICE });
    expect(advised.map(({ id, catalogEntryId }) => ({ id, catalogEntryId }))).toEqual([{ id: edited.id, catalogEntryId: null }]);
  });

  it("keeps the usage notice and adds the advice after it", async () => {
    const handlers = tools({ usage: { ...unlimitedUsage, beforeCall: async () => ({ notice: "Most of this month's calls are used." }) } });
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));

    expect(tested).toMatchObject({ notice: `Most of this month's calls are used. ${ADVICE}` });
  });

  it("still returns the test result when the host's advice fails", async () => {
    const handlers = tools({ failingAdvice: true });
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));

    expect(tested).toMatchObject({ ok: true, status: 200, adapterVersion: adapter.version + 1 });
    expect("notice" in tested).toBe(false);
    expect(advised).toHaveLength(1);
    expect(adapters.get(adapter.id)).toMatchObject({ status: "working", version: adapter.version + 1 });
  });

  it.each([["an empty", ""], ["a blank", "  \n "]])("treats %s answer as no advice", async (_case, blank) => {
    const handlers = tools({ advice: blank, usage: { ...unlimitedUsage, beforeCall: async () => ({ notice: "Most of this month's calls are used." }) } });
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));

    expect(tested).toMatchObject({ ok: true, notice: "Most of this month's calls are used." });
    expect(advised).toHaveLength(1);
  });

  it("treats an empty answer without a usage notice as no notice at all", async () => {
    const handlers = tools({ advice: "" });
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));

    expect(tested.ok).toBe(true);
    expect("notice" in tested).toBe(false);
  });

  it("adds nothing when the host gives no advice", async () => {
    const handlers = tools({ advise: false });
    const adapter = await handlers.create_adapter({ connectionId, slug: "shop", displayName: "Shop", dsl });

    const tested = ran(await handlers.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));

    expect(tested.ok).toBe(true);
    expect("notice" in tested).toBe(false);
  });
});
