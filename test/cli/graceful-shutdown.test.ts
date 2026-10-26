import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Served = { port: number; token: string; child: ChildProcess; stdout: () => string; stderr: () => string; exited: Promise<Exit> };
type Raw = { text: () => string; send: (data: string) => void };

const directories: string[] = [];
const children: ChildProcess[] = [];
const sockets: Socket[] = [];

// The child must never outlive the test, also when it fails to start in time or an assertion fails.
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startServe(): Promise<Served> {
  const state = mkdtempSync(join(tmpdir(), "apiunicon-shutdown-"));
  directories.push(state);
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: process.cwd(),
    // HOME points at the temporary folder too: the child is not under Vitest, so the real-home guard is off there.
    env: {
      PATH: process.env.PATH,
      HOME: state,
      APIUNICON_HOME: state,
      APIUNICON_HTTP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${stderr}`)), 5_000);
    timeout.unref();
    const inspect = (): void => {
      if (!stdout.includes("APIUniCon listening")) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      resolve();
    };
    child.stdout.on("data", inspect);
    child.once("error", reject);
  });
  // The MCP endpoint answers only with the token the server made in its state folder.
  const token = readFileSync(join(state, "mcp.token"), "utf8").trim();
  return { port, token, child, stdout: () => stdout, stderr: () => stderr, exited };
}

// Bounded, so that a child that ignores SIGTERM fails with its stderr before the test timeout instead of hanging.
async function exitsWithin(served: Served, milliseconds: number): Promise<Exit> {
  let stopTimeout: NodeJS.Timeout | undefined;
  return Promise.race([served.exited, new Promise<never>((_resolve, reject) => {
    stopTimeout = setTimeout(() => reject(new Error(`Server did not stop: ${served.stderr()}`)), milliseconds);
    stopTimeout.unref();
  })]).finally(() => clearTimeout(stopTimeout));
}

function rawConnection(port: number, firstChunk: string): Raw {
  const socket = createConnection({ host: "127.0.0.1", port });
  sockets.push(socket);
  let received = "";
  socket.setEncoding("utf8").on("data", (chunk: string) => { received += chunk; });
  // A connection the server force-closes can surface as a reset on this side.
  socket.on("error", () => undefined);
  socket.write(firstChunk);
  return { text: () => received, send: (data) => { socket.write(data); } };
}

async function waitFor(connection: Raw, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!connection.text().includes(expected)) {
    if (Date.now() > deadline) throw new Error(`Never received ${JSON.stringify(expected)}: ${JSON.stringify(connection.text())}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function mcpPost(served: Served, body: string): string {
  // Expect: 100-continue makes the server answer as soon as it has parsed the headers, so the test knows the request is in flight.
  return `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${served.port}\r\nAuthorization: Bearer ${served.token}\r\nContent-Type: application/json\r\n` +
    `Accept: application/json, text/event-stream\r\nExpect: 100-continue\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
}

describe("CLI lifecycle", () => {
  it("stops Tunnel and jobs before closing SQLite on SIGTERM", async () => {
    const served = await startServe();
    // With no administrator yet, the server prints the link that creates one.
    const deadline = Date.now() + 3_000;
    while (!served.stdout().includes("Create the administrator password:") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(served.stdout()).toMatch(new RegExp(`Create the administrator password: http://127\\.0\\.0\\.1:${served.port}/setup\\?t=[A-Za-z0-9_-]{43}\\n`, "u"));
    served.child.kill("SIGTERM");
    const result = await exitsWithin(served, 4_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(served.stderr()).not.toContain("database connection is not open");
    expect(served.stderr()).not.toContain("TypeError");
  });

  it("force-closes connections that outlive the grace period and still shuts down in order", async () => {
    const served = await startServe();
    const stream = rawConnection(
      served.port,
      `GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:${served.port}\r\nAuthorization: Bearer ${served.token}\r\nAccept: text/event-stream\r\n\r\n`,
    );
    const unfinished = rawConnection(served.port, mcpPost(served, "x".repeat(100)));
    await waitFor(stream, "200 OK");
    await waitFor(unfinished, "100 Continue");

    served.child.kill("SIGTERM");
    // Grace period plus margin, still well below the hard deadline that would exit with code 1.
    const result = await exitsWithin(served, 9_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(served.stderr()).not.toContain("database connection is not open");
    expect(served.stderr()).not.toContain("TypeError");
  }, 20_000);

  it("lets an in-flight request finish after the signal and ignores further signals", async () => {
    const served = await startServe();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const request = rawConnection(served.port, mcpPost(served, body));
    await waitFor(request, "100 Continue");

    for (const signal of ["SIGTERM", "SIGINT", "SIGTERM"] as const) {
      served.child.kill(signal);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    request.send(body);
    await waitFor(request, "HTTP/1.1 200 OK");
    await waitFor(request, `"id":1`);
    const result = await exitsWithin(served, 9_000);

    expect(result).toEqual({ code: 0, signal: null });
    expect(served.stderr()).not.toContain("database connection is not open");
    expect(served.stderr()).not.toContain("TypeError");
  }, 20_000);
});
