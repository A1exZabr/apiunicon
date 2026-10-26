import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ConnectionActionLinkRepository } from "../../src/connections/action-links.js";
import { migrateDatabase, migrateDatabaseWith, openDatabase, SCHEMA_VERSION, type SchemaPlan } from "../../src/db/database.js";

type Db = ReturnType<typeof openDatabase>;

// The first released schema, the oldest a database can be upgraded from.
const FIRST_RELEASE = readFileSync(new URL("../fixtures/schema-before-documents.sql", import.meta.url), "utf8");
// The last release before schema versions were kept, as sqlite_master holds it.
const LAST_UNVERSIONED = readFileSync(new URL("../fixtures/schema-with-unused-columns.sql", import.meta.url), "utf8");
// The schema at version 1, which a database made before versions were kept is brought to.
const VERSION_1 = readFileSync(new URL("../../src/db/schema-v1.sql", import.meta.url), "utf8");
// connection_action_links as the release that added it created it: only the action 'delete' was allowed.
const DELETE_ONLY_ACTION_LINKS = `CREATE TABLE connection_action_links (
  token_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('delete')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
)`;
// change_requests as the release that added changes created it, before confirmation settings and the chat card.
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
);
CREATE INDEX idx_change_requests_connection ON change_requests(connection_id, created_at DESC)`;
const NOW = "2026-10-01T00:00:00.000Z";

// Everything about each table and index that the code relies on: columns with their type, NOT NULL, default and key
// position, foreign keys, and indexes with their columns. Columns are compared by name, since a column a release added
// with ALTER TABLE stands last in an upgraded table. CHECK constraints are compared through the table's SQL, with
// spacing and line breaks made equal.
function shape(db: Db) {
  const objects = db.prepare(
    "select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type, name",
  ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tables = objects.filter(({ type }) => type === "table").map(({ name, sql }) => {
    const columns = (db.prepare(`pragma table_info(${name})`).all() as Array<Record<string, unknown>>)
      .map(({ name: column, type, notnull, dflt_value, pk }) => ({ column, type, notnull, dflt_value, pk }))
      .sort((left, right) => String(left.column).localeCompare(String(right.column)));
    const foreignKeys = (db.prepare(`pragma foreign_key_list(${name})`).all() as Array<Record<string, unknown>>)
      .map(({ table, from, to, on_update, on_delete, match }) => ({ table, from, to, on_update, on_delete, match }))
      .sort((left, right) => String(left.from).localeCompare(String(right.from)));
    const indexes = (db.prepare(`pragma index_list(${name})`).all() as Array<{ name: string; unique: number; origin: string; partial: number }>)
      .map((index) => ({
        ...index,
        columns: (db.prepare(`pragma index_xinfo(${JSON.stringify(index.name)})`).all() as Array<Record<string, unknown>>)
          .filter(({ key }) => key === 1)
          .map(({ name: column, desc }) => ({ column, desc })),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const checks = [...(sql ?? "").matchAll(/CHECK\s*\((?:[^()]|\([^()]*\))*\)/giu)].map(([check]) => check.replace(/\s+/gu, " ")).sort();
    return { name, columns, foreignKeys, indexes, checks };
  });
  const indexes = objects.filter(({ type }) => type === "index").map(({ name, tbl_name, sql }) => ({
    name, table: tbl_name, sql: sql?.replace(/\s+/gu, " ").replace(/ IF NOT EXISTS/iu, ""),
  }));
  return { tables, indexes, triggers: objects.filter(({ type }) => type === "trigger" || type === "view") };
}

function fresh(): Db {
  const db = openDatabase(":memory:");
  migrateDatabase(db);
  return db;
}

function upgradedFrom(schema: string, prepare?: (db: Db) => void, migrate: (db: Db) => void = migrateDatabase): Db {
  const db = openDatabase(":memory:");
  db.exec(schema);
  prepare?.(db);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  migrate(db);
  return db;
}

describe("the schema of a new database and of an upgraded one", () => {
  it("is schema.sql for a new database, at the current version", () => {
    const db = fresh();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const fromFile = openDatabase(":memory:");
    fromFile.exec(readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8"));
    expect(shape(db)).toEqual(shape(fromFile));
    db.close();
    fromFile.close();
  });

  it.each([
    ["the first release", FIRST_RELEASE, undefined],
    ["the release that added changes", FIRST_RELEASE, (db: Db) => {
      db.exec(CHANGE_REQUESTS_BEFORE_CONFIRMATION);
      db.exec(DELETE_ONLY_ACTION_LINKS);
    }],
    ["the last release before versions were kept", LAST_UNVERSIONED, undefined],
    ["a database whose action links allow only deletion", LAST_UNVERSIONED, (db: Db) => {
      db.exec("drop table connection_action_links");
      db.exec(DELETE_ONLY_ACTION_LINKS);
    }],
  ] as const)("is the same, table by table, after an upgrade from %s", (_name, schema, prepare) => {
    const expected = fresh();
    const upgraded = upgradedFrom(schema, prepare);

    const want = shape(expected);
    const got = shape(upgraded);
    expect(got.tables.map(({ name }) => name)).toEqual(want.tables.map(({ name }) => name));
    for (const table of want.tables) expect(got.tables.find(({ name }) => name === table.name), table.name).toEqual(table);
    expect(got.indexes).toEqual(want.indexes);
    expect(got.triggers).toEqual(want.triggers);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(upgraded.pragma("foreign_key_check")).toEqual([]);

    // A second run changes nothing.
    migrateDatabase(upgraded);
    expect(shape(upgraded)).toEqual(got);
    expect.soft(upgraded.pragma("integrity_check", { simple: true })).toBe("ok");
    expected.close();
    upgraded.close();
  });

  it("keeps the links of a table that allowed only deletion, and takes approval links afterwards", () => {
    const db = upgradedFrom(LAST_UNVERSIONED, (old) => {
      old.exec("drop table connection_action_links");
      old.exec(DELETE_ONLY_ACTION_LINKS);
      old.prepare("insert into documentation_sources values ('s1', 'https://docs.s1.test/', 'https://docs.s1.test', 'ready', null, null, ?, ?)").run(NOW, NOW);
      old.prepare("insert into credential_sets values ('cs1', ?, ?)").run(NOW, NOW);
      old.prepare(
        `insert into connections (id, label, documentation_source_id, allowed_origins_json, credential_set_id, created_at, updated_at)
         values ('conn1', 'Seller', 's1', '[]', 'cs1', ?, ?)`,
      ).run(NOW, NOW);
      old.prepare("insert into connection_action_links values ('hash-1', 'conn1', 'delete', '2999-01-01T00:00:00.000Z', null, ?)").run(NOW);
    });

    expect(db.prepare("select token_hash, connection_id, action from connection_action_links").all())
      .toEqual([{ token_hash: "hash-1", connection_id: "conn1", action: "delete" }]);
    const issued = new ConnectionActionLinkRepository(db).issue("conn1", "approve_reads");
    expect(new ConnectionActionLinkRepository(db).verify("conn1", "approve_reads", issued.token)).toBe(true);
    // Still erased with its connection.
    db.prepare("delete from connections where id = 'conn1'").run();
    expect(db.prepare("select count(*) as count from connection_action_links").get()).toEqual({ count: 0 });
    db.close();
  });

  it("leaves a database of a newer version as it is", () => {
    const db = fresh();
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.exec("drop index idx_jobs_status");
    migrateDatabase(db);
    expect(db.prepare("select 1 from sqlite_master where name = 'idx_jobs_status'").get()).toBeUndefined();
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 1);
    db.close();
  });

  it("is schema-v1.sql at version 1, the base the steps start from", () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    const base = openDatabase(":memory:");
    migrateDatabaseWith(base, { schema: VERSION_1, base: VERSION_1, version: 1, upgrades: {} });
    const fromFile = openDatabase(":memory:");
    fromFile.exec(VERSION_1);
    expect(shape(base)).toEqual(shape(fromFile));
    expect(base.pragma("user_version", { simple: true })).toBe(1);
    base.close();
    fromFile.close();
  });

  // A next version made as a change of the schema is made: the columns in the schema of a new database, and the step
  // that adds them to a database of the version before. One goes to a table every release had, with an index, and one to
  // a table that a database made before versions were kept may not have yet.
  describe("with a next version that adds columns", () => {
    const added: string[] = [];
    const next: SchemaPlan = {
      schema: VERSION_1
        .replace("  confirm_changes INTEGER NOT NULL DEFAULT 1\n", "  confirm_changes INTEGER NOT NULL DEFAULT 1,\n  note TEXT\n")
        .replace("  approved_at TEXT NOT NULL,\n", "  approved_at TEXT NOT NULL,\n  note TEXT,\n")
        .concat("CREATE INDEX IF NOT EXISTS idx_connections_note ON connections(note);\n"),
      base: VERSION_1,
      version: 2,
      upgrades: {
        1: (db) => {
          added.push("step 1");
          db.exec("alter table connections add column note TEXT");
          db.exec("alter table read_approvals add column note TEXT");
          db.exec("CREATE INDEX IF NOT EXISTS idx_connections_note ON connections(note)");
        },
      },
    };

    it("makes a new database at that version without the step, and brings older ones up by it", () => {
      expect(next.schema).toContain("  note TEXT\n);\n\nCREATE TABLE IF NOT EXISTS connection_drafts");
      expect(next.schema).toContain("  approved_at TEXT NOT NULL,\n  note TEXT,\n");
      const made = openDatabase(":memory:");
      migrateDatabaseWith(made, next);
      expect(added).toEqual([]);

      const atVersion1 = openDatabase(":memory:");
      migrateDatabaseWith(atVersion1, { ...next, schema: VERSION_1, version: 1 });
      migrateDatabaseWith(atVersion1, next);
      expect(added).toEqual(["step 1"]);

      const unversioned = upgradedFrom(LAST_UNVERSIONED, undefined, (db) => migrateDatabaseWith(db, next));
      expect(added).toEqual(["step 1", "step 1"]);

      const want = shape(made);
      expect(want.tables.find(({ name }) => name === "connections")?.indexes.map(({ name }) => name)).toContain("idx_connections_note");
      for (const db of [made, atVersion1, unversioned]) {
        expect(db.pragma("user_version", { simple: true })).toBe(2);
        expect(shape(db)).toEqual(want);
        db.close();
      }
    });
  });

  it("runs the steps of an upgrade in one transaction", () => {
    const db = openDatabase(":memory:");
    db.exec(LAST_UNVERSIONED);
    // A table in the way of the step that makes connection_action_links again: that step fails half way.
    db.exec("create table connection_action_links_before (x TEXT)");
    db.exec("drop table connection_action_links");
    db.exec(DELETE_ONLY_ACTION_LINKS);
    expect(() => migrateDatabase(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(db.prepare("select sql from sqlite_master where name = 'connection_action_links'").get())
      .toEqual({ sql: DELETE_ONLY_ACTION_LINKS });
    db.close();
  });
});
