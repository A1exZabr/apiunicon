import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { VersionConflictError } from "../../src/adapters/repository.js";
import type { AdapterDsl, AdapterOperation } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { awaitsReadApproval, createToolHandlers } from "../../src/mcp/tools.js";
import { ran } from "../helpers/results.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 54),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768, requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const ORIGIN = "https://api.shop.test";

const operation = (overrides: Partial<AdapterOperation> & Pick<AdapterOperation, "id">): AdapterOperation => ({
  description: "Stock left", risk: "read", method: "GET", path: "/stock", input: {}, documentationRefs: [], ...overrides,
});
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [operation({ id: "get_stock" }), operation({ id: "list_orders", description: "List orders", method: "POST", path: "/orders/list" })],
};
const edit = (description: string): AdapterDsl => ({
  ...dsl,
  operations: [operation({ id: "get_stock", description }), dsl.operations[1]!],
});

describe("patch_adapter on an adapter connections rely on", () => {
  let application: Application;
  let sent: string[];

  beforeEach(() => {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        sent.push(input.toString());
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
  });

  afterEach(() => application.db.close());

  const tools = () => createToolHandlers(application.mcpDependencies);

  function connection(label: string): string {
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    application.vault.storeFields(`keys-${label}`, { "X-Shop-Key": "shop-secret" });
    return application.connections.createConnection({
      label, documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: `keys-${label}`,
    }).id;
  }

  // A reviewed reusable adapter, working, bound to the connections given; the person approved its read sent with POST
  // on each of them.
  async function reusable(connectionIds: string[]): Promise<string> {
    const [first, ...others] = connectionIds;
    const created = await tools().create_adapter({ connectionId: first!, slug: "shop", displayName: "Shop", dsl });
    ran(await tools().test_adapter_operation({ connectionId: first!, adapterId: created.id, operationId: "get_stock", args: {} }));
    const working = application.adapters.get(created.id);
    application.adapters.markReusable(working.id, working.version);
    for (const id of others) await tools().bind_adapter({ connectionId: id, adapterId: created.id });
    for (const id of connectionIds) {
      const link = application.readApprovals.link(id, "http://127.0.0.1:3210")!;
      const token = new URL(link.url).searchParams.get("t")!;
      application.readApprovals.approve(id, token, application.readApprovals.open(id, token)!.fingerprint);
    }
    return created.id;
  }

  it("gives the named connection a private copy and leaves the reviewed adapter to the others, working as before", async () => {
    const [first, second] = [connection("Shop"), connection("Shop 2")];
    const adapterId = await reusable([first, second]);
    const before = application.adapters.get(adapterId);

    const patched = await tools().patch_adapter({ adapterId, expectedVersion: before.version, dsl: edit("Stock, every warehouse"), connectionId: second });

    expect(patched).toMatchObject({
      copiedFrom: adapterId, visibility: "private", status: "draft", version: 1, catalogEntryId: null, displayName: "Shop", slug: "shop-2",
    });
    expect(patched.id).not.toBe(adapterId);
    expect(patched.dsl.operations[0]!.description).toBe("Stock, every warehouse");
    expect("nextStep" in patched && patched.nextStep).toContain(
      `Adapter ${adapterId} is reusable, so it was not changed. This connection now uses a private copy with your changes: adapter ${patched.id}, version 1, a draft until a test passes. Use this adapterId from now on. Every other connection keeps using it as it was.`,
    );
    expect(application.adapters.get(adapterId)).toEqual(before);
    expect(application.connections.getConnection(first).adapterId).toBe(adapterId);
    expect(application.connections.getConnection(second).adapterId).toBe(patched.id);

    // The first connection calls the reviewed version at once, the reads approved on it included.
    expect(await tools().call_adapter({ connectionId: first, operationId: "list_orders", args: {} })).toMatchObject({ ok: true });
    // The second runs its copy once a test passes; its read sent with POST did not change, so it keeps its approval.
    await expect(tools().call_adapter({ connectionId: second, operationId: "get_stock", args: {} })).rejects.toThrow(/must be working/u);
    expect(await tools().test_adapter_operation({ connectionId: second, adapterId: patched.id, operationId: "list_orders", args: {} }))
      .toMatchObject({ ok: true });
    expect(application.adapters.get(patched.id).status).toBe("working");
    expect(application.adapters.findReusableForDocumentation("https://docs.shop.test/api")?.id).toBe(adapterId);
  });

  it("asks which connection when several use it, and changes nothing until told", async () => {
    const [first, second] = [connection("Shop"), connection("Shop 2")];
    const adapterId = await reusable([first, second]);
    const before = application.adapters.get(adapterId);

    await expect(tools().patch_adapter({ adapterId, expectedVersion: before.version, dsl: edit("x") }))
      .rejects.toThrow(`Adapter ${adapterId} serves 2 connections and is not changed in place. Pass connectionId`);
    await expect(tools().patch_adapter({ adapterId, expectedVersion: before.version, dsl: edit("x"), connectionId: connection("Other") }))
      .rejects.toThrow("Connection is not bound to the requested adapter");
    await expect(tools().patch_adapter({ adapterId, expectedVersion: before.version - 1, dsl: edit("x"), connectionId: first }))
      .rejects.toBeInstanceOf(VersionConflictError);
    expect(application.adapters.get(adapterId)).toEqual(before);
    expect([first, second].map((id) => application.connections.getConnection(id).adapterId)).toEqual([adapterId, adapterId]);
  });

  it("copies a reusable adapter that one connection uses without being named, and refuses one that none uses", async () => {
    const only = connection("Shop");
    const adapterId = await reusable([only]);
    const patched = await tools().patch_adapter({ adapterId, expectedVersion: application.adapters.get(adapterId).version, dsl: edit("y") });
    expect(patched).toMatchObject({ copiedFrom: adapterId });
    // The reviewed adapter stays for the next connection to the same service.
    expect(application.adapters.get(adapterId)).toMatchObject({ visibility: "reusable", status: "working" });
    expect(application.connections.getConnection(only).adapterId).toBe(patched.id);

    await expect(tools().patch_adapter({ adapterId, expectedVersion: application.adapters.get(adapterId).version, dsl: edit("z") }))
      .rejects.toThrow(`No connection uses adapter ${adapterId}, so it is not changed.`);
  });

  it("keeps the original and the connection's history when it gives the connection a copy, which starts with what was learned", async () => {
    const only = connection("Shop");
    const adapterId = await reusable([only]);
    ran(await tools().call_adapter({ connectionId: only, operationId: "get_stock", args: {} }));
    await tools().record_learning({ adapterId, operationId: "get_stock", kind: "pagination", finding: { pageSize: 100 }, evidence: { status: 200 } });
    const before = await tools().get_adapter_state({ adapterId });
    expect(before).toMatchObject({ knowledgeEventCount: 1, testOutcomes: [{ operationId: "get_stock", outcome: "success" }] });

    const patched = await tools().patch_adapter({ adapterId, expectedVersion: application.adapters.get(adapterId).version, dsl: edit("v") });

    expect(patched).toMatchObject({ copiedFrom: adapterId });
    expect(application.adapters.get(adapterId)).toMatchObject({ visibility: "reusable", status: "working" });
    expect(await tools().get_adapter_state({ adapterId })).toEqual(before);
    expect(await tools().get_adapter_state({ adapterId: patched.id })).toMatchObject({ knowledgeEventCount: 1, testOutcomes: [] });
    expect(application.db.prepare("select operation_id, kind, finding_json from knowledge_events where adapter_id = ?").all(patched.id))
      .toEqual([{ operation_id: "get_stock", kind: "pagination", finding_json: JSON.stringify({ pageSize: 100 }) }]);
    // The connection's journal keeps the calls made through the original.
    expect(application.audits.recent(only, 10).map((audit) => [audit.adapterId, audit.operationId])).toEqual([
      [adapterId, "get_stock"],
      [adapterId, "get_stock"],
    ]);
  });

  it("asks for approval only of the reads the copy changed", async () => {
    const [first, second] = [connection("Shop"), connection("Shop 2")];
    const adapterId = await reusable([first, second]);
    const changedRead: AdapterDsl = { ...dsl, operations: [dsl.operations[0]!, { ...dsl.operations[1]!, path: "/orders/archive" }] };

    const patched = await tools().patch_adapter({ adapterId, expectedVersion: application.adapters.get(adapterId).version, dsl: changedRead, connectionId: first });

    expect(patched).toMatchObject({ readApprovals: [{ connectionId: first, operationIds: ["list_orders"] }] });
    if (!("readApprovals" in patched)) throw new Error("Expected approval links");
    expect(patched.nextStep).toContain("Use this adapterId from now on.");
    expect(patched.nextStep).toContain(`show the person this link: ${patched.readApprovals[0]!.url} .`);
    expect(awaitsReadApproval(await tools().test_adapter_operation({ connectionId: first, adapterId: patched.id, operationId: "list_orders", args: {} })))
      .toBe(true);
    expect(application.readApprovals.pendingCount(second)).toBe(0);
    expect(sent.filter((url) => url.endsWith("/orders/archive"))).toEqual([]);
  });

  it("still changes a private adapter of one connection in place", async () => {
    const only = connection("Shop");
    const created = await tools().create_adapter({ connectionId: only, slug: "shop", displayName: "Shop", dsl });
    const patched = await tools().patch_adapter({ adapterId: created.id, expectedVersion: created.version, dsl: edit("w"), connectionId: only });
    expect(patched).toMatchObject({ id: created.id, version: created.version + 1, status: "draft" });
    expect(patched).not.toHaveProperty("copiedFrom");
    expect(application.connections.getConnection(only).adapterId).toBe(created.id);
  });
});
