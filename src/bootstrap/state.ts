import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { createFileOnce, DRAFT_NAME } from "./files.js";
import { refuseRealHomeUnderTests } from "./real-home-guard.js";

export type ManagedState = {
  stateDir: string;
  dbPath: string;
  masterKeyPath: string;
  masterKey: Buffer;
  binDir: string;
  // The bearer token of the local HTTP MCP endpoint (see registerHttpMcpRoute), made once, mode 0600.
  mcpToken: string;
  // Where the token for creating the administrator is kept while there is none (see SetupToken).
  setupTokenPath: string;
};

// What APIUniCon keeps in its state folder: the database and its journal files, the keys and tokens (each with its
// draft while it is written, see createFileOnce), the tunnel client and its profile, and the service logs. macOS may add
// .DS_Store.
const KEY_FILES = ["master.key", "mcp.token", "setup.token"];
const STATE_ENTRIES = new Set([
  ".DS_Store", "apiunicon.sqlite", "apiunicon.sqlite-journal", "apiunicon.sqlite-shm", "apiunicon.sqlite-wal", "bin",
  "logs", "tunnel-client", ...KEY_FILES,
]);
const isKeyDraft = (entry: string): boolean => DRAFT_NAME.test(entry) && KEY_FILES.includes(entry.replace(DRAFT_NAME, ""));

// The state folder is made readable by this user alone. A folder with APIUniCon's master key is APIUniCon's, whatever else
// was put beside it (a copy of the database, another database named by APIUNICON_DB_PATH). Without the key, a folder that
// holds anything but APIUniCon's own files (APIUNICON_HOME set to ~/Documents, say) is not APIUniCon's, and closing it
// would lock its other users out, so it is refused instead. Its own files without the key are a folder APIUniCon has not
// started in yet, such as the logs folder the service installer makes before the first start.
function assertStateFolder(path: string): void {
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (entries.includes("master.key")) return;
  const foreign = entries.filter((entry) => !STATE_ENTRIES.has(entry) && !isKeyDraft(entry));
  if (foreign.length === 0) return;
  const named = foreign.slice(0, 3).join(", ");
  throw new Error(
    `${path} already holds files that are not APIUniCon's (${foreign.length > 3 ? `${named} and more` : named}). APIUniCon keeps its keys in a folder of its own and makes it readable by you alone, so it does not use this one. Set APIUNICON_HOME to a new or empty folder, or leave it unset for ~/.apiunicon.`,
  );
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

// The file's contents, or null when there is no such file.
function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Two processes that start at once, such as the service and an assistant's stdio process at sign-in, get the same key:
// it appears whole or not at all (createFileOnce), and the one that was second reads the first one's.
function readOrCreateMasterKey(path: string): Buffer {
  let key = readIfPresent(path);
  if (key === null) {
    const generated = randomBytes(32);
    key = createFileOnce(path, generated) ? generated : readFileSync(path);
  }
  if (key.length !== 32) {
    throw new Error(`Managed master key at ${path} must contain exactly 32 bytes`);
  }
  chmodSync(path, 0o600);
  return key;
}

// The MCP token: 32 random bytes in base64url, on one line.
const MCP_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

// Made once, like the master key. A file that holds something else was changed by hand, never left half written by a
// start, so it is refused rather than replaced.
function readOrCreateMcpToken(path: string): string {
  let token = readIfPresent(path)?.toString("utf8").trim() ?? null;
  if (token === null) {
    const generated = randomBytes(32).toString("base64url");
    token = createFileOnce(path, `${generated}\n`) ? generated : readFileSync(path, "utf8").trim();
  }
  if (!MCP_TOKEN_SHAPE.test(token)) {
    throw new Error(
      `The MCP token at ${path} must be 43 base64url characters. Removing the file makes APIUniCon create a new token at its next start; every MCP client set up with the old token then has to be set up again with the new one.`,
    );
  }
  chmodSync(path, 0o600);
  return token;
}

export const DATABASE_FILE = "apiunicon.sqlite";

// The state folder: APIUNICON_HOME, or ~/.apiunicon.
export function stateFolder(env: NodeJS.ProcessEnv): string {
  return resolve(env.APIUNICON_HOME ?? join(env.HOME ?? homedir(), ".apiunicon"));
}

export function ensureManagedState(env: NodeJS.ProcessEnv): ManagedState {
  const stateDir = stateFolder(env);
  // The guard runs before any side effect.
  refuseRealHomeUnderTests(stateDir, "a state folder");
  assertStateFolder(stateDir);
  const binDir = join(stateDir, "bin");
  const masterKeyPath = join(stateDir, "master.key");
  ensurePrivateDirectory(stateDir);
  ensurePrivateDirectory(binDir);
  return {
    stateDir,
    dbPath: join(stateDir, DATABASE_FILE),
    masterKeyPath,
    masterKey: readOrCreateMasterKey(masterKeyPath),
    binDir,
    mcpToken: readOrCreateMcpToken(join(stateDir, "mcp.token")),
    setupTokenPath: join(stateDir, "setup.token"),
  };
}
