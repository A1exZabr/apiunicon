import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { AdapterDsl, AdapterOperation } from "../../src/adapters/schema.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { ChangeRequestRepository } from "../../src/changes/repository.js";
import { ConnectionActionLinkRepository } from "../../src/connections/action-links.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { ConnectionDraftRepository } from "../../src/discovery/repository.js";
import { emptyDiscoveryResult } from "../../src/discovery/schema.js";
import { stageFor } from "../../src/discovery/stage.js";
import { DocsRepository } from "../../src/docs/repository.js";
import { NotFoundError } from "../../src/domain/types.js";
import { readForm, ReadApprovalRepository } from "../../src/reads/repository.js";
import { newLinkToken, tokenHash } from "../../src/security/one-time-token.js";
import { TunnelRepository } from "../../src/tunnel/repository.js";

// The first released schema, before documents and help reasons existed.
const BASE_SCHEMA = readFileSync(new URL("../fixtures/schema-before-documents.sql", import.meta.url), "utf8");
// The schema the migration made before it dropped the columns nothing uses, as sqlite_master holds it, without the
// tables the full-text index keeps for itself.
const SCHEMA_WITH_UNUSED_COLUMNS = readFileSync(new URL("../fixtures/schema-with-unused-columns.sql", import.meta.url), "utf8");
const NOW = "2026-10-01T00:00:00.000Z";
// change_requests as the schema created it before confirmation settings existed.
const CHANGE_REQUESTS_BEFORE_CONFIRMATION = `CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  connection_label TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('write', 'destructive')),
  method TEXT NOT NULL,
  target_url TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  requested_via TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'cancelled', 'refused', 'running', 'succeeded', 'failed', 'unknown')),
  step INTEGER NOT NULL DEFAULT 0 CHECK (step IN (0, 1)),
  reason TEXT,
  http_status INTEGER,
  error_category TEXT,
  result_json TEXT,
  result_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  finished_at TEXT
)`;

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`select count(*) as count from ${table}`).get() as { count: number }).count;
}

function firstReleaseDatabase(): ReturnType<typeof openDatabase> {
  const db = openDatabase(":memory:");
  db.exec(BASE_SCHEMA);
  const source = db.prepare("insert into documentation_sources values (?, ?, ?, 'ready', ?, null, ?, ?)");
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) source.run(id, `https://docs.${id}.test/`, `https://docs.${id}.test`, `fp-${id}`, NOW, NOW);
  db.prepare("insert into documentation_chunks values ('c1', 's1', 'https://docs.s1.test/', 'Seller auth', 'Send Client-Id and Api-Key headers', 'h1')").run();
  db.prepare("insert into documentation_chunks_fts values ('c1', 's1', 'Seller auth', 'Send Client-Id and Api-Key headers')").run();
  const draft = db.prepare(
    `insert into connection_drafts (id, documentation_source_id, status, service_name, suggested_label, discovery_json, created_at, updated_at)
     values (?, ?, ?, 'Seller', 'Seller', ?, ?, ?)`,
  );
  const withOAuth = JSON.stringify({ ...emptyDiscoveryResult(), unsupportedAuthMethods: ["OAuth 2.0"] });
  const empty = JSON.stringify(emptyDiscoveryResult());
  draft.run("d-oauth", "s2", "needs_help", withOAuth, NOW, NOW);
  draft.run("d-blocked", "s3", "needs_help", empty, NOW, NOW);
  draft.run("d-review", "s4", "needs_review", withOAuth, NOW, NOW);
  draft.run("d-corrupt", "s5", "needs_help", "not json", NOW, NOW);
  db.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
  db.prepare("insert into connections values ('conn1', 'Seller', null, 's1', ?, 'cs1', ?, ?)")
    .run(JSON.stringify(["https://api.s1.test"]), NOW, NOW);
  return db;
}

describe("database migration", () => {
  it("upgrades a database created by the released schema without losing rows", () => {
    const db = firstReleaseDatabase();

    migrateDatabase(db);
    migrateDatabase(db);

    expect(columns(db, "documentation_chunks")).toContain("document_id");
    expect(columns(db, "connection_drafts")).toEqual(expect.arrayContaining(["help_reason", "provenance_summary_json"]));
    expect(columns(db, "documentation_documents")).toContain("discovery_json");
    expect(columns(db, "adapters")).toEqual(expect.arrayContaining(["catalog_entry_id", "catalog_version"]));
    expect(columns(db, "connection_draft_links")).toEqual(["token_hash", "draft_id", "expires_at", "used_at", "created_at"]);
    expect([count(db, "documentation_sources"), count(db, "documentation_chunks"), count(db, "connection_drafts"), count(db, "connections")])
      .toEqual([5, 1, 4, 1]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(new DocsRepository(db).search("s1", "Api-Key", 5).map(({ id }) => id)).toEqual(["c1"]);
    db.close();
  });

  it("gives drafts from the first release that need help the reason they stopped, once", () => {
    const db = firstReleaseDatabase();

    migrateDatabase(db);
    const drafts = new ConnectionDraftRepository(db);
    expect(drafts.get("d-oauth")).toMatchObject({ status: "needs_help", helpReason: "unsupported_auth" });
    expect(stageFor(drafts.get("d-oauth"))).toBe("failed");
    expect(drafts.get("d-blocked")).toMatchObject({ status: "needs_help", helpReason: "documentation_unavailable" });
    expect(drafts.get("d-review").helpReason).toBeNull();
    expect(db.prepare("select help_reason from connection_drafts where id = 'd-corrupt'").get()).toEqual({ help_reason: "documentation_unavailable" });

    db.prepare("update connection_drafts set help_reason = 'documentation_unavailable' where id = 'd-oauth'").run();
    migrateDatabase(db);
    expect(drafts.get("d-oauth").helpReason).toBe("documentation_unavailable");
    db.close();
  });

  it("adds writes_enabled to an existing database, off for every connection", () => {
    const db = firstReleaseDatabase();
    db.prepare("insert into connections values ('conn2', 'Second', null, 's2', ?, 'cs1', ?, ?)")
      .run(JSON.stringify(["https://api.s2.test"]), NOW, NOW);
    expect(columns(db, "connections")).not.toContain("writes_enabled");

    migrateDatabase(db);

    expect(columns(db, "connections")).toContain("writes_enabled");
    const connections = new ConnectionRepository(db);
    expect(connections.listConnections().map(({ id, writesEnabled }) => [id, writesEnabled])).toEqual([["conn1", false], ["conn2", false]]);
    expect(columns(db, "change_requests")).toEqual(expect.arrayContaining(["token_hash", "connection_id", "status", "step", "result_expires_at"]));

    connections.setWritesEnabled("conn2", true);
    migrateDatabase(db);
    expect(connections.listConnections().map(({ id, writesEnabled }) => [id, writesEnabled])).toEqual([["conn1", false], ["conn2", true]]);
    expect(count(db, "connections")).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("gives a new connection writes off", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    db.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)").run(NOW, NOW);
    db.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
    db.prepare("insert into connections (id, label, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at) values ('conn1', 'Seller', 's1', '[]', 'cs1', ?, ?)")
      .run(NOW, NOW);

    const connections = new ConnectionRepository(db);
    expect(connections.getConnection("conn1").writesEnabled).toBe(false);
    expect(connections.getConnection("conn1").confirmChanges).toBe(true);
    expect(connections.setConfirmChanges("conn1", false).confirmChanges).toBe(false);
    expect(connections.getConnection("conn1").confirmChanges).toBe(false);
    expect(() => connections.setConfirmChanges("missing", false)).toThrow(NotFoundError);
    // Only 0 turns confirmation off: a value nobody wrote through the repository keeps asking the person.
    for (const stored of [7, -1, 2]) {
      db.prepare("update connections set confirm_changes = ? where id = 'conn1'").run(stored);
      expect(connections.getConnection("conn1").confirmChanges, String(stored)).toBe(true);
    }
    db.close();
  });

  it("adds confirm_changes on for every connection and confirmation 'person' for every earlier change", () => {
    const db = firstReleaseDatabase();
    db.prepare("insert into connections values ('conn2', 'Second', null, 's2', ?, 'cs1', ?, ?)")
      .run(JSON.stringify(["https://api.s2.test"]), NOW, NOW);
    db.exec(CHANGE_REQUESTS_BEFORE_CONFIRMATION);
    db.prepare(
      `insert into change_requests
        (id, token_hash, connection_id, connection_label, adapter_id, adapter_version, operation_id, operation_json, risk,
         method, target_url, args_json, summary, requested_via, status, step, created_at, expires_at, decided_at, finished_at)
       values ('change-1', 'hash-1', 'conn1', 'Seller', 'adapter-1', 2, 'set_price', ?, 'write', 'POST',
         'https://api.s1.test/prices', '{"price":349}', 'Set the price', null, 'succeeded', 0, ?, ?, ?, ?)`,
    ).run(
      JSON.stringify({ id: "set_price", description: "Set the price", risk: "write", method: "POST", path: "/prices", input: {}, documentationRefs: [] }),
      NOW, NOW, NOW, NOW,
    );
    expect(columns(db, "connections")).not.toContain("confirm_changes");
    expect(columns(db, "change_requests")).not.toContain("confirmation");

    migrateDatabase(db);

    expect(columns(db, "connections")).toContain("confirm_changes");
    expect(columns(db, "change_requests")).toContain("confirmation");
    const connections = new ConnectionRepository(db);
    const changes = new ChangeRequestRepository(db, { requestTimeoutMs: 1_000 });
    expect(connections.listConnections().map(({ id, confirmChanges }) => [id, confirmChanges])).toEqual([["conn1", true], ["conn2", true]]);
    expect(changes.get("change-1")).toMatchObject({ status: "succeeded", confirmation: "person" });

    // The second run changes nothing, also a connection the person already turned confirmation off for.
    connections.setConfirmChanges("conn2", false);
    migrateDatabase(db);
    expect(connections.listConnections().map(({ id, confirmChanges }) => [id, confirmChanges])).toEqual([["conn1", true], ["conn2", false]]);
    expect(changes.get("change-1")?.confirmation).toBe("person");
    expect([count(db, "connections"), count(db, "change_requests")]).toEqual([2, 1]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("adds the card columns to an existing database, with no card token, no tries and no card confirmation", () => {
    const db = firstReleaseDatabase();
    db.exec(CHANGE_REQUESTS_BEFORE_CONFIRMATION);
    // As the release before the chat card left it: the confirmation column, and a change let through without it.
    db.exec("alter table change_requests add column confirmation TEXT NOT NULL DEFAULT 'person' CHECK (confirmation IN ('person', 'none'))");
    const operation = JSON.stringify({ id: "set_price", description: "Set the price", risk: "write", method: "POST", path: "/prices", input: {}, documentationRefs: [] });
    const insert = db.prepare(
      `insert into change_requests
        (id, token_hash, connection_id, connection_label, adapter_id, adapter_version, operation_id, operation_json, risk,
         method, target_url, args_json, summary, requested_via, confirmation, status, step, created_at, expires_at, decided_at, finished_at)
       values (?, ?, 'conn1', 'Seller', 'adapter-1', 2, 'set_price', ?, 'write', 'POST',
         'https://api.s1.test/prices', '{"price":349}', 'Set the price', null, ?, ?, 0, ?, ?, ?, ?)`,
    );
    insert.run("change-1", "hash-1", operation, "person", "succeeded", NOW, NOW, NOW, NOW);
    insert.run("change-2", "hash-2", operation, "none", "succeeded", NOW, NOW, NOW, NOW);
    insert.run("change-3", "hash-3", operation, "person", "pending", NOW, "2999-01-01T00:00:00.000Z", null, null);
    for (const column of ["card_token_hash", "card_failures", "via_card"]) expect(columns(db, "change_requests")).not.toContain(column);

    migrateDatabase(db);

    expect(columns(db, "change_requests")).toEqual(expect.arrayContaining(["card_token_hash", "card_failures", "via_card"]));
    const stored = () => db.prepare("select id, confirmation, card_token_hash, card_failures, via_card from change_requests order by id").all();
    expect(stored()).toEqual([
      { id: "change-1", confirmation: "person", card_token_hash: null, card_failures: 0, via_card: 0 },
      { id: "change-2", confirmation: "none", card_token_hash: null, card_failures: 0, via_card: 0 },
      { id: "change-3", confirmation: "person", card_token_hash: null, card_failures: 0, via_card: 0 },
    ]);
    const changes = new ChangeRequestRepository(db, { requestTimeoutMs: 1_000 });
    expect(changes.get("change-1")?.confirmation).toBe("person");
    expect(changes.get("change-2")?.confirmation).toBe("none");
    expect(changes.list({ confirmation: "card", limit: 10 })).toEqual([]);
    // A change that waited before the card existed has no card token to try, and a try counts nothing.
    expect(changes.verifyCard("change-3", "A".repeat(22))).toEqual({ kind: "invalid" });

    const before = db.prepare("select * from change_requests order by id").all();
    migrateDatabase(db);
    expect(db.prepare("select * from change_requests order by id").all()).toEqual(before);
    expect(count(db, "change_requests")).toBe(3);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("drops the columns nothing uses from a database of the previous schema, keeping every row", () => {
    const db = openDatabase(":memory:");
    db.exec(SCHEMA_WITH_UNUSED_COLUMNS);
    db.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)")
      .run(NOW, NOW);
    db.prepare("insert into credential_sets values ('cs1', ?, ?), ('tunnel-cs', ?, ?)").run(NOW, NOW, NOW, NOW);
    db.prepare(
      `insert into adapters (id, slug, display_name, documentation_source_id, visibility, status, version, dsl_json, created_at, updated_at)
       values ('a1', 'seller', 'Seller', 's1', 'private', 'working', 2, '{}', ?, ?)`,
    ).run(NOW, NOW);
    db.prepare(
      `insert into connections (id, label, adapter_id, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at)
       values ('conn1', 'Seller', 'a1', 's1', ?, 'cs1', ?, ?)`,
    ).run(JSON.stringify(["https://api.s1.test"]), NOW, NOW);
    db.prepare(
      `insert into execution_audits
        (id, connection_id, adapter_id, adapter_version, operation_id, started_at, duration_ms, http_status, outcome,
         error_category, adapter_changed)
       values ('audit-1', 'conn1', 'a1', 2, 'list_orders', ?, 12, 200, 'success', null, 0)`,
    ).run(NOW);
    db.prepare(
      `insert into tunnel_config
        (id, tunnel_id, binary_path, runtime_credential_set_id, profile_name, status, last_error_category, updated_at)
       values ('primary', 'tunnel_00000000000000000000000000000000', '/old/bin/tunnel-client', 'tunnel-cs', 'apiunicon-local',
         'stopped', null, ?)`,
    ).run(NOW);
    const linkToken = newLinkToken();
    db.prepare(
      `insert into connection_action_links (token_hash, connection_id, action, expires_at, used_at, created_at)
       values (?, 'conn1', 'delete', '2999-01-01T00:00:00.000Z', null, ?)`,
    ).run(tokenHash(linkToken), NOW);

    migrateDatabase(db);

    expect(columns(db, "execution_audits")).toEqual([
      "id", "connection_id", "adapter_id", "adapter_version", "operation_id", "started_at", "duration_ms", "http_status",
      "outcome", "error_category",
    ]);
    expect(columns(db, "tunnel_config")).toEqual([
      "id", "tunnel_id", "runtime_credential_set_id", "profile_name", "status", "last_error_category", "updated_at",
    ]);
    expect(columns(db, "connection_action_links")).toEqual(["token_hash", "connection_id", "action", "expires_at", "created_at"]);
    expect(new AuditRepository(db).recent("conn1", 10)).toEqual([{
      id: "audit-1", connectionId: "conn1", adapterId: "a1", adapterVersion: 2, operationId: "list_orders", startedAt: NOW,
      durationMs: 12, httpStatus: 200, outcome: "success", errorCategory: null,
    }]);
    expect(new TunnelRepository(db).get()).toEqual({
      tunnelId: "tunnel_00000000000000000000000000000000", runtimeCredentialSetId: "tunnel-cs", profileName: "apiunicon-local",
      status: "stopped", lastErrorCategory: null, updatedAt: NOW,
    });
    expect(new ConnectionActionLinkRepository(db).verify("conn1", "delete", linkToken)).toBe(true);

    // The second run changes nothing.
    const tables = ["execution_audits", "tunnel_config", "connection_action_links"];
    const before = tables.map((table) => db.prepare(`select * from ${table}`).all());
    migrateDatabase(db);
    expect(tables.map((table) => db.prepare(`select * from ${table}`).all())).toEqual(before);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("adds read approvals to the previous version's database, approving once only the reads of unmodified catalog copies", () => {
    // The previous version's database: everything but the table of read approvals, and no version kept.
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    db.exec("drop table read_approvals");
    db.pragma("user_version = 0");
    db.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)").run(NOW, NOW);
    db.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
    const postRead: AdapterOperation = { id: "report", description: "Report", risk: "read", method: "POST", path: "/report", input: {}, documentationRefs: [] };
    const dsl: AdapterDsl = {
      schemaVersion: 1,
      baseOrigins: ["https://api.s1.test"],
      credentialBindings: [],
      operations: [postRead, { ...postRead, id: "orders", method: "GET", path: "/orders" }, { ...postRead, id: "ship", risk: "write", path: "/ship" }],
    };
    const adapter = db.prepare(
      `insert into adapters (id, slug, display_name, documentation_source_id, visibility, status, version, dsl_json,
         catalog_entry_id, catalog_version, created_at, updated_at)
       values (?, ?, 'Seller', 's1', 'private', 'working', ?, ?, ?, ?, ?, ?)`,
    );
    adapter.run("copy", "copy", 1, JSON.stringify(dsl), "entry-1", 3, NOW, NOW);
    adapter.run("edited-copy", "edited-copy", 2, JSON.stringify(dsl), "entry-1", 3, NOW, NOW);
    adapter.run("own", "own", 1, JSON.stringify(dsl), null, null, NOW, NOW);
    adapter.run("broken-copy", "broken-copy", 1, "not json", "entry-1", 3, NOW, NOW);
    const connection = db.prepare(
      `insert into connections (id, label, adapter_id, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at)
       values (?, ?, ?, 's1', '["https://api.s1.test"]', 'cs1', ?, ?)`,
    );
    for (const id of ["copy", "edited-copy", "own", "broken-copy"]) connection.run(`conn-${id}`, id, id, NOW, NOW);

    migrateDatabase(db);

    expect(columns(db, "read_approvals")).toEqual(["connection_id", "form_hash", "source", "approved_at"]);
    expect(db.prepare("select connection_id, form_hash, source from read_approvals").all()).toEqual([
      { connection_id: "conn-copy", form_hash: readForm(dsl, postRead), source: "catalog" },
    ]);
    const approvals = new ReadApprovalRepository(db);
    expect(approvals.approves("conn-copy", dsl, postRead)).toBe(true);
    expect(approvals.approves("conn-own", dsl, postRead)).toBe(false);

    // The second run changes nothing, not even for a copy the person has not approved anything on since, and neither
    // does the same step when a database of the previous version is opened again.
    db.prepare("delete from read_approvals").run();
    migrateDatabase(db);
    db.pragma("user_version = 0");
    migrateDatabase(db);
    expect(count(db, "read_approvals")).toBe(0);
    expect(count(db, "connections")).toBe(4);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("creates a new database with read approvals, erased with their connection", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    expect(columns(db, "read_approvals")).toEqual(["connection_id", "form_hash", "source", "approved_at"]);
    db.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)").run(NOW, NOW);
    db.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
    db.prepare("insert into connections (id, label, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at) values ('conn1', 'Seller', 's1', '[]', 'cs1', ?, ?)")
      .run(NOW, NOW);
    const approvals = new ReadApprovalRepository(db);
    approvals.record("conn1", ["a".repeat(64)], "person");
    approvals.record("conn1", ["a".repeat(64)], "catalog");
    expect(db.prepare("select source from read_approvals").all()).toEqual([{ source: "person" }]);
    expect(() => db.prepare("insert into read_approvals values ('conn1', 'b', 'assistant', ?)").run(NOW)).toThrow(/CHECK/u);

    db.prepare("delete from connections where id = 'conn1'").run();
    expect(count(db, "read_approvals")).toBe(0);
    db.close();
  });

  it("creates a new database without the columns nothing uses", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);

    expect(columns(db, "execution_audits")).not.toContain("adapter_changed");
    expect(columns(db, "tunnel_config")).not.toContain("binary_path");
    expect(columns(db, "connection_action_links")).not.toContain("used_at");
    db.close();
  });
});
