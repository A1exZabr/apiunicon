import type Database from "better-sqlite3";

// The sealed key values: encrypted bytes, which can hold any short string by chance.
const SEALED_COLUMNS = new Set(["credential_fields.ciphertext", "credential_fields.nonce", "credential_fields.auth_tag"]);
// Digests and salts of tokens, passwords and documents: no readable text either.
const DIGEST_COLUMN = /(?:_hash|_salt|_fingerprint)$|^sha256$/u;

export type ReadableColumn = { table: string; column: string };

// Every column of the database that holds readable text: each table, the full-text index of the documentation included,
// and each column of it but the sealed key values and digests. The index's own internal tables are left out, since the
// index itself is read. The list comes from the database, so a table or a column added later is in it too.
export function readableColumns(db: Database.Database): ReadableColumn[] {
  const tables = db.prepare(
    "select name, sql from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  ).all() as Array<{ name: string; sql: string | null }>;
  const virtual = tables.filter(({ sql }) => /^CREATE VIRTUAL TABLE/iu.test(sql ?? "")).map(({ name }) => name);
  const internal = (name: string) => virtual.some((table) => name.startsWith(`${table}_`));
  return tables.filter(({ name }) => !internal(name)).flatMap(({ name }) =>
    (db.prepare(`pragma table_info(${JSON.stringify(name)})`).all() as Array<{ name: string }>)
      .filter(({ name: column }) => !SEALED_COLUMNS.has(`${name}.${column}`) && !DIGEST_COLUMN.test(column))
      .map(({ name: column }) => ({ table: name, column })));
}

// Whether a stored value holds the fragment: the value as it is stored and, when it is JSON, every string in it, key or
// value, so that a fragment with a quote or a backslash, which JSON writes escaped, is found too.
function holds(value: unknown, fragment: string, bytes: Buffer): boolean {
  if (Buffer.isBuffer(value)) return value.includes(bytes);
  if (typeof value !== "string") return false;
  if (value.includes(fragment)) return true;
  if (!/^\s*[[{"]/u.test(value)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  const inside = (item: unknown): boolean => {
    if (typeof item === "string") return item.includes(fragment);
    if (Array.isArray(item)) return item.some(inside);
    if (item !== null && typeof item === "object") {
      return Object.entries(item).some(([key, entry]) => key.includes(fragment) || inside(entry));
    }
    return false;
  };
  return inside(parsed);
}

export type FragmentFinding = ReadableColumn & { rows: number };

// Where the fragment of a key appears in the readable columns (readableColumns), and in how many rows of each.
export function findKeyFragment(db: Database.Database, fragment: string): FragmentFinding[] {
  if (fragment === "") throw new Error("The fragment to look for is empty");
  const bytes = Buffer.from(fragment, "utf8");
  const columns = new Map<string, string[]>();
  for (const { table, column } of readableColumns(db)) columns.set(table, [...(columns.get(table) ?? []), column]);
  const findings: FragmentFinding[] = [];
  for (const [table, names] of columns) {
    const rows = new Map<string, number>();
    const select = db.prepare(`select ${names.map((name) => JSON.stringify(name)).join(", ")} from ${JSON.stringify(table)}`);
    for (const row of select.iterate() as Iterable<Record<string, unknown>>) {
      for (const name of names) if (holds(row[name], fragment, bytes)) rows.set(name, (rows.get(name) ?? 0) + 1);
    }
    for (const name of names) {
      const count = rows.get(name);
      if (count !== undefined) findings.push({ table, column: name, rows: count });
    }
  }
  return findings;
}
