import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 24),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [{ id: "list_orders", description: "List orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
};

describe("renaming and deleting a connection", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function count(sql: string, ...params: unknown[]): number {
    return (application!.db.prepare(sql).get(...params) as { n: number }).n;
  }

  function connectionWithHistory(adapterOnSameSource: boolean) {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const app = application;
    const source = app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    const otherSource = app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/other", allowedOrigin: "https://docs.shop.test" });
    const adapter = app.adapters.create({
      slug: "shop", displayName: "Shop", dsl,
      documentationSourceId: adapterOnSameSource ? source.id : otherSource.id,
    });
    app.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const connection = app.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1", adapterId: adapter.id,
    });
    const draft = app.drafts.create({ documentationSourceId: source.id });
    app.db.prepare("update connection_drafts set status = 'completed', completed_connection_id = ? where id = ?").run(connection.id, draft.id);
    app.links.issue(draft.id);
    app.audits.record({
      connectionId: connection.id, adapterId: adapter.id, adapterVersion: adapter.version, operationId: "list_orders",
      startedAt: new Date().toISOString(), durationMs: 1, httpStatus: 200, outcome: "success", errorCategory: null,
    });
    app.db.prepare(
      `insert into knowledge_events (id, adapter_id, operation_id, kind, finding_json, evidence_json, created_at)
       values ('knowledge-1', ?, 'list_orders', 'pagination', '{}', '{}', ?)`,
    ).run(adapter.id, new Date().toISOString());
    app.db.prepare(
      `insert into adapter_test_outcomes (id, adapter_id, connection_id, operation_id, adapter_version, outcome, http_status, error_category, created_at)
       values ('outcome-1', ?, ?, 'list_orders', 1, 'success', 200, null, ?)`,
    ).run(adapter.id, connection.id, new Date().toISOString());
    app.jobs.enqueue("crawl_documentation", source.id);
    app.jobs.enqueue("crawl_documentation", otherSource.id);
    for (const { id } of [source, otherSource]) {
      app.docs.replaceSourceChunks(id, [{
        id: randomUUID(), pageUrl: `https://docs.shop.test/${id}`, heading: "Orders", body: "List recent orders", contentHash: `hash-${id}`,
      }], `fingerprint-${id}`);
    }
    app.actionLinks.issue(connection.id, "delete");
    return { connection, source, otherSource, adapter, draft };
  }

  function secondConnection(input: { credentialSetId: string; adapterId?: string; documentationSourceId?: string }) {
    const app = application!;
    if (input.credentialSetId !== "credentials-1") app.vault.storeFields(input.credentialSetId, { "X-Shop-Key": "other-secret" });
    const documentationSourceId = input.documentationSourceId ??
      app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/second", allowedOrigin: "https://docs.shop.test" }).id;
    return app.connections.createConnection({
      label: "Second shop", documentationSourceId, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: input.credentialSetId, ...(input.adapterId ? { adapterId: input.adapterId } : {}),
    });
  }

  it("erases the connection with its keys, history, links, unused documentation, and its unused private adapter", async () => {
    const { connection, source, otherSource, adapter, draft } = connectionWithHistory(true);
    expect(application!.connections.adapterOnDelete(connection.id)).toBe("erased");

    application!.connections.delete(connection.id);

    expect(() => application!.connections.getConnection(connection.id)).toThrow(/not found/u);
    expect(count("select count(*) as n from credential_fields where credential_set_id = 'credentials-1'")).toBe(0);
    expect(count("select count(*) as n from credential_sets where id = 'credentials-1'")).toBe(0);
    expect(count("select count(*) as n from execution_audits where connection_id = ?", connection.id)).toBe(0);
    expect(count("select count(*) as n from connection_drafts where id = ?", draft.id)).toBe(0);
    expect(count("select count(*) as n from connection_draft_links where draft_id = ?", draft.id)).toBe(0);
    expect(count("select count(*) as n from connection_action_links where connection_id = ?", connection.id)).toBe(0);
    expect(() => application!.adapters.get(adapter.id)).toThrow(/not found/u);
    expect(count("select count(*) as n from knowledge_events where adapter_id = ?", adapter.id)).toBe(0);
    expect(count("select count(*) as n from adapter_test_outcomes where adapter_id = ?", adapter.id)).toBe(0);
    expect(count("select count(*) as n from documentation_sources where id = ?", source.id)).toBe(0);
    expect(count("select count(*) as n from documentation_chunks_fts where source_id = ?", source.id)).toBe(0);
    expect(count("select count(*) as n from jobs where subject_id = ?", source.id)).toBe(0);
    expect(count("select count(*) as n from documentation_chunks_fts where source_id = ?", otherSource.id)).toBe(1);
    expect(count("select count(*) as n from jobs where subject_id = ?", otherSource.id)).toBe(1);

    const next = secondConnection({ credentialSetId: "credentials-2" });
    const rebuilt = await createToolHandlers(application!.mcpDependencies)
      .create_adapter({ connectionId: next.id, slug: "shop", displayName: "Shop", dsl });
    expect(rebuilt.slug).toBe("shop");
  });

  it("leaves a running crawl's job for the runner to finish", () => {
    const { connection, source } = connectionWithHistory(true);
    const running = application!.jobs.claimNext();
    expect(running?.subjectId).toBe(source.id);

    application!.connections.delete(connection.id);

    expect(application!.jobs.fail(running!.id, "crawl").status).toBe("failed");
  });

  it("keeps a reusable adapter and the documentation it relies on", () => {
    const { connection, source, adapter } = connectionWithHistory(true);
    const working = application!.adapters.markWorking(adapter.id, adapter.version);
    application!.adapters.markReusable(adapter.id, working.version);
    expect(application!.connections.adapterOnDelete(connection.id)).toBe("kept");

    application!.connections.delete(connection.id);

    expect(application!.adapters.get(adapter.id).visibility).toBe("reusable");
    expect(count("select count(*) as n from knowledge_events where adapter_id = ?", adapter.id)).toBe(1);
    expect(count("select count(*) as n from documentation_sources where id = ?", source.id)).toBe(1);
    expect(count("select count(*) as n from documentation_chunks_fts where source_id = ?", source.id)).toBe(1);
  });

  it("keeps a private adapter that another connection uses", () => {
    const { connection, adapter } = connectionWithHistory(false);
    const other = secondConnection({ credentialSetId: "credentials-2", adapterId: adapter.id });
    expect(application!.connections.adapterOnDelete(connection.id)).toBe("kept");

    application!.connections.delete(connection.id);

    expect(application!.adapters.get(adapter.id).id).toBe(adapter.id);
    expect(application!.connections.getConnection(other.id).adapterId).toBe(adapter.id);
  });

  it("keeps keys that another connection shares", () => {
    const { connection } = connectionWithHistory(false);
    const other = secondConnection({ credentialSetId: "credentials-1" });

    application!.connections.delete(connection.id);

    expect(count("select count(*) as n from credential_sets where id = 'credentials-1'")).toBe(1);
    expect(application!.connections.getConnection(other.id).credentials).toEqual([{ fieldName: "X-Shop-Key", configured: true }]);
  });

  it("reports when a connection has no adapter to erase", () => {
    connectionWithHistory(false);
    const bare = secondConnection({ credentialSetId: "credentials-2" });

    expect(application!.connections.adapterOnDelete(bare.id)).toBe("none");
  });

  it("renames with a trimmed label and refuses an empty or overlong one", () => {
    const { connection } = connectionWithHistory(false);

    expect(application!.connections.rename(connection.id, "  Мой WB  ").label).toBe("Мой WB");
    expect(() => application!.connections.rename(connection.id, "   ")).toThrow(/1 to 200/u);
    expect(() => application!.connections.rename(connection.id, "x".repeat(201))).toThrow(/1 to 200/u);
  });

  it("keeps only the newest confirmation link working, for its own connection only", () => {
    const { connection } = connectionWithHistory(false);
    const links = application!.actionLinks;
    const { token } = links.issue(connection.id, "delete");

    expect(links.verify(connection.id, "delete", token)).toBe(true);
    expect(links.verify("00000000-0000-4000-8000-000000000000", "delete", token)).toBe(false);
    const newer = links.issue(connection.id, "delete");
    expect(links.verify(connection.id, "delete", token)).toBe(false);
    expect(links.verify(connection.id, "delete", newer.token)).toBe(true);
  });

  it("clears expired links when it issues a new one, keeping live links for other actions", () => {
    const { connection } = connectionWithHistory(false);
    const insert = application!.db.prepare(
      `insert into connection_action_links (token_hash, connection_id, action, expires_at, created_at)
       values (?, ?, 'rename', ?, ?)`,
    );
    const now = Date.now();
    const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
    insert.run("expired", connection.id, at(-60_000), at(-3_600_000));
    insert.run("live", connection.id, at(600_000), at(-60_000));

    application!.actionLinks.issue(connection.id, "delete");

    const hashes = (application!.db.prepare("select token_hash, action from connection_action_links where connection_id = ? order by action")
      .all(connection.id) as Array<{ token_hash: string; action: string }>);
    expect(hashes.map(({ action }) => action)).toEqual(["delete", "rename"]);
    expect(hashes[1]?.token_hash).toBe("live");
  });
});
