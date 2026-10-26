import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 4),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

describe("local setup server", () => {
  let application: Application;
  let db: Database.Database;

  beforeEach(() => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) =>
        new Response(
          `<html><body><h1>Orders API</h1><p>GET /orders lists orders.</p></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html", "x-final-url": input.toString() },
          },
        ),
    });
    db = application.db;
  });

  afterEach(() => db.close());

  it("reports readiness without exposing configuration", async () => {
    const server = buildHttpServer(application);
    const response = await server.inject({ method: "GET", url: "/health", headers: LOCAL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await server.close();
  });

  it("serves /catalog only when the configuration names a catalog", async () => {
    const without = buildHttpServer(application);
    await without.ready();
    expect(without.hasRoute({ method: "GET", url: "/catalog" })).toBe(false);
    await without.close();

    const withCatalog = buildApplication({ ...config, catalogOrigin: "https://apiunicon.online" }, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("", { status: 404 }),
    });
    try {
      const server = buildHttpServer(withCatalog);
      await server.ready();
      expect(server.hasRoute({ method: "GET", url: "/catalog" })).toBe(true);
      await server.close();
    } finally {
      withCatalog.db.close();
    }
  });

  it("renders a crawled connection without its key values", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html", allowedOrigin: "https://docs.example.test",
    });
    application.vault.storeFields("credentials-primary", { "Api-Key": "super-secret", "Client-Id": "client-7" });
    const connection = application.connections.createConnection({
      label: "Fixture primary", documentationSourceId: source.id, allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-primary",
    });
    application.jobs.enqueue("crawl_documentation", source.id);
    await application.jobRunner.runOne();

    const detail = await server.inject({ method: "GET", url: `/connections/${connection.id}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Fixture primary");
    expect(detail.body).toContain("Api-Key");
    expect(detail.body).toContain("Client-Id");
    expect(detail.body).toContain("Configured");
    expect(detail.body).not.toContain("super-secret");
    expect(detail.body).not.toContain("client-7");
    expect(application.connections.getDocumentationSource(source.id).status).toBe("ready");
    expect(JSON.stringify(application.connections.getConnection(connection.id))).not.toContain("super-secret");
    await server.close();
  });

  it("allows the explicit reusable action only after a successful adapter test", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    application.vault.storeFields("credentials-1", { "Api-Key": "super-secret" });
    const connection = application.connections.createConnection({
      label: "Fixture",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-1",
    });
    const adapter = application.adapters.create({
      slug: "fixture",
      displayName: "Fixture",
      documentationSourceId: source.id,
      dsl: {
        schemaVersion: 1,
        baseOrigins: ["https://api.example.test"],
        credentialBindings: [
          { fieldName: "Api-Key", target: "header", headerName: "Api-Key" },
        ],
        operations: [
          {
            id: "list_orders",
            description: "List orders",
            risk: "read",
            method: "GET",
            path: "/orders",
            input: {},
            documentationRefs: [],
          },
        ],
      },
    });
    application.connections.bindAdapter(connection.id, adapter.id);

    const rejected = await server.inject({
      method: "POST",
      url: `/adapters/${adapter.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["expectedVersion", String(adapter.version)], ["confirmContribution", "yes"]]),
    });
    expect(rejected.statusCode).toBe(409);

    const working = application.adapters.markWorking(adapter.id, adapter.version);
    const accepted = await server.inject({
      method: "POST",
      url: `/adapters/${adapter.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["expectedVersion", String(working.version)], ["confirmContribution", "yes"]]),
    });
    expect(accepted.statusCode).toBe(303);
    expect(application.adapters.get(adapter.id).visibility).toBe("reusable");
    await server.close();
  });
});

describe("who the local server answers", () => {
  let application: Application;

  beforeEach(() => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
  });

  afterEach(() => application.db.close());

  const ID = "7d3c5a3e-6c1e-4a52-9f4e-2f0c1b7d9e10";
  // Every route of the local server, read and state-changing.
  const READS = [
    "/", "/setup", "/login", "/tunnel", "/api/tunnel/status", "/assets/app.js", "/connections/new", `/connection-drafts/${ID}`,
    `/api/connection-drafts/${ID}/status`, `/connections/${ID}`, `/connections/${ID}/changes-confirmation`, "/changes-confirmation",
    `/adapters/${ID}`, `/connect/${ID}`, `/confirm/delete/${ID}`, `/confirm/change/${ID}`, "/mcp", "/no-such-page",
  ];
  const CHANGES = [
    "/setup", "/login", "/logout", "/tunnel/binary", "/tunnel/configure", "/tunnel/doctor", "/tunnel/start", "/tunnel/stop",
    "/connection-drafts", `/connection-drafts/${ID}/select`, `/connection-drafts/${ID}/complete`, `/connection-drafts/${ID}/retry`,
    `/connections/${ID}/retry-crawl`, `/connections/${ID}/bind-adapter`, `/connections/${ID}/writes`,
    `/connections/${ID}/changes-confirmation`, "/changes-confirmation", `/adapters/${ID}/mark-reusable`, `/connect/${ID}/complete`,
    `/confirm/delete/${ID}`, `/confirm/change/${ID}`, "/mcp",
  ];

  it("answers only a loopback Host with its own port, on every route but /health", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    // A rebound DNS name, another port of this computer, or a name that only starts like a loopback one.
    for (const host of ["attacker.example", "attacker.example:3210", "127.0.0.1:9999", "localhost", "localhost.example:3210", "127.0.0.2:3210"]) {
      for (const [method, url] of [...READS.map((url) => ["GET", url] as const), ...CHANGES.map((url) => ["POST", url] as const)]) {
        const response = await server.inject({ method, url, headers: { host, cookie: session.cookies } });
        expect(response.statusCode, `${method} ${url} ${host}`).toBe(421);
      }
      expect((await server.inject({ method: "GET", url: "/health", headers: { host } })).statusCode).toBe(200);
    }
    for (const host of ["127.0.0.1:3210", "localhost:3210", "LOCALHOST:3210", "[::1]:3210"]) {
      expect((await server.inject({ method: "GET", url: "/", headers: { host, cookie: session.cookies } })).statusCode, host).toBe(200);
    }
    await server.close();
  });

  it("refuses connections that do not come from this computer, whatever the Host says", async () => {
    const server = buildHttpServer(application);
    for (const remoteAddress of ["192.168.1.20", "10.0.0.7", "::ffff:192.168.1.20", "fe80::1", "2001:db8::1"]) {
      for (const url of ["/", "/health", "/setup", "/mcp", `/confirm/change/${ID}`]) {
        const response = await server.inject({ method: "GET", url, remoteAddress, headers: LOCAL });
        expect(response.statusCode, `${remoteAddress} ${url}`).toBe(403);
      }
    }
    for (const remoteAddress of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      expect((await server.inject({ method: "GET", url: "/health", remoteAddress, headers: LOCAL })).statusCode, remoteAddress).toBe(200);
    }
    await server.close();
  });

  it("refuses a form or a script of another site on every state-changing route, even with the session and its token", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    application.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const { id } = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "credentials-1",
    });
    const elsewhere: Array<Record<string, string>> = [
      { origin: "http://evil.example" },
      { origin: "http://127.0.0.1:9999" },
      { origin: "https://127.0.0.1:3210" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      // Every header that is sent has to agree.
      { origin: "http://evil.example", "sec-fetch-site": "same-origin" },
      { origin: "http://127.0.0.1:3210", "sec-fetch-site": "cross-site" },
    ];
    const post = (url: string, headers: Record<string, string>) => server.inject({
      method: "POST",
      url,
      headers: { ...LOCAL, cookie: session.cookies, "x-csrf-token": session.csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
      payload: form([["csrf", session.csrf], ["enabled", "1"], ["required", "0"], ["understood", "yes"]]),
    });

    for (const headers of elsewhere) {
      for (const url of [...CHANGES.filter((url) => url !== "/mcp"), `/connections/${id}/writes`, `/connections/${id}/changes-confirmation`]) {
        const response = await post(url, headers);
        expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
        expect(response.body, url).toBe("Cross-site request refused");
      }
    }
    expect(application.connections.getConnection(id).writesEnabled).toBe(false);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(false);
    expect((await server.inject({ method: "GET", url: "/", headers: { ...LOCAL, cookie: session.cookies } })).statusCode).toBe(200);

    // The page's own form, as a browser sends it, and a client that is not a browser, pass.
    expect((await post(`/connections/${id}/writes`, { origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" })).statusCode).toBe(303);
    expect(application.connections.getConnection(id).writesEnabled).toBe(true);
    expect((await post("/changes-confirmation", {})).statusCode).toBe(303);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(true);
    await server.close();
  });

  it("decides before reading the body, and takes a large body only for the tunnel-client upload", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const large = Buffer.alloc(1024 * 1024, 0x61);

    // Refused by the Host before the megabyte is read, or it would be refused as too large.
    const rebound = await server.inject({
      method: "POST", url: "/login", headers: { host: "attacker.example", "content-type": "application/octet-stream" }, payload: large,
    });
    expect(rebound.statusCode).toBe(421);
    // On an ordinary route the body is refused as too large before the route checks anything, and the session stays.
    for (const url of ["/logout", "/login", "/tunnel/configure", `/connections/${ID}/writes`]) {
      for (const type of ["application/octet-stream", "application/x-www-form-urlencoded"]) {
        const response = await server.inject({
          method: "POST", url, headers: { ...LOCAL, cookie: session.cookies, "content-type": type }, payload: large,
        });
        expect(response.statusCode, `${url} ${type}`).toBe(413);
      }
    }
    expect((await server.inject({ method: "GET", url: "/", headers: { ...LOCAL, cookie: session.cookies } })).statusCode).toBe(200);
    // The upload route reads it and gets as far as its CSRF check.
    const upload = await server.inject({
      method: "POST",
      url: "/tunnel/binary",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/octet-stream", "x-csrf-token": "wrong" },
      payload: large,
    });
    expect(upload.statusCode).toBe(403);
    expect(upload.body).toBe("CSRF verification failed");
    await server.close();
  });

  it("shows no internal error on a page, and writes it to the log instead", async () => {
    const log: string[] = [];
    const server = buildHttpServer(application, { errorLog: { write: (line) => { log.push(line); } } });
    const session = await setupAdmin(server, application);
    const headers = { ...LOCAL, cookie: session.cookies };
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    application.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const { id } = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "credentials-1",
    });

    // Not found: a plain 404, without the id that was looked up.
    const missing = await server.inject({ method: "GET", url: `/connections/${ID}`, headers });
    expect([missing.statusCode, missing.body]).toEqual([404, "Not found"]);
    // A file system or database error: a 500 that names neither, with the details in the log.
    const failures = [
      Object.assign(new Error("ENOENT: no such file or directory, access '/Users/someone/.apiunicon/bin/tunnel-client'"), { code: "ENOENT" }),
      Object.assign(new Error("SQLITE_CORRUPT: database disk image is malformed"), { code: "SQLITE_CORRUPT" }),
      new TypeError("Cannot read properties of undefined (reading 'label')"),
    ];
    const lookup = vi.spyOn(application.connections, "getConnection");
    for (const failure of failures) {
      lookup.mockImplementationOnce(() => { throw failure; });
      const failed = await server.inject({ method: "GET", url: `/connections/${id}`, headers });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).toBe("Something went wrong. The details are in the APIUniCon log.");
      expect(log.join("")).toContain(failure.message.slice(0, 20));
    }
    lookup.mockRestore();
    // A request Fastify cannot read keeps its status and its words.
    const unreadable = await server.inject({
      method: "POST", url: "/logout", headers: { ...headers, "content-type": "application/json" }, payload: "{\"csrf\":",
    });
    expect(unreadable.statusCode).toBe(400);
    expect(unreadable.body).toMatch(/JSON/u);
    const unknownType = await server.inject({
      method: "POST", url: "/logout", headers: { ...headers, "content-type": "application/xml" }, payload: "<csrf/>",
    });
    expect(unknownType.statusCode).toBe(415);
    await server.close();
  });
});
