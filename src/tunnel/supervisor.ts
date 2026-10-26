import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { REDACTED } from "../security/redaction.js";

import type { TunnelConfigRecord, TunnelRepository } from "./repository.js";

export type SpawnedProcess = {
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type LaunchOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
};

export type ProcessLauncher = (
  executable: string,
  args: readonly string[],
  options: LaunchOptions,
) => SpawnedProcess;

type SupervisorOptions = {
  runtimeKeyProvider: (credentialSetId: string) => Promise<string>;
  mcpServerUrl: string;
  // The local MCP endpoint's bearer token. The client sends it on every request to that endpoint, through the
  // MCP_EXTRA_HEADERS variable of its environment, so it is in neither its arguments nor its profile.
  mcpToken?: string;
  profileDir: string;
  // The client always runs from here, and no path to it is stored with the configuration, so the state folder can move
  // without configuring the tunnel again.
  binDir: string;
  launch?: ProcessLauncher;
  commandTimeoutMs?: number;
};

const TUNNEL_ID_PATTERN = /^tunnel_[a-z0-9]{32}$/u;

export function isTunnelId(value: string): boolean {
  return TUNNEL_ID_PATTERN.test(value);
}

export type TunnelSupervisorStatus = {
  configured: boolean;
  running: boolean;
  status: "not_configured" | TunnelConfigRecord["status"];
  tunnelId: string | null;
  profileName: string | null;
  binaryPath: string | null;
  lastErrorCategory: string | null;
  events: ReturnType<TunnelRepository["recentEvents"]>;
};

// LaunchOptions pipes stdout and stderr, so the child has both, which ChildProcess's own type cannot say.
function launchProcess(executable: string, args: readonly string[], options: LaunchOptions): SpawnedProcess {
  return spawn(executable, [...args], options) as unknown as SpawnedProcess;
}

function childEnvironment(runtimeKey: string, mcpToken: string | undefined): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "XDG_CONFIG_HOME",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.CONTROL_PLANE_API_KEY = runtimeKey;
  if (mcpToken !== undefined) environment.MCP_EXTRA_HEADERS = `Authorization: Bearer ${mcpToken}`;
  return environment;
}

function sanitizedOutput(value: string, secrets: readonly string[]): string {
  return secrets
    .reduce((text, secret) => text.replaceAll(secret, REDACTED), value)
    .replace(/(bearer|api[_ -]?key|token|secret)\s*[:=]\s*[^\s,;]+/giu, `$1=${REDACTED}`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, 4_000);
}

export class TunnelSupervisor {
  private readonly launch: ProcessLauncher;
  private readonly commandTimeoutMs: number;
  private child: SpawnedProcess | null = null;
  private stopping = false;

  constructor(
    private readonly repository: TunnelRepository,
    private readonly options: SupervisorOptions,
  ) {
    this.launch = options.launch ?? launchProcess;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  }

  async configure(input: {
    tunnelId: string;
    runtimeCredentialSetId: string;
    profileName: string;
  }): Promise<void> {
    if (!isTunnelId(input.tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase letters or digits");
    }
    if (this.child) await this.stop();
    const config = this.repository.configure(input);
    this.repository.setStatus("starting");
    try {
      await this.runCommand(config, "init", [
        "init", "--sample", "sample_mcp_remote_no_auth", "--profile", config.profileName,
        "--profile-dir", this.options.profileDir,
        "--tunnel-id", config.tunnelId, "--mcp-server-url", this.options.mcpServerUrl,
      ]);
      this.repository.setStatus("stopped");
    } catch (error) {
      this.repository.setStatus("failed", "init");
      throw error;
    }
  }

  async doctor(): Promise<void> {
    const config = this.requireConfig();
    this.repository.setStatus("starting");
    try {
      await this.runCommand(config, "doctor", [
        "doctor", "--profile", config.profileName, "--profile-dir", this.options.profileDir, "--explain",
      ]);
      this.repository.setStatus(this.child ? "healthy" : "stopped");
    } catch (error) {
      this.repository.setStatus("failed", "doctor");
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.child) return;
    await this.doctor();
    const config = this.requireConfig();
    const runtimeKey = await this.options.runtimeKeyProvider(config.runtimeCredentialSetId);
    this.repository.setStatus("starting");
    const child = this.launch(this.binaryPath(), [
      "run", "--profile", config.profileName, "--profile-dir", this.options.profileDir,
    ], {
      cwd: this.options.binDir,
      env: childEnvironment(runtimeKey, this.options.mcpToken),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.captureOutput(child.stdout, "info", runtimeKey, "run");
    this.captureOutput(child.stderr, "error", runtimeKey, "run");
    child.on("close", (code) => {
      const intentional = this.stopping;
      if (this.child === child) this.child = null;
      this.stopping = false;
      if (intentional) return;
      this.repository.setStatus("failed", "run");
      this.repository.appendEvent("error", `run exited unexpectedly with code ${code ?? "signal"}`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      if (this.child === child) this.child = null;
      this.repository.setStatus("failed", "run");
      throw error;
    }
    if (this.child !== child) throw new Error("run exited during startup");
    this.repository.setStatus("healthy");
    this.repository.appendEvent("info", "run started");
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      if (this.repository.get()) this.repository.setStatus("stopped");
      return;
    }
    this.stopping = true;
    await new Promise<void>((resolve) => {
      let finished = false;
      let forceTimer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (finished) return;
        finished = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };
      child.once("close", done);
      forceTimer = setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 5_000);
      forceTimer.unref();
      child.kill("SIGTERM");
    });
    this.child = null;
    this.stopping = false;
    this.repository.setStatus("stopped");
    this.repository.appendEvent("info", "run stopped");
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  status(): TunnelSupervisorStatus {
    const config = this.repository.get();
    return {
      configured: Boolean(config),
      running: Boolean(this.child),
      status: config?.status ?? "not_configured",
      tunnelId: config?.tunnelId ?? null,
      profileName: config?.profileName ?? null,
      binaryPath: config ? this.binaryPath() : null,
      lastErrorCategory: config?.lastErrorCategory ?? null,
      events: this.repository.recentEvents(30),
    };
  }

  private binaryPath(): string {
    return join(this.options.binDir, "tunnel-client");
  }

  private requireConfig(): TunnelConfigRecord {
    const config = this.repository.get();
    if (!config) throw new Error("Tunnel is not configured");
    return config;
  }

  private async runCommand(config: TunnelConfigRecord, name: string, args: string[]): Promise<void> {
    const runtimeKey = await this.options.runtimeKeyProvider(config.runtimeCredentialSetId);
    const child = this.launch(this.binaryPath(), args, {
      cwd: this.options.binDir,
      env: childEnvironment(runtimeKey, this.options.mcpToken),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.captureOutput(child.stdout, "info", runtimeKey, name);
    this.captureOutput(child.stderr, "error", runtimeKey, name);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${name} timed out`));
      }, this.commandTimeoutMs);
      timer.unref();
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`${name} failed to start: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          this.repository.appendEvent("info", `${name} completed`);
          resolve();
        } else reject(new Error(`${name} failed with code ${code ?? "signal"}`));
      });
    });
  }

  private captureOutput(stream: Readable, level: "info" | "error", runtimeKey: string, prefix: string): void {
    stream.setEncoding("utf8");
    let pending = "";
    const secrets = this.options.mcpToken === undefined ? [runtimeKey] : [runtimeKey, this.options.mcpToken];
    const persist = (line: string): void => {
      const message = sanitizedOutput(line.trim(), secrets);
      if (message) this.repository.appendEvent(level, `${prefix}: ${message}`);
    };
    stream.on("data", (chunk: string | Buffer) => {
      pending += String(chunk);
      if (pending.length > 16_000) {
        this.repository.appendEvent(level, `${prefix}: [oversized output omitted]`);
        pending = "";
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        persist(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (pending) persist(pending);
      pending = "";
    });
  }
}
