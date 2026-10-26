import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication } from "../../src/index.js";
import type { ProcessLauncher, SpawnedProcess } from "../../src/tunnel/supervisor.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

class WebFakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 777;
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }
}

describe("Tunnel browser setup", () => {
  it("uploads the client, seals the runtime key, and controls doctor/start/stop without reflecting it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "apiunicon-tunnel-web-"));
    directories.push(stateDir);
    const binDir = join(stateDir, "bin");
    const calls: Array<{ executable: string; cwd: string; args: readonly string[]; key: string | undefined }> = [];
    const launch: ProcessLauncher = (executable, args, options) => {
      calls.push({ executable, cwd: options.cwd, args, key: options.env.CONTROL_PLANE_API_KEY });
      const child = new WebFakeProcess();
      queueMicrotask(() => {
        child.emit("spawn");
        if (args[0] !== "run") child.emit("close", 0, null);
      });
      return child;
    };
    const config: AppConfig = {
      setupTokenPath: setupTokenPath(),
      stateDir, binDir, dbPath: ":memory:", masterKey: Buffer.alloc(32, 17),
      httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
      requestTimeoutMs: 1_000, maxCrawlPages: 5,
    };
    const application = buildApplication(config, { launchTunnelProcess: launch });
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const binary = Buffer.from("fake tunnel client bytes");

    const rejectedUpload = await server.inject({
      method: "POST", url: "/tunnel/binary",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/octet-stream", "x-csrf-token": "wrong" },
      payload: binary,
    });
    expect(rejectedUpload.statusCode).toBe(403);

    const uploaded = await server.inject({
      method: "POST", url: "/tunnel/binary",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/octet-stream", "x-csrf-token": session.csrf },
      payload: binary,
    });
    expect(uploaded.statusCode).toBe(200);
    const binaryPath = join(binDir, "tunnel-client");
    expect(readFileSync(binaryPath)).toEqual(binary);
    expect(statSync(binaryPath).mode & 0o777).toBe(0o700);

    const runtimeKey = "runtime-key-only-for-child-process";
    const invalidConfiguration = await server.inject({
      method: "POST", url: "/tunnel/configure",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf], ["tunnelId", "tun_web_123"], ["runtimeKey", runtimeKey],
      ]),
    });
    expect(invalidConfiguration.statusCode).toBe(400);
    expect(calls).toHaveLength(0);

    const configured = await server.inject({
      method: "POST", url: "/tunnel/configure",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf],
        ["tunnelId", "tunnel_33333333333333333333333333333333"],
        ["runtimeKey", runtimeKey],
      ]),
    });
    expect(configured.statusCode).toBe(303);
    expect(configured.headers.location).toBe("/tunnel");
    expect(calls[0]?.args[0]).toBe("init");
    expect(calls[0]?.key).toBe(runtimeKey);
    expect(calls[0]).toMatchObject({ executable: binaryPath, cwd: binDir });

    const page = await server.inject({ method: "GET", url: "/tunnel", headers: { ...LOCAL, cookie: session.cookies } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("tunnel_33333333333333333333333333333333");
    expect(page.body).not.toContain(runtimeKey);
    expect(JSON.stringify(application.tunnel.status())).not.toContain(runtimeKey);

    for (const action of ["doctor", "start"] as const) {
      const response = await server.inject({
        method: "POST", url: `/tunnel/${action}`,
        headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["csrf", session.csrf]]),
      });
      expect(response.statusCode).toBe(303);
    }
    const status = await server.inject({ method: "GET", url: "/api/tunnel/status", headers: { ...LOCAL, cookie: session.cookies } });
    expect(status.json()).toMatchObject({ configured: true, running: true, status: "healthy" });
    expect(JSON.stringify(status.json())).not.toContain(runtimeKey);
    const stopped = await server.inject({
      method: "POST", url: "/tunnel/stop",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf]]),
    });
    expect(stopped.statusCode).toBe(303);
    expect(application.tunnel.status()).toMatchObject({ running: false, status: "stopped" });

    await server.close();
    application.db.close();
  });
});
