import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { ensureManagedState } from "./bootstrap/state.js";
import { loadConfig, localBaseUrl } from "./config.js";
import { buildHttpServer } from "./http/server.js";
import { buildApplication, type Application } from "./index.js";
import { startMcpServer } from "./mcp/server.js";
import { findKeyFragment } from "./verification/export.js";

// Local requests finish well within this; a held-open MCP stream or a slow upstream call is cut off instead.
const SHUTDOWN_GRACE_MS = 5_000;
// The grace period, the tunnel client's own 5 s stop and margin, still below launchd's default 20 s ExitTimeOut.
const SHUTDOWN_DEADLINE_MS = 15_000;

// The part of a key verify-secrets looks for, from standard input: never from the command line, where it would stay in
// the shell's history and be visible to other processes. Typed in a terminal, it is not shown; piped in, it is the
// whole input without its final line break.
async function readKeyFragment(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  }
  process.stderr.write("Paste a distinctive part of a key and press Enter. It is not shown.\n");
  // readline echoes what is typed to its output, so an output that writes nothing keeps the fragment off the screen.
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const lines = createInterface({ input, output: silent, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      lines.once("line", resolve);
      lines.once("close", () => resolve(""));
    });
  } finally {
    lines.close();
  }
}

// The link that creates the administrator, while there is none; null once there is one, and a token left over from
// before is removed then.
function setupLink(application: Application): string | null {
  const token = application.setupToken;
  if (token === null) return null;
  if (application.auth.isSetup()) {
    token.discard();
    return null;
  }
  return `${application.keyEntryBaseUrl}/setup?t=${token.issue()}`;
}

// The command that registers the local endpoint in Claude Code, with this computer's MCP token.
function claudeMcpAdd(application: Application): string {
  const token = application.config.mcpToken;
  if (token === undefined) throw new Error("The MCP token is not configured");
  return `claude mcp add --transport http --scope user apiunicon ${application.keyEntryBaseUrl}/mcp --header "Authorization: Bearer ${token}"`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "serve";
  if (command === "verify-secrets" && argv.length > 1) {
    throw new Error("verify-secrets reads the part of a key from standard input, not from the command line, where it would stay in the shell history. Run it without arguments and paste the part, or pipe it in.");
  }
  const fragment = command === "verify-secrets" ? await readKeyFragment() : null;
  const state = ensureManagedState(process.env);
  const config = loadConfig(process.env, state);
  const application = buildApplication(config);
  if (command === "init") {
    process.stdout.write(`Initialized ${config.dbPath}\n`);
    application.db.close();
    return;
  }
  if (command === "serve") {
    const server = buildHttpServer(application, { errorLog: process.stderr });
    application.jobRunner.start();
    server.addHook("onClose", async () => {
      await application.tunnel.shutdown();
      application.jobRunner.stop();
      application.db.close();
    });
    await server.listen({ host: config.httpHost, port: config.httpPort });
    let closing = false;
    const close = (): void => {
      if (closing) return;
      closing = true;
      // Fastify waits for every connection before it runs onClose, so open ones are cut off after the grace period.
      void server.close();
      server.server.closeIdleConnections();
      setTimeout(() => server.server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
      // launchd never restarts a process that merely stopped listening, so a stuck shutdown has to end the process.
      setTimeout(() => {
        process.stderr.write(`APIUniCon did not stop within ${SHUTDOWN_DEADLINE_MS} ms, exiting\n`);
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS).unref();
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    process.stdout.write(
      `APIUniCon listening on ${localBaseUrl(config)}\nState: ${config.stateDir}\n`,
    );
    const link = setupLink(application);
    if (link !== null) process.stdout.write(`Create the administrator password: ${link}\n`);
    return;
  }
  // Prints the setup link alone, for a script; once an administrator exists, says so on stderr and prints nothing.
  if (command === "setup-link") {
    const link = setupLink(application);
    application.db.close();
    if (link === null) process.stderr.write(`The administrator already exists: sign in at ${application.keyEntryBaseUrl}/login\n`);
    else process.stdout.write(`${link}\n`);
    return;
  }
  if (command === "claude-mcp-add") {
    const line = claudeMcpAdd(application);
    application.db.close();
    process.stdout.write(`${line}\n`);
    return;
  }
  if (command === "mcp") {
    await startMcpServer(application.mcpDependencies);
    return;
  }
  if (command === "verify-secrets") {
    if (!fragment) {
      application.db.close();
      throw new Error("verify-secrets needs a part of a key on standard input");
    }
    const found = findKeyFragment(application.db, fragment);
    application.db.close();
    if (found.length > 0) {
      const places = found.map(({ table, column, rows }) => `${table}.${column} (${rows === 1 ? "1 row" : `${rows} rows`})`);
      process.stderr.write(`The part of the key is stored readable in: ${places.join(", ")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write("The part of the key is in no readable column of the database\n");
    }
    return;
  }
  application.db.close();
  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
