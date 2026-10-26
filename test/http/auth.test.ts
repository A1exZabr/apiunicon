import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { cookieHeader, cookieValue, form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

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

describe("web administrator flow", () => {
  let application: Application;
  let db: Database.Database;

  beforeEach(() => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("docs", { status: 200 }),
    });
    db = application.db;
  });

  afterEach(() => db.close());

  const setupForm = (fields: Array<[string, string]>, headers: Record<string, string> = {}) => ({
    method: "POST" as const,
    url: "/setup",
    headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded", ...headers },
    payload: form(fields),
  });
  const passwords: Array<[string, string]> = [
    ["password", "correct horse battery staple"],
    ["confirmPassword", "correct horse battery staple"],
  ];

  it("redirects an unconfigured installation to first-run setup, which opens only with the setup link", async () => {
    const server = buildHttpServer(application);
    const token = application.setupToken!.issue();

    const root = await server.inject({ method: "GET", url: "/", headers: LOCAL });
    expect(root.statusCode).toBe(303);
    expect(root.headers.location).toBe("/setup");
    // Without the token, or with another, the page says where the link is and offers no form.
    for (const url of ["/setup", "/setup?t=", `/setup?t=${"A".repeat(43)}`, `/setup?t=${token}x`]) {
      const refused = await server.inject({ method: "GET", url, headers: LOCAL });
      expect(refused.statusCode, url).toBe(403);
      expect(refused.body, url).toContain("Open the setup link");
      expect(refused.body, url).toContain("npm run --silent setup-link");
      expect(refused.body, url).not.toContain("<form");
    }
    const setup = await server.inject({ method: "GET", url: `/setup?t=${token}`, headers: LOCAL });
    expect(setup.statusCode).toBe(200);
    expect(setup.body).toContain("Create local administrator");
    expect(setup.body).toContain(`<input type="hidden" name="t" value="${token}">`);
    await server.close();
  });

  it("sets up the administrator once with the setup token and issues private session and CSRF cookies", async () => {
    const server = buildHttpServer(application);
    const token = application.setupToken!.issue();

    const setup = await server.inject(setupForm([["t", token], ...passwords]));

    expect(setup.statusCode).toBe(303);
    expect(setup.headers.location).toBe("/");
    const cookies = cookieHeader(setup);
    expect(cookieValue(cookies, "apiunicon_session")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(cookieValue(cookies, "apiunicon_csrf")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    const rawSetCookie = JSON.stringify(setup.headers["set-cookie"]);
    expect(rawSetCookie).toContain("HttpOnly");
    expect(rawSetCookie).toContain("SameSite=Strict");
    // The token is spent: the file is gone, and the setup page now leads to the workspace.
    expect(existsSync(config.setupTokenPath!)).toBe(false);
    expect(application.setupToken!.matches(token)).toBe(false);
    const again = await server.inject(setupForm([["t", token], ["password", "another long password"], ["confirmPassword", "another long password"]]));
    expect([again.statusCode, again.headers.location]).toEqual([303, "/"]);
    expect(cookieHeader(again)).toBe("");

    const dashboard = await server.inject({
      method: "GET",
      url: "/",
      headers: { ...LOCAL, cookie: cookies },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("Your API workspace");
    await server.close();
  });

  it("refuses a setup without the token, with a wrong one, or from another site, and keeps the token for the person", async () => {
    const server = buildHttpServer(application);
    const token = application.setupToken!.issue();

    const refused = [
      setupForm(passwords),
      setupForm([["t", ""], ...passwords]),
      setupForm([["t", "A".repeat(43)], ...passwords]),
      setupForm([["t", token.slice(0, -1)], ...passwords]),
      // A form on another site, or one of another program on this computer, even with the right token.
      setupForm([["t", token], ...passwords], { origin: "http://evil.example" }),
      setupForm([["t", token], ...passwords], { origin: "http://127.0.0.1:9999" }),
      setupForm([["t", token], ...passwords], { origin: "null" }),
      setupForm([["t", token], ...passwords], { "sec-fetch-site": "cross-site" }),
      setupForm([["t", token], ...passwords], { "sec-fetch-site": "same-site" }),
    ];
    for (const request of refused) {
      const response = await server.inject(request);
      expect(response.statusCode, JSON.stringify(request)).toBe(403);
      expect(cookieHeader(response)).toBe("");
    }
    // A mismatch or a short password is the person's to fix, with the same token.
    const mismatch = await server.inject(setupForm([["t", token], ["password", "correct horse battery staple"], ["confirmPassword", "other"]]));
    const short = await server.inject(setupForm([["t", token], ["password", "short"], ["confirmPassword", "short"]]));
    expect([mismatch.statusCode, short.statusCode]).toEqual([400, 400]);
    expect(short.body).toContain("at least 12 characters");
    expect(application.auth.isSetup()).toBe(false);
    expect(application.setupToken!.matches(token)).toBe(true);

    // The page's own form, as the browser sends it.
    const own = await server.inject(setupForm([["t", token], ...passwords], { origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" }));
    expect(own.statusCode).toBe(303);
    expect(application.auth.isSetup()).toBe(true);
    await server.close();
  });

  it("requires login after setup and does not reflect a rejected password", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const logout = await server.inject({
      method: "POST",
      url: "/logout",
      headers: {
        ...LOCAL,
        cookie: session.cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: form([["csrf", session.csrf]]),
    });
    expect(logout.statusCode).toBe(303);

    const root = await server.inject({ method: "GET", url: "/", headers: LOCAL });
    expect(root.statusCode).toBe(303);
    expect(root.headers.location).toBe("/login");

    const rejectedPassword = "incorrect secret password";
    const rejected = await server.inject({
      method: "POST",
      url: "/login",
      headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["password", rejectedPassword]]),
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).toContain("Password was not accepted");
    expect(rejected.body).not.toContain(rejectedPassword);
    await server.close();
  });

  it("rejects authenticated mutations without the matching CSRF token", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);

    const response = await server.inject({
      method: "POST",
      url: "/logout",
      headers: {
        ...LOCAL,
        cookie: session.cookies,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: form([["csrf", "wrong-token"]]),
    });

    expect(response.statusCode).toBe(403);
    const stillAuthenticated = await server.inject({
      method: "GET",
      url: "/",
      headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(stillAuthenticated.statusCode).toBe(200);
    await server.close();
  });

  it("locks the sign-in after five wrong passwords for a minute, doubling with each wrong one after, and says how long", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
      const server = buildHttpServer(application);
      await setupAdmin(server, application);
      const signIn = (password: string) => server.inject({
        method: "POST",
        url: "/login",
        headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["password", password]]),
      });
      const wait = (milliseconds: number) => vi.setSystemTime(Date.now() + milliseconds);

      for (let attempt = 1; attempt <= 5; attempt += 1) expect((await signIn("wrong password here")).statusCode).toBe(401);
      // Locked: even the right password is not checked.
      const locked = await signIn("correct horse battery staple");
      expect(locked.statusCode).toBe(429);
      expect(locked.body).toContain("Too many wrong passwords. Try again in 1 minute.");
      wait(30_000);
      expect((await signIn("correct horse battery staple")).body).toContain("Try again in 30 seconds.");

      // The lock runs out; the next wrong password locks for two minutes, then four.
      wait(30_001);
      expect((await signIn("wrong password here")).statusCode).toBe(401);
      expect((await signIn("correct horse battery staple")).body).toContain("Try again in 2 minutes.");
      wait(120_000);
      expect((await signIn("wrong password here")).statusCode).toBe(401);
      expect((await signIn("correct horse battery staple")).body).toContain("Try again in 4 minutes.");

      // The right password after the lock signs in and starts the count again.
      wait(240_000);
      expect((await signIn("correct horse battery staple")).statusCode).toBe(303);
      for (let attempt = 1; attempt <= 5; attempt += 1) expect((await signIn("wrong password here")).statusCode).toBe(401);
      expect((await signIn("correct horse battery staple")).body).toContain("Try again in 1 minute.");
      await server.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends every session when the workspace is locked, not only the one that asked", async () => {
    const server = buildHttpServer(application);
    const first = await setupAdmin(server, application);
    const other = await server.inject({
      method: "POST",
      url: "/login",
      headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["password", "correct horse battery staple"]]),
    });
    const second = cookieHeader(other);
    for (const cookies of [first.cookies, second]) {
      expect((await server.inject({ method: "GET", url: "/", headers: { ...LOCAL, cookie: cookies } })).statusCode).toBe(200);
    }

    const locked = await server.inject({
      method: "POST",
      url: "/logout",
      headers: { ...LOCAL, cookie: first.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", first.csrf]]),
    });

    expect(locked.statusCode).toBe(303);
    for (const cookies of [first.cookies, second]) {
      const page = await server.inject({ method: "GET", url: "/", headers: { ...LOCAL, cookie: cookies } });
      expect([page.statusCode, page.headers.location]).toEqual([303, "/login"]);
    }
    await server.close();
  });
});
