import Database from "better-sqlite3";
import { chmodSync, readFileSync } from "node:fs";

import { refuseRealHomeUnderTests } from "../bootstrap/real-home-guard.js";
import { approveExistingCatalogCopies } from "../reads/repository.js";

export function openDatabase(path: string): Database.Database {
  if (path !== ":memory:") refuseRealHomeUnderTests(path, "a database");
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  // Deleted rows are overwritten with zeros, so erased keys and connections do not linger in free pages of the file.
  db.pragma("secure_delete = ON");
  if (path !== ":memory:") {
    chmodSync(path, 0o600);
    db.pragma("journal_mode = WAL");
    // A journal left behind by a crash may still hold erased values.
    flushErasedData(db);
  }
  return db;
}

const FLUSH_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000] as const;
const pendingFlushes = new WeakMap<Database.Database, NodeJS.Timeout>();

// Copies the journal into the main file and truncates it. It cannot while another connection still reads an older
// snapshot or this one is inside a transaction; it then waits only briefly, because callers are request handlers.
function truncateJournal(db: Database.Database): boolean {
  if (!db.open || db.inTransaction) return false;
  try {
    const previousTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    db.pragma("busy_timeout = 200");
    try {
      const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      return result?.busy === 0;
    } finally {
      db.pragma(`busy_timeout = ${previousTimeout}`);
    }
  } catch {
    return false;
  }
}

function retryFlushLater(db: Database.Database, attempt: number): void {
  const delay = FLUSH_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    pendingFlushes.delete(db);
    process.emitWarning("Erased data may remain in the database journal until the next restart");
    return;
  }
  const timer = setTimeout(() => {
    if (!db.open) {
      pendingFlushes.delete(db);
      return;
    }
    if (truncateJournal(db)) pendingFlushes.delete(db);
    else retryFlushLater(db, attempt + 1);
  }, delay);
  timer.unref();
  pendingFlushes.set(db, timer);
}

// secure_delete zeroes freed pages in the main file, but in WAL mode the journal still holds the old page images until
// the next checkpoint. After erasing keys the journal is copied back and truncated so the old values are gone. When
// that is not possible right now, it is retried a few times in the background. Returns whether the journal is empty.
export function flushErasedData(db: Database.Database): boolean {
  if (db.memory) return true;
  if (truncateJournal(db)) {
    const pending = pendingFlushes.get(db);
    if (pending !== undefined) clearTimeout(pending);
    pendingFlushes.delete(db);
    return true;
  }
  if (db.open && !pendingFlushes.has(db)) retryFlushLater(db, 0);
  return false;
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table) !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const existing = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return existing.some(({ name }) => name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (!hasColumn(db, table, column)) db.exec(`alter table ${table} add column ${column} ${definition}`);
}

function dropColumnIfPresent(db: Database.Database, table: string, column: string): void {
  if (hasColumn(db, table, column)) db.exec(`alter table ${table} drop column ${column}`);
}

// The version of the schema in schema.sql, kept in the database's user_version; a database made before versions were
// kept reads 0. The order kept (migrateDatabaseWith): a new database is made from schema.sql at this version and runs no
// step. A database made before versions were kept is first brought to version 1, the frozen schema-v1.sql. A database
// below this version then runs the steps of UPGRADES one by one, from its own version. So a change of the schema goes into
// schema.sql and, as the step from the version before, into UPGRADES, and raises this by one: the step never meets a
// database that schema.sql made, and an old database never gets a table or an index of schema.sql before its steps.
export const SCHEMA_VERSION = 1;

// The statements of a schema file: its tables, and its indexes, which may name a column an older table gets only on its
// way up. The file has one statement per ";" at the end of a line, and comment lines of its own.
function schemaStatements(schema: string): { tables: Map<string, string>; indexes: string[] } {
  const tables = new Map<string, string>();
  const indexes: string[] = [];
  for (const part of schema.split(/;[ \t]*\r?\n/u)) {
    const statement = part.split(/\r?\n/u).filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();
    if (statement === "") continue;
    const table = /^CREATE (?:VIRTUAL )?TABLE IF NOT EXISTS (\w+)/iu.exec(statement)?.[1];
    if (table !== undefined) tables.set(table, statement);
    else if (/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS /iu.test(statement)) indexes.push(statement);
    else throw new Error(`The schema holds a statement that is neither a table nor an index: ${statement.slice(0, 60)}`);
  }
  return { tables, indexes };
}

// Brings a database made before versions were kept, by any earlier release, to version 1, the schema of schema-v1.sql
// (base). Each step looks at what the database has and does nothing when it is done already, so a database part of the
// way there gets only the rest.
function upgradeUnversioned(db: Database.Database, base: string): void {
  const { tables, indexes } = schemaStatements(base);
  const readApprovalsExisted = hasTable(db, "read_approvals");
  // The first releases of connection_action_links allowed only the action 'delete'. A CHECK cannot be changed in place,
  // so such a table is made again as version 1 has it, with its rows; nothing refers to it.
  const actionLinks = db.prepare("select sql from sqlite_master where type = 'table' and name = 'connection_action_links'")
    .get() as { sql: string } | undefined;
  if (actionLinks !== undefined && /CHECK\s*\(\s*action\s+IN/iu.test(actionLinks.sql)) {
    db.exec("alter table connection_action_links rename to connection_action_links_before");
    db.exec(tables.get("connection_action_links")!);
    db.exec(`insert into connection_action_links (token_hash, connection_id, action, expires_at, created_at)
      select token_hash, connection_id, action, expires_at, created_at from connection_action_links_before`);
    db.exec("drop table connection_action_links_before");
  }
  // Tables a release added later, made as version 1 has them.
  for (const statement of tables.values()) db.exec(statement);
  addColumnIfMissing(db, "documentation_chunks", "document_id", "TEXT REFERENCES documentation_documents(id) ON DELETE CASCADE");
  addColumnIfMissing(db, "connection_drafts", "help_reason", "TEXT");
  addColumnIfMissing(db, "connection_drafts", "provenance_summary_json", "TEXT");
  addColumnIfMissing(db, "adapters", "catalog_entry_id", "TEXT");
  addColumnIfMissing(db, "adapters", "catalog_version", "INTEGER");
  // Changing data through the connection is off until the person turns it on for that connection.
  addColumnIfMissing(db, "connections", "writes_enabled", "INTEGER NOT NULL DEFAULT 0");
  // Every change waits for the person until they turn confirmation off for the connection.
  addColumnIfMissing(db, "connections", "confirm_changes", "INTEGER NOT NULL DEFAULT 1");
  // How a change was let through: by the person on its page, or at once with confirmation off.
  addColumnIfMissing(db, "change_requests", "confirmation", "TEXT NOT NULL DEFAULT 'person' CHECK (confirmation IN ('person', 'none'))");
  // The chat card's own token for the change, only its hash: none for a change that no card shows, and none once it
  // was used or revoked.
  addColumnIfMissing(db, "change_requests", "card_token_hash", "TEXT");
  addColumnIfMissing(db, "change_requests", "card_failures", "INTEGER NOT NULL DEFAULT 0");
  // The person confirmed it in the chat card rather than on its page. Stored beside confirmation = 'person', since
  // that column's CHECK cannot change without rebuilding the table.
  addColumnIfMissing(db, "change_requests", "via_card", "INTEGER NOT NULL DEFAULT 0 CHECK (via_card IN (0, 1))");
  // Columns of earlier releases that nothing uses: whether an audited call changed the adapter, where the tunnel client
  // was when the tunnel was configured, and when a connection's action link was used. No index, trigger or other column
  // refers to them.
  dropColumnIfPresent(db, "execution_audits", "adapter_changed");
  dropColumnIfPresent(db, "tunnel_config", "binary_path");
  dropColumnIfPresent(db, "connection_action_links", "used_at");
  for (const statement of indexes) db.exec(statement);
  // Drafts that needed help before help_reason existed get the reason they stopped. Only rows without a reason are
  // touched.
  db.exec(`UPDATE connection_drafts SET help_reason = CASE
      WHEN NOT json_valid(discovery_json) THEN 'documentation_unavailable'
      WHEN coalesce(json_array_length(discovery_json, '$.unsupportedAuthMethods'), 0) > 0 THEN 'unsupported_auth'
      ELSE 'documentation_unavailable'
    END
    WHERE status = 'needs_help' AND help_reason IS NULL`);
  // Reads sent with POST run only once approved. Connections bound to a catalog copy before that get the catalog's
  // approval of its reads once, when the table is created, as a connection made from a copy gets it now.
  if (!readApprovalsExisted) approveExistingCatalogCopies(db, new Date());
}

// The step from each version to the next, by the version it starts from. None yet: version 1 is the first one kept.
const UPGRADES: Readonly<Record<number, (db: Database.Database) => void>> = {};

// What a migration brings a database to: the schema now (schema) at its version, the frozen schema of version 1 (base)
// for a database made before versions were kept, and the steps between.
export type SchemaPlan = {
  schema: string;
  base: string;
  version: number;
  upgrades: Readonly<Record<number, (db: Database.Database) => void>>;
};

// Makes a new database as the plan's schema describes it, or brings an older one to it, in the order SCHEMA_VERSION
// describes. A database of a newer version is left as it is. The transaction takes the write lock before it reads the
// version: two processes that start at once on a new database (the service, and an assistant's stdio process) then take
// turns, and the second finds the work done, where with a read first both would see version 0 and the second could not
// write.
export function migrateDatabaseWith(db: Database.Database, plan: SchemaPlan): void {
  db.transaction(() => {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version >= plan.version) return;
    if (version === 0) {
      const empty = db.prepare("select 1 from sqlite_master where name not like 'sqlite_%' limit 1").get() === undefined;
      if (empty) {
        db.exec(plan.schema);
        db.pragma(`user_version = ${plan.version}`);
        return;
      }
      upgradeUnversioned(db, plan.base);
    }
    for (let from = Math.max(version, 1); from < plan.version; from += 1) {
      const step = plan.upgrades[from];
      if (step === undefined) throw new Error(`No upgrade of the database from version ${from}`);
      step(db);
    }
    db.pragma(`user_version = ${plan.version}`);
  }).immediate();
}

// Makes a new database as schema.sql describes it, or brings an older one to it.
export function migrateDatabase(db: Database.Database): void {
  migrateDatabaseWith(db, {
    schema: readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    base: readFileSync(new URL("./schema-v1.sql", import.meta.url), "utf8"),
    version: SCHEMA_VERSION,
    upgrades: UPGRADES,
  });
}
