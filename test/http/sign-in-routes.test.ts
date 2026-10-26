import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

type Route = { method: string; url: string; signIn: string | undefined };

// Every route the server adds, with the sign-in its config declares, seen as Fastify adds it.
const added = vi.hoisted((): Route[] => []);

vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  const create = ((options?: Parameters<typeof actual.default>[0]) => {
    const server = actual.default(options);
    server.addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) added.push({ method, url: route.url, signIn: route.config?.signIn });
    });
    return server;
  }) as typeof actual.default;
  return { ...actual, default: create };
});

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 7),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
  catalogOrigin: "https://apiunicon.online",
};

// The pages a link of the assistant leads to, with the sign-in each needs. A route that declares none is the
// workspace's own and always needs the sign-in.
const DECLARED: Record<string, string> = {
  "GET /confirm/change/:id": "always",
  "POST /confirm/change/:id": "always",
  "GET /confirm/delete/:id": "always",
  "POST /confirm/delete/:id": "always",
  "GET /confirm/reads/:id": "always",
  "POST /confirm/reads/:id": "always",
  "GET /connect/:id": "replacing_keys",
  "POST /connect/:id/complete": "replacing_keys",
  "GET /catalog": "always",
  "GET /catalog/connect": "always",
  "GET /catalog/callback": "never",
  "POST /catalog/sign-out": "always",
  "POST /catalog/use": "always",
  "GET /connections/:id": "workspace",
};

// The routes that answer before the workspace's sign-in by design: the health check, the MCP endpoint with its own
// token, and the setup and sign-in pages themselves.
const OWN_CHECK = new Set(["/health", "/mcp", "/setup", "/login"]);

describe("the sign-in each route declares", () => {
  let application: Application;

  beforeEach(() => {
    added.length = 0;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("", { status: 404 }),
    });
  });

  afterEach(() => application.db.close());

  it("is declared on every page of a link, and every other page needs the sign-in", async () => {
    const server = buildHttpServer(application);
    await server.ready();
    await setupAdmin(server, application);
    const routes = added.filter(({ method }) => method !== "HEAD");
    const declared = Object.fromEntries(routes.filter(({ signIn }) => signIn !== undefined).map(({ method, url, signIn }) => [`${method} ${url}`, signIn]));
    expect(declared).toEqual(DECLARED);
    // A route under the paths of one-time links that declares nothing would open as a workspace page, never by its link
    // alone; none does.
    expect(routes.filter(({ url, signIn }) => /^\/(?:confirm|connect|catalog)(?:\/|$)/u.test(url) && signIn === undefined)).toEqual([]);

    const id = randomUUID();
    for (const { method, url, signIn } of routes) {
      if (OWN_CHECK.has(url) || signIn === "never" || signIn === "replacing_keys") continue;
      const response = await server.inject({ method: method as "GET" | "POST", url: url.replace(":id", id), headers: LOCAL });
      expect(response.statusCode, `${method} ${url}`).toBe(303);
      expect(String(response.headers.location), `${method} ${url}`).toMatch(/^\/login(?:\?|$)/u);
    }
    await server.close();
  });

  it("returns after the sign-in only to a page that declares it needs one", async () => {
    const server = buildHttpServer(application);
    await server.ready();
    await setupAdmin(server, application);
    const id = randomUUID();
    const token = "T".repeat(43);
    for (const next of [`/confirm/change/${id}?t=${token}`, `/confirm/reads/${id}`, `/connect/${id}?t=${token}`, `/connections/${id}`, "/catalog/connect"]) {
      const page = await server.inject({ method: "GET", url: `/login?next=${encodeURIComponent(next)}`, headers: LOCAL });
      expect(page.body, next).toContain(`<input type="hidden" name="next" value="${next}">`);
    }
    for (const next of [`/catalog/callback`, `/connect/${id}/complete`, `/connections/${id}/writes`, `/tunnel`, "/", `/confirm/change/${id}?t=short`]) {
      const page = await server.inject({ method: "GET", url: `/login?next=${encodeURIComponent(next)}`, headers: LOCAL });
      expect(page.body, next).not.toContain('name="next"');
    }
    await server.close();
  });
});
