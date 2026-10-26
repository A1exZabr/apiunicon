import { describe, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { findKeyFragment, readableColumns } from "../../src/verification/export.js";

describe("the search of verify-secrets", () => {
  const NOW = "2026-10-01T00:00:00.000Z";
  // A part of a key with characters JSON writes escaped.
  const FRAGMENT = 'k3y"part\\7';

  function database() {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    db.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)").run(NOW, NOW);
    db.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
    db.prepare(
      `insert into connections (id, label, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at)
       values ('conn1', 'Seller', 's1', '[]', 'cs1', ?, ?)`,
    ).run(NOW, NOW);
    return db;
  }

  function change(db: ReturnType<typeof openDatabase>, id: string, fields: { args?: unknown; summary?: string; targetUrl?: string; result?: unknown }) {
    db.prepare(
      `insert into change_requests
        (id, token_hash, connection_id, connection_label, adapter_id, adapter_version, operation_id, operation_json, risk,
         method, target_url, args_json, summary, status, created_at, expires_at, result_json)
       values (?, ?, 'conn1', 'Seller', 'a1', 1, 'set_price', '{}', 'write', 'POST', ?, ?, ?, 'succeeded', ?, ?, ?)`,
    ).run(
      id, `hash-${id}`, fields.targetUrl ?? "https://api.s1.test/prices", JSON.stringify(fields.args ?? {}), fields.summary ?? "Set the price",
      NOW, NOW, fields.result === undefined ? null : JSON.stringify(fields.result),
    );
  }

  it("covers every table that keeps readable text, and leaves out sealed keys and digests", () => {
    const db = database();
    const columns = readableColumns(db).map(({ table, column }) => `${table}.${column}`);

    expect(columns).toEqual(expect.arrayContaining([
      "change_requests.args_json", "change_requests.summary", "change_requests.target_url", "change_requests.result_json",
      "change_requests.operation_json", "tunnel_events.message", "app_settings.value_json", "read_approvals.connection_id",
      "documentation_chunks_fts.body", "documentation_chunks.body", "documentation_documents.discovery_json",
      "credential_fields.field_name", "knowledge_events.evidence_json", "adapters.dsl_json", "connection_drafts.discovery_json",
      "execution_audits.error_category", "tunnel_config.tunnel_id", "jobs.error_category",
    ]));
    for (const hidden of [
      "credential_fields.ciphertext", "credential_fields.nonce", "credential_fields.auth_tag", "change_requests.token_hash",
      "change_requests.card_token_hash", "admin_credentials.password_hash", "admin_credentials.password_salt",
      "web_sessions.token_hash", "web_sessions.csrf_token_hash", "read_approvals.form_hash", "documentation_documents.sha256",
    ]) expect(columns).not.toContain(hidden);
    expect(columns.some((column) => column.startsWith("documentation_chunks_fts_"))).toBe(false);
    // Every table but the index's own is searched.
    const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'documentation_chunks_fts_%'").all() as Array<{ name: string }>)
      .map(({ name }) => name).sort();
    expect([...new Set(readableColumns(db).map(({ table }) => table))].sort()).toEqual(tables);
    db.close();
  });

  it("finds the part of a key in the raw value and inside JSON, where it is written escaped", () => {
    const db = database();
    change(db, "c1", { args: { note: `see ${FRAGMENT}` } });
    change(db, "c2", { result: { ok: false, error: { message: `rejected ${FRAGMENT}` } } });
    change(db, "c3", { summary: `Use ${FRAGMENT}` });
    change(db, "c4", { targetUrl: "https://api.s1.test/prices", result: { [`key ${FRAGMENT}`]: 1 } });
    db.prepare("insert into tunnel_events values ('e1', 'error', ?, ?)").run(`tunnel said ${FRAGMENT}`, NOW);
    db.prepare("insert into app_settings values ('note', ?, ?)").run(JSON.stringify({ text: FRAGMENT }), NOW);
    db.prepare("insert into documentation_chunks_fts values ('chunk-1', 's1', 'Auth', ?)").run(`Example key ${FRAGMENT}`);
    // Encrypted bytes and digests are not searched, whatever they hold.
    db.prepare("insert into credential_fields values ('cs1', 'Api-Key', ?, ?, ?)").run(FRAGMENT, FRAGMENT, FRAGMENT);
    // JSON writes the quote and the backslash escaped: only the decoded value holds the part as it was typed.
    expect(db.prepare("select args_json from change_requests where id = 'c1'").pluck().get()).not.toContain(FRAGMENT);

    expect(findKeyFragment(db, FRAGMENT)).toEqual([
      { table: "app_settings", column: "value_json", rows: 1 },
      { table: "change_requests", column: "args_json", rows: 1 },
      { table: "change_requests", column: "summary", rows: 1 },
      { table: "change_requests", column: "result_json", rows: 2 },
      { table: "documentation_chunks_fts", column: "body", rows: 1 },
      { table: "tunnel_events", column: "message", rows: 1 },
    ]);
    expect(findKeyFragment(db, "not stored anywhere")).toEqual([]);
    db.close();
  });
});
