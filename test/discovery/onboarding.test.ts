import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository } from "../../src/adapters/repository.js";
import type { AdapterDsl } from "../../src/adapters/schema.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { ConnectionDraftRepository } from "../../src/discovery/repository.js";
import { ConnectionDiscoveryService } from "../../src/discovery/service.js";
import { DocumentRepository } from "../../src/docs/documents.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { Vault } from "../../src/vault/vault.js";

const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://common-api.wildberries.ru"],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [{ id: "seller_info", description: "Seller info", risk: "read", method: "GET", path: "/api/v1/seller-info", input: {}, documentationRefs: [] }],
};

describe("chat onboarding service", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let drafts: ConnectionDraftRepository;
  let jobs: JobRepository;
  let service: ConnectionDiscoveryService;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    drafts = new ConnectionDraftRepository(db);
    jobs = new JobRepository(db);
    service = new ConnectionDiscoveryService({
      db, adapters, connections, drafts, jobs, vault: new Vault(db, Buffer.alloc(32, 5)), documents: new DocumentRepository(db),
    });
  });

  afterEach(() => db.close());

  function reusableAdapter(rootUrl = "https://dev.wildberries.ru/docs/openapi/orders-fbs") {
    const source = connections.createDocumentationSource({ rootUrl, allowedOrigin: new URL(rootUrl).origin });
    const created = adapters.create({ slug: "wb-seller", displayName: "Wildberries Seller", documentationSourceId: source.id, dsl });
    const working = adapters.markWorking(created.id, created.version);
    return adapters.markReusable(working.id, working.version);
  }

  function reusableAdapterWith(adapterDsl: AdapterDsl, rootUrl = "https://dev.wildberries.ru/docs/openapi/orders-fbs") {
    const source = connections.createDocumentationSource({ rootUrl, allowedOrigin: new URL(rootUrl).origin });
    const created = adapters.create({ slug: "wb-seller", displayName: "Wildberries Seller", documentationSourceId: source.id, dsl: adapterDsl });
    const working = adapters.markWorking(created.id, created.version);
    return adapters.markReusable(working.id, working.version);
  }

  const twoOrigins: AdapterDsl = {
    ...dsl,
    baseOrigins: ["https://common-api.wildberries.ru", "https://statistics-api.wildberries.ru"],
  };

  function queuedJobs(): number {
    return (db.prepare("select count(*) as count from jobs").get() as { count: number }).count;
  }

  it("fills a new draft from a reusable adapter on the same registrable domain without crawling", () => {
    const adapter = reusableAdapter();
    const draft = service.start(LINK);
    expect(queuedJobs()).toBe(0);
    expect(draft).toMatchObject({
      status: "needs_review",
      provenanceSummary: { kind: "registry", adapterId: adapter.id, adapterSlug: "wb-seller" },
    });
    expect(draft.discovery.origins.map(({ origin }) => origin)).toEqual(["https://common-api.wildberries.ru"]);
    expect(draft.discovery.credentials.map(({ fieldName }) => fieldName)).toEqual(["Authorization"]);
  });

  it("ignores reusable adapters from other domains and crawls instead", () => {
    reusableAdapter("https://docs.ozon.ru/api/seller/");
    expect(service.start(LINK).status).toBe("discovering");
    expect(queuedJobs()).toBe(1);
  });

  it("resumes the open draft for the same link", () => {
    const first = service.start(LINK);
    expect(service.start(`${LINK}#tag/orders`).id).toBe(first.id);
    expect(queuedJobs()).toBe(1);
  });

  it("starts a fresh draft instead of resuming one stopped by unsupported authentication", () => {
    const first = service.start(LINK);
    drafts.recordDiscovery(first.id, {
      serviceName: "WB", suggestedLabel: "WB", origins: [], credentials: [], unsupportedAuthMethods: ["OAuth 2.0"],
    });
    const second = service.start(LINK);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("discovering");
  });

  it("accepts AI-proposed settings only on the link's domain and only when documentation is unavailable", () => {
    const draft = service.start(LINK);
    const proposal = {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru"],
      credentials: [{ fieldName: "Authorization", kind: "api_key" as const, humanLabel: "API token" }],
      rationale: "Official docs are blocked; values from my knowledge of the WB API",
    };
    expect(() => service.proposeSettings(draft.id, proposal)).toThrow(/documentation is unavailable/u);
    drafts.markDocumentationUnavailable(draft.id);
    expect(() => service.proposeSettings(draft.id, { ...proposal, origins: ["https://evil.example"] })).toThrow(/outside/u);
    const proposed = service.proposeSettings(draft.id, proposal);
    expect(proposed).toMatchObject({ status: "needs_review", provenanceSummary: { kind: "model_settings" } });
    expect(proposed.discovery.origins[0]?.evidence[0]?.kind).toBe("model_proposal");
  });

  it("selects and completes in one step and binds the reusable adapter", () => {
    const adapter = reusableAdapter();
    const draft = service.start(LINK);
    const connection = service.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "wb-token-value", "credential-unknown": "ignored" },
    });
    expect(connection.adapterId).toBe(adapter.id);
    expect(drafts.get(draft.id).status).toBe("completed");
    expect(JSON.stringify(drafts.get(draft.id))).not.toContain("wb-token-value");
  });

  it("crawls normally when the adapter's credential name does not fit discovery candidates", () => {
    reusableAdapterWith({
      ...dsl,
      credentialBindings: [{ fieldName: "X_Api_Key", target: "header", headerName: "X-Api-Key" }],
    });
    const draft = service.start(LINK);
    expect(draft.status).toBe("discovering");
    expect(draft.provenanceSummary).toBeNull();
    expect(queuedJobs()).toBe(1);
  });

  it("rejects proposed credential fields that differ only by case", () => {
    const draft = service.start(LINK);
    drafts.markDocumentationUnavailable(draft.id);
    expect(() => service.proposeSettings(draft.id, {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru"],
      credentials: [
        { fieldName: "X-Api-Key", kind: "api_key", humanLabel: "API key" },
        { fieldName: "x-api-key", kind: "api_key", humanLabel: "API key again" },
      ],
      rationale: "duplicate check",
    })).toThrow(/more than once/u);
    expect(drafts.get(draft.id).status).toBe("needs_help");
  });

  describe("atomic selection and completion", () => {
    it.each([
      ["blank", (id: string) => ({ [id]: "" })],
      ["missing", () => ({})],
    ])("rolls the selection back when the key is %s so the person can re-pick", (_name, values) => {
      reusableAdapterWith(twoOrigins);
      const draft = service.start(LINK);
      const [first, second] = draft.discovery.origins;
      const credentialId = draft.discovery.credentials[0]!.id;
      expect(() => service.completeWithSelection(draft.id, {
        originIds: [first!.id],
        credentialIds: [credentialId],
        credentialValues: values(credentialId),
      })).toThrow();
      expect(drafts.get(draft.id)).toMatchObject({ status: "needs_review", selectedOrigins: null, selectedCredentials: null });

      const connection = service.completeWithSelection(draft.id, {
        originIds: [second!.id],
        credentialIds: [credentialId],
        credentialValues: { [credentialId]: "wb-token-value" },
      });
      expect(connection.allowedOrigins).toEqual([second!.origin]);
      expect(drafts.get(draft.id).status).toBe("completed");
    });

    it("refuses different ids on an already selected draft and leaves it untouched", () => {
      reusableAdapterWith(twoOrigins);
      const draft = service.start(LINK);
      const [first, second] = draft.discovery.origins;
      const credentialId = draft.discovery.credentials[0]!.id;
      service.select(draft.id, { originIds: [first!.id], credentialIds: [credentialId] });
      const values = { [credentialId]: "wb-token-value" };

      expect(() => service.completeWithSelection(draft.id, {
        originIds: [second!.id], credentialIds: [credentialId], credentialValues: values,
      })).toThrow(/different selection/u);
      expect(() => service.completeWithSelection(draft.id, {
        originIds: [first!.id], credentialIds: ["credential-unknown"], credentialValues: values,
      })).toThrow(/different selection/u);
      expect(drafts.get(draft.id)).toMatchObject({ status: "ready", selectedOrigins: [first!.origin] });

      const connection = service.completeWithSelection(draft.id, {
        originIds: [first!.id], credentialIds: [credentialId], credentialValues: values,
      });
      expect(connection.allowedOrigins).toEqual([first!.origin]);
    });

    it("uses the stored selection when a selected draft is completed with empty ids", () => {
      reusableAdapterWith(twoOrigins);
      const draft = service.start(LINK);
      const [first] = draft.discovery.origins;
      const credentialId = draft.discovery.credentials[0]!.id;
      service.select(draft.id, { originIds: [first!.id], credentialIds: [credentialId] });
      const connection = service.completeWithSelection(draft.id, {
        originIds: [], credentialIds: [], credentialValues: { [credentialId]: "wb-token-value" },
      });
      expect(connection.allowedOrigins).toEqual([first!.origin]);
    });
  });
});
