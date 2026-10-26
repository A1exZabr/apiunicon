import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository } from "../../src/adapters/repository.js";
import type { AdapterDsl } from "../../src/adapters/schema.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { ConnectionDraftRepository } from "../../src/discovery/repository.js";
import type { DiscoveryResult } from "../../src/discovery/schema.js";
import { ConnectionDiscoveryService } from "../../src/discovery/service.js";
import { DocumentRepository } from "../../src/docs/documents.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { Vault } from "../../src/vault/vault.js";

const discovery: DiscoveryResult = {
  serviceName: "Fixture Orders API",
  suggestedLabel: "Fixture Orders",
  origins: [{
    id: "origin-api-example",
    origin: "https://api.example.test",
    serviceLabel: "Fixture Orders",
    confidence: "high",
    evidence: [{ pageUrl: "https://docs.example.test/openapi.json", kind: "openapi_server" }],
    observationCount: 1,
  }],
  credentials: [{
    id: "credential-api-key",
    fieldName: "Api-Key",
    kind: "api_key",
    placement: "header",
    humanLabel: "API key",
    confidence: "high",
    evidence: [{ pageUrl: "https://docs.example.test/openapi.json", kind: "openapi_security" }],
  }],
  unsupportedAuthMethods: [],
};

describe("ConnectionDiscoveryService", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let drafts: ConnectionDraftRepository;
  let jobs: JobRepository;
  let vault: Vault;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    drafts = new ConnectionDraftRepository(db);
    jobs = new JobRepository(db);
    vault = new Vault(db, Buffer.alloc(32, 4));
  });

  afterEach(() => db.close());

  function service(vaultOverride: Pick<Vault, "storeFields"> = vault): ConnectionDiscoveryService {
    return new ConnectionDiscoveryService({
      db,
      adapters,
      connections,
      drafts,
      jobs,
      documents: new DocumentRepository(db),
      vault: vaultOverride,
    });
  }

  function readyDraft(instance = service()) {
    const created = instance.begin("https://docs.example.test/openapi.json");
    drafts.recordDiscovery(created.id, discovery);
    return instance.select(created.id, {
      originIds: ["origin-api-example"],
      credentialIds: ["credential-api-key"],
    });
  }

  it("begins with one documentation URL and queues discovery", () => {
    const created = service().begin("https://docs.example.test/openapi.json");
    expect(created.status).toBe("discovering");
    expect(jobs.latest("crawl_documentation", created.documentationSourceId)?.status).toBe("queued");
  });

  it("atomically stores values in Vault and creates a non-secret connection", async () => {
    const instance = service();
    const draft = readyDraft(instance);
    const connection = instance.complete(draft.id, {
      credentialValues: { "credential-api-key": "secret-value" },
    });

    expect(connection).toMatchObject({
      label: "Fixture Orders",
      allowedOrigins: ["https://api.example.test"],
      credentials: [{ fieldName: "Api-Key", configured: true }],
    });
    expect(drafts.get(draft.id)).toMatchObject({ status: "completed", completedConnectionId: connection.id });
    expect(JSON.stringify(drafts.get(draft.id))).not.toContain("secret-value");
    await vault.withCredentials(connection.credentialSetId, async (fields) => {
      expect(fields["Api-Key"]).toBe("secret-value");
    });
  });

  it("adds a numeric suffix to duplicate inferred labels", () => {
    const instance = service();
    const first = readyDraft(instance);
    expect(instance.complete(first.id, {
      credentialValues: { "credential-api-key": "first" },
    }).label).toBe("Fixture Orders");
    const second = readyDraft(instance);
    expect(instance.complete(second.id, {
      credentialValues: { "credential-api-key": "second" },
    }).label).toBe("Fixture Orders 2");
  });

  it("rejects missing and extra credential IDs before writing anything", () => {
    const instance = service();
    const missing = readyDraft(instance);
    expect(() => instance.complete(missing.id, { credentialValues: {} })).toThrow(/credential/iu);
    const extra = readyDraft(instance);
    expect(() => instance.complete(extra.id, {
      credentialValues: { "credential-api-key": "ok", "credential-extra": "no" },
    })).toThrow(/credential/iu);
    expect(connections.listConnections()).toEqual([]);
    expect((db.prepare("select count(*) as count from credential_sets").get() as { count: number }).count).toBe(0);
  });

  it("rolls back every row when Vault storage fails", () => {
    const failing = service({ storeFields: () => { throw new Error("forced Vault failure"); } });
    const draft = readyDraft(failing);
    expect(() => failing.complete(draft.id, {
      credentialValues: { "credential-api-key": "never-persist" },
    })).toThrow("forced Vault failure");
    expect(connections.listConnections()).toEqual([]);
    expect((db.prepare("select count(*) as count from credential_sets").get() as { count: number }).count).toBe(0);
    expect(drafts.get(draft.id).status).toBe("ready");
  });

  it("automatically binds only an exact reusable adapter match", () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/adapter",
      allowedOrigin: "https://docs.example.test",
    });
    const dsl: AdapterDsl = {
      schemaVersion: 1,
      baseOrigins: ["https://api.example.test"],
      credentialBindings: [{ fieldName: "Api-Key", target: "header", headerName: "Api-Key" }],
      operations: [{
        id: "list_orders",
        description: "List orders",
        risk: "read",
        method: "GET",
        path: "/orders",
        input: {},
        documentationRefs: [],
      }],
    };
    const createdAdapter = adapters.create({
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      documentationSourceId: source.id,
      dsl,
    });
    const working = adapters.markWorking(createdAdapter.id, createdAdapter.version);
    const reusable = adapters.markReusable(working.id, working.version);
    const draft = readyDraft();
    const connection = service().complete(draft.id, {
      credentialValues: { "credential-api-key": "secret" },
    });
    expect(connection.adapterId).toBe(reusable.id);
  });

  it.each([
    "https://api.example.test/path",
    "http://api.example.test",
    "https://user:password@api.example.test",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.20.30.40",
    "https://[::1]",
    "https://[fd00::1]",
  ])("rejects an unsafe advanced API origin %s", (origin) => {
    const instance = service();
    const draft = instance.begin("https://docs.example.test/");
    drafts.recordDiscovery(draft.id, {
      serviceName: null,
      suggestedLabel: null,
      origins: [],
      credentials: [],
      unsupportedAuthMethods: [],
    });
    expect(() => instance.selectAdvanced(draft.id, {
      origins: [origin],
      credentialNames: ["Api-Key"],
    })).toThrow();
    expect(drafts.get(draft.id).status).toBe("needs_help");
  });

  it("accepts one valid public-looking advanced origin and credential name", () => {
    const instance = service();
    const draft = instance.begin("https://docs.example.test/");
    drafts.recordDiscovery(draft.id, {
      serviceName: null,
      suggestedLabel: null,
      origins: [],
      credentials: [],
      unsupportedAuthMethods: [],
    });
    expect(instance.selectAdvanced(draft.id, {
      origins: ["https://api.example.test"],
      credentialNames: ["Api-Key"],
      label: "Example",
    })).toMatchObject({ status: "ready", selectedOrigins: ["https://api.example.test"] });
  });

  it("refreshes a draft from stored documents under the trust rules", () => {
    const instance = service();
    const draft = instance.begin("https://docs.example.test/openapi.json");
    drafts.markDocumentationUnavailable(draft.id);
    new DocumentRepository(db).add({
      sourceId: draft.documentationSourceId,
      url: "https://raw.githubusercontent.com/someone/copy/main/openapi.json",
      kind: "openapi",
      provenance: "third_party",
      sha256: "a".repeat(64),
      byteSize: 100,
      discovery: {
        ...discovery,
        origins: [
          ...discovery.origins,
          { ...discovery.origins[0]!, id: "origin-evil00000", origin: "https://evil.example" },
        ],
      },
      chunks: [],
    });
    const refreshed = instance.refreshFromDocuments(draft.id);
    expect(refreshed.status).toBe("needs_review");
    expect(refreshed.discovery.origins.map(({ origin }) => origin)).toEqual(["https://api.example.test"]);
    expect(refreshed.provenanceSummary).toMatchObject({
      kind: "documents",
      documents: [expect.objectContaining({ provenance: "third_party" })],
      discardedOrigins: [{ origin: "https://evil.example", reason: "outside_link_domain" }],
    });
  });

  it("records an over-long discarded origin truncated instead of failing the refresh", () => {
    const instance = service();
    const draft = instance.begin("https://docs.example.test/openapi.json");
    const longOrigin = `https://${["a", "b", "c", "d", "e"].map((letter) => letter.repeat(60)).join(".")}.example`;
    new DocumentRepository(db).add({
      sourceId: draft.documentationSourceId,
      url: "https://raw.githubusercontent.com/someone/copy/main/openapi.json",
      kind: "openapi",
      provenance: "third_party",
      sha256: "b".repeat(64),
      byteSize: 100,
      discovery: {
        ...discovery,
        origins: [...discovery.origins, { ...discovery.origins[0]!, id: "origin-long00000", origin: longOrigin }],
      },
      chunks: [],
    });
    expect(longOrigin.length).toBeGreaterThan(300);
    const refreshed = instance.refreshFromDocuments(draft.id);
    expect(refreshed.status).toBe("needs_review");
    expect(refreshed.provenanceSummary).toMatchObject({
      kind: "documents",
      discardedOrigins: [{ origin: longOrigin.slice(0, 300), reason: "outside_link_domain" }],
    });
  });
});
