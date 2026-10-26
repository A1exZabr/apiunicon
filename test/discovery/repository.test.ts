import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { ConnectionDraftRepository } from "../../src/discovery/repository.js";
import type { DiscoveryResult } from "../../src/discovery/schema.js";

const temporaryDirectories: string[] = [];

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

function setup(db: Database.Database): { drafts: ConnectionDraftRepository; sourceId: string } {
  migrateDatabase(db);
  const connections = new ConnectionRepository(db);
  const source = connections.createDocumentationSource({
    rootUrl: "https://docs.example.test/openapi.json",
    allowedOrigin: "https://docs.example.test",
  });
  return { drafts: new ConnectionDraftRepository(db), sourceId: source.id };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("ConnectionDraftRepository", () => {
  it("persists validated discovery and selections across a database restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "apiunicon-drafts-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    let db = openDatabase(path);
    const { drafts, sourceId } = setup(db);
    const created = drafts.create({ documentationSourceId: sourceId });
    expect(created.status).toBe("discovering");

    expect(drafts.recordDiscovery(created.id, discovery).status).toBe("needs_review");
    const selected = drafts.select(created.id, {
      originIds: [discovery.origins[0]!.id],
      credentialIds: discovery.credentials.map(({ id }) => id),
    });
    expect(selected).toMatchObject({
      status: "ready",
      selectedOrigins: ["https://api.example.test"],
      selectedCredentials: [{ id: "credential-api-key", fieldName: "Api-Key" }],
    });
    db.close();

    db = openDatabase(path);
    migrateDatabase(db);
    const reopened = new ConnectionDraftRepository(db).get(created.id);
    expect(reopened.status).toBe("ready");
    expect(reopened.discovery).toEqual(discovery);
    db.close();
  });

  it("moves an empty result to help and stores only a failure category", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const created = drafts.create({ documentationSourceId: sourceId });
    expect(drafts.recordDiscovery(created.id, {
      serviceName: null,
      suggestedLabel: null,
      origins: [],
      credentials: [],
      unsupportedAuthMethods: [],
    }).status).toBe("needs_help");
    expect(drafts.markFailed(created.id, "crawl")).toMatchObject({
      status: "failed",
      errorCategory: "crawl",
    });
    db.close();
  });

  it("rejects unknown candidate IDs and completion before readiness", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const created = drafts.create({ documentationSourceId: sourceId });
    drafts.recordDiscovery(created.id, discovery);

    expect(() => drafts.select(created.id, {
      originIds: ["origin-not-discovered"],
      credentialIds: ["credential-api-key"],
    })).toThrow(/origin/iu);
    expect(() => drafts.markCompleted(created.id, "connection-not-ready")).toThrow(/ready/iu);
    db.close();
  });

  it("records why a draft needs help and resets it on retry", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    const { drafts, sourceId } = setup(db);
    const draft = drafts.create({ documentationSourceId: sourceId });
    expect(drafts.markDocumentationUnavailable(draft.id)).toMatchObject({
      status: "needs_help",
      helpReason: "documentation_unavailable",
      errorCategory: null,
    });
    expect(drafts.resetForRetry(draft.id)).toMatchObject({ status: "discovering", helpReason: null });
    db.close();
  });

  it("refreshes discovery with provenance from any open state", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    const { drafts, sourceId } = setup(db);
    const draft = drafts.markDocumentationUnavailable(drafts.create({ documentationSourceId: sourceId }).id);
    const summary = { kind: "model_settings" as const, rationale: "No public docs" };
    const refreshed = drafts.refreshDiscovery(draft.id, discovery, summary);
    expect(refreshed).toMatchObject({ status: "needs_review", helpReason: null, provenanceSummary: summary });
    db.close();
  });

  it("classifies unsupported authentication separately from missing documentation", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const draft = drafts.create({ documentationSourceId: sourceId });
    expect(drafts.recordDiscovery(draft.id, { ...discovery, credentials: [], unsupportedAuthMethods: ["OAuth 2.0 authorization code"] }))
      .toMatchObject({ status: "needs_help", helpReason: "unsupported_auth" });
    expect(drafts.resetForRetry(draft.id)).toMatchObject({ status: "discovering", helpReason: null });
    expect(drafts.recordDiscovery(draft.id, { ...discovery, origins: [], credentials: [] }))
      .toMatchObject({ status: "needs_help", helpReason: "documentation_unavailable" });
    db.close();
  });

  it("proceeds with a supported header credential found alongside OAuth and keeps OAuth for information", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const draft = drafts.create({ documentationSourceId: sourceId });
    const recorded = drafts.recordDiscovery(draft.id, { ...discovery, unsupportedAuthMethods: ["OAuth 2.0"] });
    expect(recorded).toMatchObject({ status: "needs_review", helpReason: null });
    expect(recorded.discovery.unsupportedAuthMethods).toEqual(["OAuth 2.0"]);
    const summary = { kind: "model_settings" as const, rationale: "Origins still missing" };
    expect(drafts.refreshDiscovery(draft.id, { ...discovery, origins: [], unsupportedAuthMethods: ["OAuth 2.0"] }, summary))
      .toMatchObject({ status: "needs_help", helpReason: "documentation_unavailable" });
    db.close();
  });

  it("does not resume a draft stopped by unsupported authentication", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const rootUrl = "https://docs.example.test/openapi.json";
    const draft = drafts.create({ documentationSourceId: sourceId });
    drafts.recordDiscovery(draft.id, { ...discovery, credentials: [], unsupportedAuthMethods: ["OAuth 2.0"] });
    expect(drafts.findOpenByRootUrl(rootUrl)).toBeNull();
    drafts.resetForRetry(draft.id);
    drafts.markDocumentationUnavailable(draft.id);
    expect(drafts.findOpenByRootUrl(rootUrl)?.id).toBe(draft.id);
    db.close();
  });

  it("finds the newest open draft for a documentation link and ignores closed ones", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const rootUrl = "https://docs.example.test/openapi.json";
    expect(drafts.findOpenByRootUrl(rootUrl)).toBeNull();
    const draft = drafts.create({ documentationSourceId: sourceId });
    expect(drafts.findOpenByRootUrl(rootUrl)?.id).toBe(draft.id);
    expect(drafts.findOpenByRootUrl("https://docs.example.test/other")).toBeNull();
    drafts.markFailed(draft.id, "crawl");
    expect(drafts.findOpenByRootUrl(rootUrl)).toBeNull();
    db.close();
  });

  it("clears provenance when a draft is retried", () => {
    const db = openDatabase(":memory:");
    const { drafts, sourceId } = setup(db);
    const draft = drafts.markDocumentationUnavailable(drafts.create({ documentationSourceId: sourceId }).id);
    drafts.refreshDiscovery(draft.id, { ...discovery, origins: [], credentials: [] }, {
      kind: "model_settings",
      rationale: "No public docs",
    });
    expect(drafts.get(draft.id).provenanceSummary).not.toBeNull();
    expect(drafts.resetForRetry(draft.id)).toMatchObject({ provenanceSummary: null, helpReason: null });
    db.close();
  });
});
