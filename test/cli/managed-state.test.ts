import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { ensureManagedState } from "../../src/bootstrap/state.js";
import { loadConfig } from "../../src/config.js";
import { buildApplication } from "../../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function runInit(parent: string, extraEnv: Record<string, string>) {
  return runCli("init", parent, extraEnv);
}

function runCli(command: string, parent: string, extraEnv: Record<string, string>, options: { args?: string[]; input?: string } = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", command, ...(options.args ?? [])], {
    cwd: process.cwd(),
    // HOME points at the temporary folder too: the child is not under Vitest, so the real-home guard is off there.
    env: { PATH: process.env.PATH, HOME: parent, ...extraEnv },
    encoding: "utf8",
    input: options.input ?? "",
  });
}

describe("zero-configuration CLI", () => {
  it("initializes private managed state without secret environment variables", () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-cli-"));
    temporaryDirectories.push(parent);
    const state = join(parent, "state");
    const result = runInit(parent, { APIUNICON_HOME: state });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(join(state, "apiunicon.sqlite"));
    expect(readFileSync(join(state, "master.key"))).toHaveLength(32);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    expect(statSync(join(state, "master.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(state, "apiunicon.sqlite")).isFile()).toBe(true);
    expect(statSync(join(state, "apiunicon.sqlite")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(state, "mcp.token"), "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(statSync(join(state, "mcp.token")).mode & 0o777).toBe(0o600);
  });

  it("prints the setup link only while no administrator exists, and the Claude Code command with the MCP token", async () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-cli-"));
    temporaryDirectories.push(parent);
    const state = join(parent, "state");
    const env = { APIUNICON_HOME: state };

    const first = runCli("setup-link", parent, env);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toMatch(/^http:\/\/127\.0\.0\.1:3210\/setup\?t=[A-Za-z0-9_-]{43}\n$/u);
    expect(runCli("setup-link", parent, env).stdout).toBe(first.stdout);
    expect(statSync(join(state, "setup.token")).mode & 0o777).toBe(0o600);

    const claude = runCli("claude-mcp-add", parent, env);
    const token = readFileSync(join(state, "mcp.token"), "utf8").trim();
    expect(claude.stdout).toBe(
      `claude mcp add --transport http --scope user apiunicon http://127.0.0.1:3210/mcp --header "Authorization: Bearer ${token}"\n`,
    );

    const application = buildApplication(loadConfig(env, ensureManagedState(env)));
    await application.auth.setup("correct horse battery staple");
    application.db.close();
    const after = runCli("setup-link", parent, env);
    expect(after.status).toBe(0);
    expect(after.stdout).toBe("");
    expect(after.stderr).toContain("The administrator already exists");
    expect(existsSync(join(state, "setup.token"))).toBe(false);
  });

  it("verify-secrets takes the part of a key on standard input and names where it is stored readable", async () => {
    const parent = mkdtempSync(join(tmpdir(), "apiunicon-cli-"));
    temporaryDirectories.push(parent);
    const env = { APIUNICON_HOME: join(parent, "state") };
    const fragment = 'wb"key\\part';
    const application = buildApplication(loadConfig(env, ensureManagedState(env)));
    application.db.prepare("insert into tunnel_events values ('e1', 'error', ?, '2026-10-01T00:00:00.000Z')").run(`said ${fragment}`);
    application.db.close();

    const refused = runCli("verify-secrets", parent, env, { args: [fragment] });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("not from the command line");

    const found = runCli("verify-secrets", parent, env, { input: `${fragment}\n` });
    expect(found.status).toBe(1);
    expect(found.stderr).toBe("The part of the key is stored readable in: tunnel_events.message (1 row)\n");
    expect(found.stdout).toBe("");

    const clean = runCli("verify-secrets", parent, env, { input: "not-stored-anywhere" });
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toBe("The part of the key is in no readable column of the database\n");

    const empty = runCli("verify-secrets", parent, env, { input: "" });
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("needs a part of a key on standard input");
  });
});
