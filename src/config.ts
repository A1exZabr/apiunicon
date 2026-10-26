import { isIP } from "node:net";
import { join } from "node:path";
import { z } from "zod";

import { DATABASE_FILE, stateFolder, type ManagedState } from "./bootstrap/state.js";
import { catalogOrigin, catalogOriginExplicit } from "./catalog/origin.js";
import { DEFAULT_MAX_DOCUMENT_BYTES } from "./docs/intake.js";
import { DEFAULT_MAX_UPSTREAM_BYTES } from "./runtime/runtime.js";

const EnvironmentSchema = z.object({
  APIUNICON_MASTER_KEY: z.string().min(1).optional(),
  APIUNICON_DB_PATH: z.string().min(1).optional(),
  APIUNICON_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  APIUNICON_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  APIUNICON_MAX_RESPONSE_BYTES: z.coerce.number().int().positive().default(1_048_576),
  APIUNICON_MAX_UPSTREAM_BYTES: z.coerce.number().int().min(1_024).max(64 * 1024 * 1024).default(DEFAULT_MAX_UPSTREAM_BYTES),
  APIUNICON_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  APIUNICON_MAX_CRAWL_PAGES: z.coerce.number().int().min(1).max(500).default(50),
  APIUNICON_MAX_DOCUMENT_BYTES: z.coerce.number().int().min(1_024).max(50 * 1024 * 1024).default(DEFAULT_MAX_DOCUMENT_BYTES),
});

// The workspace, its one-time pages and its MCP endpoint are for this computer only, so the server listens on loopback.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export type AppConfig = {
  stateDir: string;
  binDir: string;
  dbPath: string;
  masterKey: Buffer;
  httpHost: string;
  httpPort: number;
  maxResponseBytes: number;
  maxUpstreamBytes?: number;
  requestTimeoutMs: number;
  maxCrawlPages: number;
  maxDocumentBytes?: number;
  // The cloud whose shared catalog the local version signs in to. loadConfig always sets it (see catalogOrigin in
  // catalog/origin.ts); only a host that passes its own catalog, or a test that wants none, leaves it out.
  catalogOrigin?: string;
  // The bearer token of the local HTTP MCP endpoint, from the state folder. Without one that endpoint answers no client.
  mcpToken?: string;
  // Where the token for creating the local administrator is kept while there is none (see SetupToken). Only the local
  // version has one; without it no administrator can be created through this server.
  setupTokenPath?: string;
  // loadConfig sets it: true when APIUNICON_CATALOG_ORIGIN named the cloud. When it is false, catalogOrigin is only the
  // language default and the cloud that issued the stored keys wins (see CatalogSession). Left out, it means true.
  catalogOriginExplicit?: boolean;
};

// The address of this server's pages and MCP endpoint on the loopback host it listens on: an IPv6 address in brackets.
export function localBaseUrl(config: Pick<AppConfig, "httpHost" | "httpPort">): string {
  const host = isIP(config.httpHost) === 6 ? `[${config.httpHost}]` : config.httpHost;
  return `http://${host}:${config.httpPort}`;
}

// Without the managed state, the paths are still the documented ones in the state folder, never the working directory.
export function loadConfig(env: NodeJS.ProcessEnv, state?: ManagedState): AppConfig {
  const parsed = EnvironmentSchema.parse(env);
  const masterKey = parsed.APIUNICON_MASTER_KEY
    ? Buffer.from(parsed.APIUNICON_MASTER_KEY, "base64")
    : state?.masterKey;

  if (!masterKey || masterKey.length !== 32) {
    throw new Error("APIUNICON_MASTER_KEY must decode to exactly 32 bytes");
  }
  if (!LOOPBACK_HOSTS.has(parsed.APIUNICON_HTTP_HOST)) {
    throw new Error(
      `APIUNICON_HTTP_HOST must be a loopback address (127.0.0.1, ::1 or localhost), not ${JSON.stringify(parsed.APIUNICON_HTTP_HOST)}: APIUniCon answers only this computer`,
    );
  }

  const stateDir = state?.stateDir ?? stateFolder(env);
  return {
    stateDir,
    binDir: state?.binDir ?? join(stateDir, "bin"),
    dbPath: parsed.APIUNICON_DB_PATH ?? state?.dbPath ?? join(stateDir, DATABASE_FILE),
    masterKey,
    httpHost: parsed.APIUNICON_HTTP_HOST,
    httpPort: parsed.APIUNICON_HTTP_PORT,
    maxResponseBytes: parsed.APIUNICON_MAX_RESPONSE_BYTES,
    maxUpstreamBytes: parsed.APIUNICON_MAX_UPSTREAM_BYTES,
    requestTimeoutMs: parsed.APIUNICON_REQUEST_TIMEOUT_MS,
    maxCrawlPages: parsed.APIUNICON_MAX_CRAWL_PAGES,
    maxDocumentBytes: parsed.APIUNICON_MAX_DOCUMENT_BYTES,
    ...(state ? { mcpToken: state.mcpToken, setupTokenPath: state.setupTokenPath } : {}),
    catalogOrigin: catalogOrigin(env),
    catalogOriginExplicit: catalogOriginExplicit(env),
  };
}
