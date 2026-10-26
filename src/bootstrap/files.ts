import { randomUUID } from "node:crypto";
import { linkSync, rmSync, writeFileSync } from "node:fs";

// The names createFileOnce writes a file under before it is in place.
export const DRAFT_NAME = /\.[0-9a-f-]{36}\.tmp$/u;

// Creates the file with these contents, readable by this user alone, unless it exists. The contents are written in full
// under another name beside it and then linked into place, which fails when the file exists, so a process that reads the
// file at the same moment finds it whole or not at all, never empty or half written. False when the file existed: another
// process was first, and the file it made is the one to read.
export function createFileOnce(path: string, contents: string | Buffer): boolean {
  const draft = `${path}.${randomUUID()}.tmp`;
  writeFileSync(draft, contents, { flag: "wx", mode: 0o600 });
  try {
    linkSync(draft, path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(draft, { force: true });
  }
}
