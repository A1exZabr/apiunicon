import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureManagedState } from "../../src/bootstrap/state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryStateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "apiunicon-state-"));
  temporaryDirectories.push(directory);
  return join(directory, "managed");
}

describe("managed local state", () => {
  it("creates persistent private state and a stable encryption key", () => {
    const stateDirectory = temporaryStateDirectory();

    const first = ensureManagedState({ APIUNICON_HOME: stateDirectory });
    const second = ensureManagedState({ APIUNICON_HOME: stateDirectory });

    expect(first.stateDir).toBe(stateDirectory);
    expect(first.dbPath).toBe(join(stateDirectory, "apiunicon.sqlite"));
    expect(first.binDir).toBe(join(stateDirectory, "bin"));
    expect(first.masterKey).toHaveLength(32);
    expect(second.masterKey).toEqual(first.masterKey);
    expect(readFileSync(first.masterKeyPath)).toEqual(first.masterKey);
    expect(statSync(first.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(first.binDir).mode & 0o777).toBe(0o700);
    expect(statSync(first.masterKeyPath).mode & 0o777).toBe(0o600);
    // The local MCP endpoint's token is made once too, and the setup token has its place beside it.
    expect(first.mcpToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.mcpToken).toBe(first.mcpToken);
    expect(statSync(join(stateDirectory, "mcp.token")).mode & 0o777).toBe(0o600);
    expect(first.setupTokenPath).toBe(join(stateDirectory, "setup.token"));
  });

  it("refuses a malformed MCP token instead of replacing it", () => {
    const stateDirectory = temporaryStateDirectory();
    ensureManagedState({ APIUNICON_HOME: stateDirectory });
    writeFileSync(join(stateDirectory, "mcp.token"), "short");

    expect(() => ensureManagedState({ APIUNICON_HOME: stateDirectory })).toThrow(/MCP token .* must be 43 base64url characters/u);
    expect(readFileSync(join(stateDirectory, "mcp.token"), "utf8")).toBe("short");
  });

  it("rejects an existing malformed key instead of replacing it", () => {
    const stateDirectory = temporaryStateDirectory();
    const first = ensureManagedState({ APIUNICON_HOME: stateDirectory });
    rmSync(first.masterKeyPath);
    const malformed = Buffer.alloc(7, 1);
    writeFileSync(first.masterKeyPath, malformed, { mode: 0o600 });

    expect(() => ensureManagedState({ APIUNICON_HOME: stateDirectory })).toThrow(
      /exactly 32 bytes/,
    );
  });

  it("refuses a folder that holds files of its own, and leaves its mode alone", () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-state-"));
    temporaryDirectories.push(parent);
    const documents = join(parent, "Documents");
    mkdirSync(documents, { mode: 0o755 });
    chmodSync(documents, 0o755);
    writeFileSync(join(documents, "taxes.pdf"), "not APIUniCon's");

    expect(() => ensureManagedState({ APIUNICON_HOME: documents }))
      .toThrow(`${documents} already holds files that are not APIUniCon's (taxes.pdf).`);
    expect(statSync(documents).mode & 0o777).toBe(0o755);
    expect(readdirSync(documents)).toEqual(["taxes.pdf"]);
  });

  it("takes a folder that holds its master key, whatever else is beside it", () => {
    const stateDirectory = temporaryStateDirectory();
    const first = ensureManagedState({ APIUNICON_HOME: stateDirectory });
    // A backup of the database, and a database of a development run named by APIUNICON_DB_PATH.
    for (const file of ["apiunicon.sqlite.bak", "dev.sqlite", "notes.txt"]) writeFileSync(join(stateDirectory, file), "");

    const second = ensureManagedState({ APIUNICON_HOME: stateDirectory });

    expect(second.masterKey).toEqual(first.masterKey);
    expect(second.mcpToken).toBe(first.mcpToken);
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
  });

  it("refuses a folder with files that are not its own when it holds no master key, even with its own files beside them", () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-state-"));
    temporaryDirectories.push(parent);
    const folder = join(parent, "copied");
    mkdirSync(join(folder, "logs"), { recursive: true, mode: 0o755 });
    chmodSync(folder, 0o755);
    for (const file of ["apiunicon.sqlite", "mcp.token", "report.xlsx"]) writeFileSync(join(folder, file), "");

    expect(() => ensureManagedState({ APIUNICON_HOME: folder }))
      .toThrow(`${folder} already holds files that are not APIUniCon's (report.xlsx).`);
    expect(statSync(folder).mode & 0o777).toBe(0o755);
    expect(readdirSync(folder).sort()).toEqual(["apiunicon.sqlite", "logs", "mcp.token", "report.xlsx"]);
  });

  it("takes an empty folder, and a state folder with its logs and journal files", () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-state-"));
    temporaryDirectories.push(parent);
    const empty = join(parent, "empty");
    mkdirSync(empty);
    expect(ensureManagedState({ APIUNICON_HOME: empty }).stateDir).toBe(empty);

    // As the service installer leaves it before the first start, and as a running service does.
    const service = join(parent, "service");
    mkdirSync(join(service, "logs"), { recursive: true });
    expect(ensureManagedState({ APIUNICON_HOME: service }).stateDir).toBe(service);
    for (const file of ["apiunicon.sqlite-wal", "apiunicon.sqlite-shm", ".DS_Store", "setup.token"]) writeFileSync(join(service, file), "");
    mkdirSync(join(service, "tunnel-client"));
    expect(ensureManagedState({ APIUNICON_HOME: service }).stateDir).toBe(service);
    expect(statSync(service).mode & 0o777).toBe(0o700);
  });
});
