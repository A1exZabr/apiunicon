import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { TunnelRepository } from "../../src/tunnel/repository.js";
import {
  TunnelSupervisor,
  type ProcessLauncher,
  type SpawnedProcess,
} from "../../src/tunnel/supervisor.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  delete process.env.UNRELATED_TEST_SECRET;
  for (const database of databases.splice(0)) database.close();
});

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 9001;
  killedWith: NodeJS.Signals | undefined;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedWith = signal;
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

function fixtureLauncher(options: { failDoctor?: boolean; exitRunImmediately?: boolean; runtimeKey: string }) {
  const calls: Array<{ executable: string; args: string[]; environment: NodeJS.ProcessEnv; cwd: string }> = [];
  const processes: FakeProcess[] = [];
  const launcher: ProcessLauncher = (executable, args, processOptions) => {
    calls.push({ executable, args: [...args], environment: processOptions.env, cwd: processOptions.cwd });
    const child = new FakeProcess();
    processes.push(child);
    queueMicrotask(() => {
      child.emit("spawn");
      const split = Math.floor(options.runtimeKey.length / 2);
      child.stdout.write(`tunnel output ${options.runtimeKey.slice(0, split)}`);
      child.stdout.write(`${options.runtimeKey.slice(split)}\n`);
      if (args[0] !== "run" || options.exitRunImmediately) {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", args[0] === "doctor" && options.failDoctor ? 1 : 0, null);
      }
    });
    return child;
  };
  return { launcher, calls, processes };
}

function createRepository(): TunnelRepository {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  database.prepare(
    "insert into credential_sets (id, created_at, updated_at) values ('tunnel-runtime', ?, ?)",
  ).run(new Date().toISOString(), new Date().toISOString());
  return new TunnelRepository(database);
}

describe("Secure MCP Tunnel supervisor", () => {
  it("uses fixed argv, injects only the runtime key, redacts events, and stops its exact child", async () => {
    const runtimeKey = "runtime-key-that-must-never-escape";
    const repository = createRepository();
    const fake = fixtureLauncher({ runtimeKey });
    process.env.UNRELATED_TEST_SECRET = "must-not-be-forwarded";
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => runtimeKey,
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      profileDir: "/safe/state/tunnel-client",
      binDir: "/safe",
      launch: fake.launcher,
      commandTimeoutMs: 1_000,
    });

    await supervisor.configure({
      tunnelId: "tunnel_00000000000000000000000000000000",
      runtimeCredentialSetId: "tunnel-runtime", profileName: "apiunicon-local",
    });
    expect(fake.calls[0]).toMatchObject({
      executable: "/safe/tunnel-client",
      cwd: "/safe",
      args: [
        "init", "--sample", "sample_mcp_remote_no_auth", "--profile", "apiunicon-local",
        "--profile-dir", "/safe/state/tunnel-client",
        "--tunnel-id", "tunnel_00000000000000000000000000000000",
        "--mcp-server-url", "http://127.0.0.1:3210/mcp",
      ],
    });
    expect(fake.calls[0]!.environment.CONTROL_PLANE_API_KEY).toBe(runtimeKey);
    expect(fake.calls[0]!.environment.UNRELATED_TEST_SECRET).toBeUndefined();
    expect(fake.calls[0]!.environment.MCP_EXTRA_HEADERS).toBeUndefined();

    await supervisor.doctor();
    await supervisor.start();
    expect(fake.calls.map(({ args }) => args[0])).toEqual(["init", "doctor", "doctor", "run"]);
    expect(fake.calls.at(-1)?.args).toEqual([
      "run", "--profile", "apiunicon-local", "--profile-dir", "/safe/state/tunnel-client",
    ]);
    expect(supervisor.status()).toMatchObject({ configured: true, running: true, status: "healthy" });
    expect(JSON.stringify(supervisor.status())).not.toContain(runtimeKey);
    const serializedEvents = JSON.stringify(repository.recentEvents(20));
    expect(serializedEvents).not.toContain(runtimeKey);
    expect(serializedEvents).not.toContain(runtimeKey.slice(0, Math.floor(runtimeKey.length / 2)));
    expect(serializedEvents).not.toContain(runtimeKey.slice(Math.floor(runtimeKey.length / 2)));

    await supervisor.stop();
    expect(fake.processes.at(-1)?.killedWith).toBe("SIGTERM");
    expect(supervisor.status()).toMatchObject({ running: false, status: "stopped" });
  });

  it("sends the local MCP endpoint's token on every command through the environment, never in arguments or events", async () => {
    const runtimeKey = "runtime-key-for-the-token-test";
    const mcpToken = "local-mcp-token-0123456789abcdefghijklmnopq";
    const repository = createRepository();
    const calls: Array<{ args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const launcher: ProcessLauncher = (_executable, args, processOptions) => {
      calls.push({ args: [...args], environment: processOptions.env });
      const child = new FakeProcess();
      queueMicrotask(() => {
        child.emit("spawn");
        // A client that echoes its configuration, as a verbose one might.
        child.stdout.write(`forwarding with Authorization: Bearer ${mcpToken}\n`);
        child.stdout.end();
        child.stderr.end();
        if (args[0] !== "run") child.emit("close", 0, null);
      });
      return child;
    };
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => runtimeKey,
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      mcpToken,
      profileDir: "/safe/state/tunnel-client",
      binDir: "/safe",
      launch: launcher,
      commandTimeoutMs: 1_000,
    });

    await supervisor.configure({
      tunnelId: "tunnel_22222222222222222222222222222222",
      runtimeCredentialSetId: "tunnel-runtime", profileName: "apiunicon-local",
    });
    await supervisor.start();
    await supervisor.stop();

    expect(calls.map(({ args }) => args[0])).toEqual(["init", "doctor", "run"]);
    for (const { args, environment } of calls) {
      expect(environment.MCP_EXTRA_HEADERS).toBe(`Authorization: Bearer ${mcpToken}`);
      expect(args.join(" ")).not.toContain(mcpToken);
    }
    expect(JSON.stringify(repository.recentEvents(20))).not.toContain(mcpToken);
    expect(JSON.stringify(repository.recentEvents(20))).toContain("forwarding with Authorization");
  });

  it("records a categorized doctor failure without persisting command output secrets", async () => {
    const runtimeKey = "failed-doctor-runtime-key";
    const repository = createRepository();
    const fake = fixtureLauncher({ failDoctor: true, runtimeKey });
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => runtimeKey,
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      profileDir: "/safe/state/tunnel-client",
      binDir: "/safe",
      launch: fake.launcher,
      commandTimeoutMs: 1_000,
    });
    await supervisor.configure({
      tunnelId: "tunnel_11111111111111111111111111111111",
      runtimeCredentialSetId: "tunnel-runtime", profileName: "apiunicon-local",
    });

    await expect(supervisor.doctor()).rejects.toThrow(/doctor failed/iu);
    expect(repository.get()).toMatchObject({ status: "failed", lastErrorCategory: "doctor" });
    expect(JSON.stringify(repository.recentEvents(20))).not.toContain(runtimeKey);
  });

  it("does not report healthy when the run process exits during startup", async () => {
    const runtimeKey = "startup-exit-runtime-key";
    const repository = createRepository();
    const fake = fixtureLauncher({ exitRunImmediately: true, runtimeKey });
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => runtimeKey,
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      profileDir: "/safe/state/tunnel-client",
      binDir: "/safe",
      launch: fake.launcher,
      commandTimeoutMs: 1_000,
    });
    await supervisor.configure({
      tunnelId: "tunnel_22222222222222222222222222222222",
      runtimeCredentialSetId: "tunnel-runtime", profileName: "apiunicon-local",
    });

    await expect(supervisor.start()).rejects.toThrow(/exited during startup/iu);
    expect(supervisor.status()).toMatchObject({ running: false, status: "failed" });
  });

  it("launches a tunnel configured earlier from the folder it is given now, so the state folder can move", async () => {
    const runtimeKey = "moved-folder-runtime-key";
    const repository = createRepository();
    repository.configure({
      tunnelId: "tunnel_44444444444444444444444444444444",
      runtimeCredentialSetId: "tunnel-runtime",
      profileName: "apiunicon-local",
    });
    const fake = fixtureLauncher({ runtimeKey });
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => runtimeKey,
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      profileDir: "/new-home/.apiunicon/tunnel-client",
      binDir: "/new-home/.apiunicon/bin",
      launch: fake.launcher,
      commandTimeoutMs: 1_000,
    });

    await supervisor.doctor();
    await supervisor.start();

    expect(fake.calls.map(({ args, executable, cwd }) => [args[0], executable, cwd])).toEqual([
      ["doctor", "/new-home/.apiunicon/bin/tunnel-client", "/new-home/.apiunicon/bin"],
      ["doctor", "/new-home/.apiunicon/bin/tunnel-client", "/new-home/.apiunicon/bin"],
      ["run", "/new-home/.apiunicon/bin/tunnel-client", "/new-home/.apiunicon/bin"],
    ]);
    expect(supervisor.status()).toMatchObject({
      running: true, binaryPath: "/new-home/.apiunicon/bin/tunnel-client",
    });
    await supervisor.stop();
  });

  it("rejects malformed tunnel IDs before persisting configuration or launching a process", async () => {
    const repository = createRepository();
    const fake = fixtureLauncher({ runtimeKey: "unused-runtime-key" });
    const supervisor = new TunnelSupervisor(repository, {
      runtimeKeyProvider: async () => "unused-runtime-key",
      mcpServerUrl: "http://127.0.0.1:3210/mcp",
      profileDir: "/safe/state/tunnel-client",
      binDir: "/safe",
      launch: fake.launcher,
    });

    await expect(supervisor.configure({
      tunnelId: "tun_wrong",
      runtimeCredentialSetId: "tunnel-runtime", profileName: "apiunicon-local",
    })).rejects.toThrow(/tunnel ID/iu);
    expect(repository.get()).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});
