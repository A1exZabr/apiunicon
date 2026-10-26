import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterRecord } from "../../src/adapters/repository.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 12),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

describe("adapter review and reuse in the web product", () => {
  let application: Application;

  beforeEach(() => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("ok"),
    });
  });

  afterEach(() => application.db.close());

  function createAdapter(label = "Private seller account"): { adapter: AdapterRecord; connectionId: string } {
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/", allowedOrigin: "https://docs.example.test",
    });
    const credentialSetId = randomUUID();
    application.vault.storeFields(credentialSetId, { "Api-Key": "never-render-this-secret" });
    const connection = application.connections.createConnection({
      label, documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"], credentialSetId,
    });
    const draft = application.adapters.create({
      slug: "seller-orders", displayName: "Seller orders", documentationSourceId: source.id,
      documentationFingerprint: "docs-fingerprint",
      dsl: {
        schemaVersion: 1,
        baseOrigins: ["https://api.example.test"],
        credentialBindings: [{ fieldName: "Api-Key", target: "header", headerName: "Api-Key" }],
        operations: [{
          id: "list_orders", description: "List orders", risk: "read", method: "GET",
          path: "/orders", input: {}, documentationRefs: ["docs:orders"],
        }],
      },
    });
    application.connections.bindAdapter(connection.id, draft.id);
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.db.prepare(
      `insert into knowledge_events
       (id, adapter_id, operation_id, kind, finding_json, evidence_json, created_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), adapter.id, "list_orders", "behavior",
      JSON.stringify({ workingPath: "/orders", accountId: "private-account-7" }),
      JSON.stringify({ testStatus: 200, responseBody: "customer payload" }),
      new Date().toISOString(),
    );
    application.db.prepare(
      `insert into adapter_test_outcomes
       (id, adapter_id, connection_id, operation_id, adapter_version, outcome, http_status, error_category, created_at)
       values (?, ?, ?, ?, ?, 'success', 200, null, ?)`,
    ).run(randomUUID(), adapter.id, connection.id, "list_orders", adapter.version, new Date().toISOString());
    return { adapter, connectionId: connection.id };
  }

  it("renders DSL and evidence and shows only a sanitized contribution preview", async () => {
    const { adapter } = createAdapter();
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const page = await server.inject({
      method: "GET", url: `/adapters/${adapter.id}`, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Contribution preview");
    expect(page.body).toContain("list_orders");

    expect(page.body).toContain("docs-fingerprint");
    expect(page.body).toContain("workingPath");
    expect(page.body).toContain("success");
    expect(page.body).not.toContain("never-render-this-secret");
    expect(page.body).not.toContain("Private seller account");
    expect(page.body).not.toContain("private-account-7");
    expect(page.body).not.toContain("customer payload");
    await server.close();
  });

  it("requires explicit contribution confirmation before making a working adapter reusable", async () => {
    const { adapter, connectionId } = createAdapter();
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const missingConsent = await server.inject({
      method: "POST", url: `/adapters/${adapter.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["expectedVersion", String(adapter.version)]]),
    });
    expect(missingConsent.statusCode).toBe(400);
    expect(application.adapters.get(adapter.id).visibility).toBe("private");

    const accepted = await server.inject({
      method: "POST", url: `/adapters/${adapter.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf], ["expectedVersion", String(adapter.version)],
        ["confirmContribution", "yes"],
      ]),
    });
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe(`/connections/${connectionId}`);
    expect(application.adapters.get(adapter.id).visibility).toBe("reusable");
    await server.close();
  });

  it("says why it cannot make an adapter reusable only when the person can act on it, and nothing of any other failure", async () => {
    const { adapter } = createAdapter();
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const markReusable = (expectedVersion: number) => server.inject({
      method: "POST", url: `/adapters/${adapter.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["expectedVersion", String(expectedVersion)], ["confirmContribution", "yes"]]),
    });

    const stale = await markReusable(adapter.version - 1);
    expect([stale.statusCode, stale.body]).toEqual([409, `Adapter version conflict for ${adapter.id}; expected version ${adapter.version - 1}`]);
    vi.spyOn(application.adapters, "markReusable").mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR: disk I/O error at /private/state/apiunicon.sqlite");
    });
    const failed = await markReusable(adapter.version);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toBe("Something went wrong. The details are in the APIUniCon log.");
    expect(application.adapters.get(adapter.id).visibility).toBe("private");
    await server.close();
  });

  it("shows a compatible reusable match and binds it to another connection with consent", async () => {
    const { adapter } = createAdapter("First account");
    const reusable = application.adapters.markReusable(adapter.id, adapter.version);
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.other.test/", allowedOrigin: "https://docs.other.test",
    });
    const credentialSetId = randomUUID();
    application.vault.storeFields(credentialSetId, { "Api-Key": "second-secret" });
    const second = application.connections.createConnection({
      label: "Second account", documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"], credentialSetId,
    });
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const page = await server.inject({
      method: "GET", url: `/connections/${second.id}`, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(page.body).toContain("Reusable match");
    expect(page.body).toContain("Seller orders");

    const bound = await server.inject({
      method: "POST", url: `/connections/${second.id}/bind-adapter`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["adapterId", reusable.id]]),
    });
    expect(bound.statusCode).toBe(303);
    expect(application.connections.getConnection(second.id).adapterId).toBe(reusable.id);
    await server.close();
  });

  it("erases the connection's own private adapter when a reusable one is bound, and keeps the reusable one on a repeat", async () => {
    const { adapter } = createAdapter("First account");
    const reusable = application.adapters.markReusable(adapter.id, adapter.version);
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.other.test/", allowedOrigin: "https://docs.other.test",
    });
    const credentialSetId = randomUUID();
    application.vault.storeFields(credentialSetId, { "Api-Key": "second-secret" });
    const second = application.connections.createConnection({
      label: "Second account", documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"], credentialSetId,
    });
    const own = await createToolHandlers(application.mcpDependencies).create_adapter({
      connectionId: second.id, slug: "second-orders", displayName: "Second orders", dsl: reusable.dsl,
    });
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bound = await server.inject({
        method: "POST", url: `/connections/${second.id}/bind-adapter`,
        headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["csrf", session.csrf], ["adapterId", reusable.id]]),
      });
      expect(bound.statusCode).toBe(303);
      expect(application.connections.getConnection(second.id).adapterId).toBe(reusable.id);
      expect(application.adapters.get(reusable.id).visibility).toBe("reusable");
    }
    expect(() => application.adapters.get(own.id)).toThrow(/not found/u);
    await server.close();
  });
});
