import { createHash } from "node:crypto";
import type { FastifyInstance, InjectOptions } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { CatalogOAuth, CatalogSignInExpiredError, CatalogUnavailableError } from "../../src/catalog/oauth.js";
import { CatalogSession } from "../../src/catalog/session.js";
import type { AppConfig } from "../../src/config.js";
import { linkFormToken } from "../../src/http/one-time.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import type { FetchImplementation } from "../../src/security/network-policy.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { cookieHeader, form, setupAdmin, setupTokenPath } from "../http/helpers.js";

const ORIGIN = "https://apiunicon.online";
const RU = "https://apiunicon.ru";
const CALLBACK = "http://127.0.0.1:3210/catalog/callback";
const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 36),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5, catalogOrigin: ORIGIN,
};
// The address came from the language, so this computer follows the cloud it signed in to.
const followingConfig: AppConfig = { ...config, catalogOriginExplicit: false };
const headers = { host: "127.0.0.1:3210" };
// What a browser adds to a form posted from the catalog page itself.
const fromPage = { ...headers, "sec-fetch-site": "same-origin" };

type Seen = { url: string; path: string; form: URLSearchParams; json: unknown };

// The cookie of the sign-in a browser started, which the cloud's answer has to come back with.
const SIGN_IN_COOKIE = "apiunicon_catalog_sign_in";

// The person's browser, signed in to the workspace: every request carries the workspace's cookies, and the cookie of the
// catalog sign-in it started, kept and dropped as the server says. A cookie a test sends itself comes last and wins.
function browser(server: FastifyInstance, workspace: string): FastifyInstance {
  let signIn = "";
  const inject = async (options: InjectOptions) => {
    const given = options.headers?.cookie;
    const cookie = [workspace, signIn, typeof given === "string" ? given : ""].filter((part) => part !== "").join("; ");
    const response = await server.inject({ ...options, headers: { ...options.headers, cookie } });
    for (const set of [response.headers["set-cookie"] ?? []].flat()) {
      const [pair = "", ...attributes] = String(set).split(";");
      if (pair.startsWith(`${SIGN_IN_COOKIE}=`)) signIn = attributes.some((attribute) => attribute.trim() === "Max-Age=0") ? "" : pair;
    }
    return response;
  };
  return new Proxy(server, {
    get: (target, key, receiver) => (key === "inject" ? inject : Reflect.get(target, key, receiver) as unknown),
  });
}

// A stand-in for the cloud's OAuth server. Its authorization page is played by the test: it remembers the challenge
// of the authorization URL and issues a code for it.
function fakeCloud() {
  const challenges = new Map<string, string>();
  const cloud = {
    seen: [] as Seen[],
    // Runs while the cloud is answering, as another process or page could at that moment.
    meanwhile: undefined as ((request: Seen) => void | Promise<void>) | undefined,
    registered: 0,
    refreshStatus: 200,
    refreshError: "invalid_grant",
    // A refusal of the code exchange, as the cloud would answer it.
    codeRefusal: undefined as { status: number; error: string } | undefined,
    revokeStatus: 200,
    fetchImpl: (async (input, init = {}) => {
      const url = new URL(input.toString());
      const body = typeof init.body === "string" ? init.body : "";
      const isJson = new Headers(init.headers).get("content-type") === "application/json";
      const params = new URLSearchParams(isJson ? "" : body);
      const request = { url: `${url.origin}${url.pathname}`, path: url.pathname, form: params, json: isJson ? JSON.parse(body) : null };
      cloud.seen.push(request);
      await cloud.meanwhile?.(request);
      if (url.pathname === "/oauth/register") {
        cloud.registered += 1;
        return Response.json({ client_id: `local-client-${cloud.registered}` }, { status: 201 });
      }
      if (url.pathname === "/oauth/token" && params.get("grant_type") === "refresh_token") {
        if (cloud.refreshStatus !== 200) return Response.json({ error: cloud.refreshError }, { status: cloud.refreshStatus });
        return Response.json({ access_token: "catalog-access-2", refresh_token: "catalog-refresh-2", token_type: "Bearer" });
      }
      if (url.pathname === "/oauth/token") {
        if (cloud.codeRefusal) return Response.json({ error: cloud.codeRefusal.error }, { status: cloud.codeRefusal.status });
        const challenge = challenges.get(params.get("code") ?? "");
        const verifier = params.get("code_verifier") ?? "";
        if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({ access_token: "catalog-access-1", refresh_token: "catalog-refresh-1", token_type: "Bearer" });
      }
      if (url.pathname === "/oauth/revoke") return new Response(null, { status: cloud.revokeStatus });
      return new Response("not found", { status: 404 });
    }) as FetchImplementation,
    authorize: (location: string, code: string): URL => {
      const url = new URL(location);
      challenges.set(code, url.searchParams.get("code_challenge") ?? "");
      return url;
    },
    requests: (path: string) => cloud.seen.filter((request) => request.path === path),
  };
  return cloud;
}

describe("signing in to the catalog from this computer", () => {
  let application: Application | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    application?.db.close();
  });

  // The catalog's pages need the workspace's sign-in: http is the browser of the person signed in, raw a request
  // without it.
  async function setup(appConfig: AppConfig = config) {
    const cloud = fakeCloud();
    application = buildApplication(appConfig, { resolver: async () => ["8.8.8.8"], fetchImpl: cloud.fetchImpl });
    server = buildHttpServer(application);
    const { cookies } = await setupAdmin(server, application);
    return { cloud, app: application, http: browser(server, cookies), raw: server };
  }

  async function signIn(http: FastifyInstance, cloud: ReturnType<typeof fakeCloud>) {
    const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
    const authorization = cloud.authorize(String(connect.headers.location), "code-1");
    const state = authorization.searchParams.get("state") ?? "";
    const done = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`, headers });
    return { connect, authorization, state, done };
  }

  // Another process of this person, bound to one cloud, signs in there.
  function otherProcessSignsIn(app: Application, origin: string, prefix: string) {
    const other = new CatalogSession(app.db, app.vault, origin);
    other.saveClient(CALLBACK, `${prefix}-client`, origin);
    other.saveTokens({ accessToken: `${prefix}-access`, refreshToken: `${prefix}-refresh` }, origin);
  }

  const credentialSets = (app: Application) => (app.db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n;

  it("signs in with PKCE and keeps the keys sealed", async () => {
    const { cloud, app, http } = await setup();

    const { connect, authorization, done } = await signIn(http, cloud);

    expect(connect.statusCode).toBe(302);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(`${ORIGIN}/oauth/authorize`);
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "local-client-1",
      redirect_uri: CALLBACK,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/catalog`,
      scope: "catalog",
      prompt: "consent",
    });
    expect(cloud.seen[0]).toMatchObject({
      url: `${ORIGIN}/oauth/register`,
      json: { redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" },
    });
    const token = cloud.requests("/oauth/token")[0]!;
    expect(token.url).toBe(`${ORIGIN}/oauth/token`);
    expect(token.form.get("code_verifier")).not.toBe(authorization.searchParams.get("code_challenge"));
    expect(token.form.get("resource")).toBe(`${ORIGIN}/catalog`);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("Return to the chat.");
    expect(done.body).not.toContain("catalog-access-1");
    expect(await app.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, accessToken: "catalog-access-1", refreshToken: "catalog-refresh-1" });
    // Neither key is readable in any column, nor in the sealed values.
    expect(findKeyFragment(app.db, "catalog-access-1")).toEqual([]);
    expect(findKeyFragment(app.db, "catalog-refresh-1")).toEqual([]);
    expect(JSON.stringify(app.db.prepare("select ciphertext from credential_fields").all())).not.toMatch(/catalog-(?:access|refresh)-1/u);
  });

  it.each(["image", "script", "empty", "iframe", "style"])("refuses the sign-in link when it is loaded as %s, not opened as a page", async (dest) => {
    const { cloud, http } = await setup();

    const loaded = await http.inject({ method: "GET", url: "/catalog/connect", headers: { ...headers, "sec-fetch-dest": dest } });

    expect(loaded.statusCode).toBe(403);
    expect(loaded.body).toContain("The form has expired");
    expect(loaded.headers.location).toBeUndefined();
    expect(cloud.seen).toHaveLength(0);

    // The same link opened as a page registers and leads on.
    const opened = await http.inject({ method: "GET", url: "/catalog/connect", headers: { ...headers, "sec-fetch-dest": "document" } });
    expect(opened.statusCode).toBe(302);
    expect(cloud.requests("/oauth/register")).toHaveLength(1);
  });

  it("registers this computer once per cloud and callback address", async () => {
    const { cloud, http } = await setup();

    await Promise.all([
      http.inject({ method: "GET", url: "/catalog/connect", headers }),
      http.inject({ method: "GET", url: "/catalog/connect", headers }),
    ]);
    await http.inject({ method: "GET", url: "/catalog/connect", headers });

    expect(cloud.requests("/oauth/register")).toHaveLength(1);
  });

  it("refuses a forged, reused, or declined answer without asking for keys", async () => {
    const { cloud, app, http } = await setup();
    const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
    const state = cloud.authorize(String(connect.headers.location), "code-1").searchParams.get("state") ?? "";

    const forged = await http.inject({ method: "GET", url: "/catalog/callback?code=code-1&state=forged", headers });
    const declined = await http.inject({ method: "GET", url: `/catalog/callback?error=access_denied&state=${encodeURIComponent(state)}`, headers });
    const afterDecline = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`, headers });

    expect([forged.statusCode, declined.statusCode, afterDecline.statusCode]).toEqual([400, 400, 400]);
    expect(forged.body).toContain("This sign-in has expired");
    expect(declined.body).toContain("Not signed in");
    expect(cloud.requests("/oauth/token")).toHaveLength(0);
    expect(app.localCatalog!.session.signedIn()).toBe(false);

    const { state: used } = await signIn(http, cloud);
    const replayed = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(used)}`, headers });
    expect(replayed.statusCode).toBe(400);
    expect(cloud.requests("/oauth/token")).toHaveLength(1);
  });

  it("needs the workspace's sign-in for the page, its forms and the start of a sign-in", async () => {
    const { cloud, app, http, raw } = await setup();
    await signIn(http, cloud);
    const { cookie, csrf } = await pageForm(http);
    cloud.seen.length = 0;

    const page = await raw.inject({ method: "GET", url: "/catalog", headers });
    const connect = await raw.inject({ method: "GET", url: "/catalog/connect", headers });
    const use = await postForm(raw, "/catalog/use", { ...fromPage, cookie }, [["csrf", csrf], ["use", "no"]]);
    const signOut = await postForm(raw, "/catalog/sign-out", { ...fromPage, cookie }, [["csrf", csrf]]);

    expect([page, connect, use, signOut].map(({ statusCode, headers: sent }) => [statusCode, sent.location])).toEqual([
      [303, `/login?next=${encodeURIComponent("/catalog")}`],
      [303, `/login?next=${encodeURIComponent("/catalog/connect")}`],
      [303, "/login"],
      [303, "/login"],
    ]);
    expect(cloud.seen).toEqual([]);
    expect(app.localCatalog!.session.signedIn()).toBe(true);
    expect(app.localCatalog!.session.disabled()).toBe(false);
  });

  it("takes the cloud's answer only in the browser that started the sign-in", async () => {
    const { cloud, app, http, raw } = await setup();
    const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
    const state = cloud.authorize(String(connect.headers.location), "code-1").searchParams.get("state") ?? "";
    expect(String(connect.headers["set-cookie"])).toBe(`${SIGN_IN_COOKIE}=${state}; Path=/catalog/callback; HttpOnly; SameSite=Lax; Max-Age=600`);
    const callback = `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`;

    // Another program, or another browser, with the cloud's answer but not the cookie, or with another sign-in's.
    const without = await raw.inject({ method: "GET", url: callback, headers });
    const other = await raw.inject({ method: "GET", url: callback, headers: { ...headers, cookie: `${SIGN_IN_COOKIE}=other` } });
    expect([without.statusCode, other.statusCode]).toEqual([400, 400]);
    expect(without.body).toContain("This sign-in has expired");
    expect(cloud.requests("/oauth/token")).toHaveLength(0);
    expect(app.localCatalog!.session.signedIn()).toBe(false);

    // The browser that started it still finishes it, and its cookie goes with the answer.
    const done = await http.inject({ method: "GET", url: callback, headers });
    expect(done.statusCode).toBe(200);
    expect(String(done.headers["set-cookie"])).toBe(`${SIGN_IN_COOKIE}=; Path=/catalog/callback; HttpOnly; SameSite=Lax; Max-Age=0`);
    expect(app.localCatalog!.session.signedIn()).toBe(true);
  });

  it("forgets a sign-in after ten minutes", async () => {
    const { app, cloud } = await setup();
    let clock = 1_000_000;
    const oauth = new CatalogOAuth({
      session: new CatalogSession(app.db, app.vault, ORIGIN),
      callbackUrl: CALLBACK,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: cloud.fetchImpl,
      now: () => clock,
    });
    const state = new URL(await oauth.start()).searchParams.get("state") ?? "";

    clock += 10 * 60_000;

    await expect(oauth.finish("code-1", state)).rejects.toBeInstanceOf(CatalogSignInExpiredError);
    expect(cloud.requests("/oauth/token")).toHaveLength(0);
  });

  it("signs out by revoking the keys in the cloud and erasing them here", async () => {
    const { cloud, app, http } = await setup();
    await signIn(http, cloud);
    const page = await http.inject({ method: "GET", url: "/catalog", headers });
    const cookie = cookieHeader(page);
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    expect(page.body).toContain("This computer is signed in to the catalog.");
    expect(page.body).toContain("apiunicon.online");
    const post = (token: string) => http.inject({
      method: "POST", url: "/catalog/sign-out",
      headers: { ...fromPage, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", token]]),
    });

    expect((await post("forged")).statusCode).toBe(403);
    expect(app.localCatalog!.session.signedIn()).toBe(true);
    const signedOut = await post(csrf);

    expect(signedOut.body).toContain("The catalog key is revoked and erased from this computer.");
    expect(cloud.requests("/oauth/revoke").map(({ url, form: sent }) => [url, sent.get("token"), sent.get("client_id")])).toEqual([
      [`${ORIGIN}/oauth/revoke`, "catalog-refresh-1", "local-client-1"],
      [`${ORIGIN}/oauth/revoke`, "catalog-access-1", "local-client-1"],
    ]);
    expect(await app.localCatalog!.session.tokens()).toBeNull();
  });

  it("turns the catalog off and on from its page", async () => {
    const { app, http } = await setup();
    const page = await http.inject({ method: "GET", url: "/catalog", headers });
    const cookie = cookieHeader(page);
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    expect(page.body).toContain('href="/catalog/connect"');
    const use = (value: string) => http.inject({
      method: "POST", url: "/catalog/use",
      headers: { ...fromPage, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["use", value]]),
    });

    expect((await use("no")).statusCode).toBe(303);
    expect(app.localCatalog!.session.disabled()).toBe(true);
    expect((await http.inject({ method: "GET", url: "/catalog", headers })).body).toContain("Use the catalog");
    await use("yes");
    expect(app.localCatalog!.session.disabled()).toBe(false);
  });

  // The page's own cookie and form token, as the catalog page hands them out.
  async function pageForm(http: FastifyInstance) {
    const page = await http.inject({ method: "GET", url: "/catalog", headers });
    return { cookie: cookieHeader(page), csrf: /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "" };
  }

  function postForm(http: FastifyInstance, path: string, requestHeaders: Record<string, string>, fields: Array<[string, string]>) {
    return http.inject({
      method: "POST", url: path,
      headers: { ...requestHeaders, "content-type": "application/x-www-form-urlencoded" },
      payload: form(fields),
    });
  }

  it("refuses a form posted from another page on this computer, even with a planted cookie and its token", async () => {
    const { cloud, app, http } = await setup();
    await signIn(http, cloud);
    // Another program on 127.0.0.1 can set a cookie for this host, since cookies do not tell ports apart.
    const planted = { cookie: "apiunicon_catalog=planted", csrf: linkFormToken("catalog", "planted") };
    const elsewhere = { ...headers, "sec-fetch-site": "same-site", origin: "http://127.0.0.1:9999", cookie: planted.cookie };

    const use = await postForm(http, "/catalog/use", elsewhere, [["csrf", planted.csrf], ["use", "no"]]);
    const signOut = await postForm(http, "/catalog/sign-out", elsewhere, [["csrf", planted.csrf]]);
    // A request that says nothing about where it comes from is refused too.
    const silent = await postForm(http, "/catalog/use", { ...headers, cookie: planted.cookie }, [["csrf", planted.csrf], ["use", "no"]]);

    expect([use.statusCode, signOut.statusCode, silent.statusCode]).toEqual([403, 403, 403]);
    expect(use.body).toContain("The form has expired");
    expect(app.localCatalog!.session.disabled()).toBe(false);
    expect(app.localCatalog!.session.signedIn()).toBe(true);
    expect(cloud.requests("/oauth/revoke")).toHaveLength(0);

    // The same planted pair from this very page is the double-submit check working as designed.
    await postForm(http, "/catalog/use", { ...fromPage, cookie: planted.cookie }, [["csrf", planted.csrf], ["use", "no"]]);
    expect(app.localCatalog!.session.disabled()).toBe(true);
  });

  it("accepts the page's own form by its Origin when the browser sends no Sec-Fetch-Site", async () => {
    const { app, http } = await setup();
    const { cookie, csrf } = await pageForm(http);

    await postForm(http, "/catalog/use", { ...headers, origin: "http://127.0.0.1:3210", cookie }, [["csrf", csrf], ["use", "no"]]);

    expect(app.localCatalog!.session.disabled()).toBe(true);
  });

  it("accepts the page's own form from localhost or [::1] on the page's port, as the request itself says", async () => {
    const { app, http } = await setup();
    const { cookie, csrf } = await pageForm(http);
    type Form = { host: string; origin?: string; site?: string };
    const post = ({ host, origin, site }: Form) => postForm(
      http, "/catalog/use",
      { host, cookie, ...(origin === undefined ? {} : { origin }), ...(site === undefined ? {} : { "sec-fetch-site": site }) },
      [["csrf", csrf], ["use", "no"]],
    );
    const accepted: Form[] = [
      { host: "127.0.0.1:3210", origin: "http://127.0.0.1:3210" },
      { host: "localhost:3210", origin: "http://localhost:3210" },
      { host: "[::1]:3210", origin: "http://[::1]:3210" },
      // A browser that sends Sec-Fetch-Site decides by it alone.
      { host: "localhost:3210", site: "same-origin" },
    ];
    const refused: Form[] = [
      // Another port, another scheme, or a host that only starts like a loopback one is not this page.
      { host: "localhost:3210", origin: "http://localhost:9999" },
      { host: "localhost:3210", origin: "https://localhost:3210" },
      { host: "localhost:3210", origin: "http://localhost.example:3210" },
      { host: "localhost:3210", origin: "null" },
      { host: "[::1]:3210", origin: "http://[::1]:9999" },
      // The Origin has to be the very host the request was made to, not just another name of this computer.
      { host: "127.0.0.1:3210", origin: "http://localhost:3210" },
      { host: "localhost:3210", origin: "http://[::1]:3210" },
      // Sec-Fetch-Site, when sent, outranks a valid Origin.
      { host: "localhost:3210", origin: "http://localhost:3210", site: "same-site" },
      { host: "localhost:3210", origin: "http://localhost:3210", site: "cross-site" },
      { host: "localhost:3210", origin: "http://localhost:3210", site: "none" },
      // Neither header says where the form comes from.
      { host: "localhost:3210" },
    ];

    for (const row of [...accepted, ...refused]) {
      app.localCatalog!.session.setDisabled(false);
      const response = await post(row);
      const isAccepted = accepted.includes(row);
      expect(response.statusCode, JSON.stringify(row)).toBe(isAccepted ? 303 : 403);
      expect(app.localCatalog!.session.disabled(), JSON.stringify(row)).toBe(isAccepted);
    }
  });

  it("sends Referrer-Policy same-origin, so the browser names the page's origin on its forms", async () => {
    const { http } = await setup();

    const page = await http.inject({ method: "GET", url: "/catalog", headers });
    const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
    const callback = await http.inject({ method: "GET", url: "/catalog/callback", headers });
    const expired = await postForm(http, "/catalog/use", headers, [["use", "no"]]);

    expect([page.statusCode, connect.statusCode, callback.statusCode, expired.statusCode]).toEqual([200, 302, 400, 403]);
    for (const response of [page, connect, callback, expired]) {
      expect(response.headers["referrer-policy"]).toBe("same-origin");
    }
    // The whole local server does, for the same reason: under no-referrer a browser words a form's Origin as "null".
    expect((await http.inject({ method: "GET", url: "/health", headers })).headers["referrer-policy"]).toBe("same-origin");
  });

  it("refuses to change the catalog setting with a forged token or without the cookie", async () => {
    const { app, http } = await setup();
    const { cookie, csrf } = await pageForm(http);

    await postForm(http, "/catalog/use", { ...fromPage, cookie }, [["csrf", "forged"], ["use", "no"]]);
    await postForm(http, "/catalog/use", fromPage, [["csrf", csrf], ["use", "no"]]);
    await postForm(http, "/catalog/use", { ...fromPage, cookie: "apiunicon_catalog=other" }, [["csrf", csrf], ["use", "no"]]);

    expect(app.localCatalog!.session.disabled()).toBe(false);
  });

  it("never shows the error a callback carries", async () => {
    const { http } = await setup();

    const response = await http.inject({
      method: "GET",
      url: `/catalog/callback?error=${encodeURIComponent("<script>alert(1)</script>")}&error_description=${encodeURIComponent("<b>pwned</b>")}&state=x`,
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Not signed in");
    expect(response.body).not.toContain("alert(1)");
    expect(response.body).not.toContain("<script>");
    expect(response.body).not.toContain("pwned");
  });

  it("still finishes a sign-in a moment before ten minutes have passed", async () => {
    const { app, cloud } = await setup();
    let clock = 1_000_000;
    const session = new CatalogSession(app.db, app.vault, ORIGIN);
    const oauth = new CatalogOAuth({ session, callbackUrl: CALLBACK, resolver: async () => ["8.8.8.8"], fetchImpl: cloud.fetchImpl, now: () => clock });
    const state = cloud.authorize(await oauth.start(), "code-1").searchParams.get("state") ?? "";

    clock += 9 * 60_000 + 59_000;
    await oauth.finish("code-1", state);

    expect(await session.tokens()).toEqual({ origin: ORIGIN, accessToken: "catalog-access-1", refreshToken: "catalog-refresh-1" });
  });

  describe("signing out", () => {
    async function signOutFromPage(http: FastifyInstance) {
      const { cookie, csrf } = await pageForm(http);
      return postForm(http, "/catalog/sign-out", { ...fromPage, cookie }, [["csrf", csrf]]);
    }

    it.each([503, 429])("erases the keys and says the cloud did not confirm the revocation when it answers HTTP %i", async (status) => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.revokeStatus = status;

      const signedOut = await signOutFromPage(http);

      expect(cloud.requests("/oauth/revoke")).toHaveLength(1);
      expect(signedOut.body).toContain("The cloud did not confirm the revocation, so the key expires there on its own.");
      expect(signedOut.body).not.toContain("did not answer");
      expect(signedOut.body).not.toContain("revoked");
      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(credentialSets(app)).toBe(0);
    });

    it("does not claim to have asked the cloud when no client is known for the keys", async () => {
      const { cloud, app, http } = await setup();
      app.localCatalog!.session.saveTokens({ accessToken: "orphan-access", refreshToken: "orphan-refresh" }, ORIGIN);

      const signedOut = await signOutFromPage(http);

      expect(cloud.seen).toHaveLength(0);
      expect(signedOut.body).toContain("No catalog key is left on this computer.");
      expect(signedOut.body).not.toContain("revoked");
      expect(signedOut.body).not.toContain("did not confirm");
      expect(await app.localCatalog!.session.tokens()).toBeNull();
    });

    it("does not claim to have asked the cloud when the stored keys belong to another one", async () => {
      // The address is fixed by APIUNICON_CATALOG_ORIGIN, and another process stored keys of another cloud.
      const { cloud, app } = await setup({ ...config, catalogOriginExplicit: true });
      otherProcessSignsIn(app, RU, "ru");

      expect(await app.localCatalog!.oauth.signOut()).toBe("not_asked");

      expect(cloud.seen).toHaveLength(0);
      expect(credentialSets(app)).toBe(0);
    });

    it.each([400, 401])("erases the keys and says the cloud refused when the revocation answers HTTP %i", async (status) => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.revokeStatus = status;

      const signedOut = await signOutFromPage(http);

      expect(signedOut.statusCode).toBe(200);
      expect(signedOut.body).toContain("The catalog key is erased from this computer. The cloud refused to revoke it, so it expires there on its own.");
      expect(signedOut.body).not.toContain("did not confirm");
      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(credentialSets(app)).toBe(0);
    });

    it("answers refused from the sign-out itself, and not_answered when the cloud is only busy or silent", async () => {
      const { cloud, app, http } = await setup();
      const outcome = async (status: number) => {
        await signIn(http, cloud);
        cloud.revokeStatus = status;
        return app.localCatalog!.oauth.signOut();
      };

      // A rate limit and a timeout the cloud reports are passing, like the same answers to a refresh.
      expect([await outcome(400), await outcome(403), await outcome(429), await outcome(408), await outcome(500)])
        .toEqual(["refused", "refused", "not_answered", "not_answered", "not_answered"]);
    });

    it("keeps the other cloud's client on a sign-out", async () => {
      const { cloud, app, http } = await setup(followingConfig);
      const { session } = app.localCatalog!;
      session.saveClient(CALLBACK, "ru-client", RU);
      await signIn(http, cloud);
      expect(session.clientId(CALLBACK, ORIGIN)).toBe("local-client-1");
      expect(session.origin).toBe(ORIGIN);

      expect(await app.localCatalog!.oauth.signOut()).toBe("revoked");

      expect(session.clientId(CALLBACK, RU)).toBe("ru-client");
      expect(session.clientId(CALLBACK, ORIGIN)).toBeNull();
    });

    it("drops a sign-in begun before signing out, so its answer keeps no keys", async () => {
      const { cloud, app } = await setup();
      const { oauth, session } = app.localCatalog!;
      const state = cloud.authorize(await oauth.start(), "code-1").searchParams.get("state") ?? "";

      await oauth.signOut();

      await expect(oauth.finish("code-1", state)).rejects.toBeInstanceOf(CatalogSignInExpiredError);
      expect(cloud.requests("/oauth/token")).toHaveLength(0);
      expect(session.signedIn()).toBe(false);
      expect(credentialSets(app)).toBe(0);
    });

    it("refuses the answer of a sign-in begun while signed in, even one that arrives during the revocation", async () => {
      const { cloud, app, http } = await setup();
      const { oauth, session } = app.localCatalog!;
      await signIn(http, cloud);
      const begun = cloud.authorize(await oauth.start(), "code-2").searchParams.get("state") ?? "";
      let answered = false;
      cloud.meanwhile = async (request) => {
        // The person finishes the other sign-in while the cloud is still answering the revocation.
        if (request.path !== "/oauth/revoke" || answered) return;
        answered = true;
        await expect(oauth.finish("code-2", begun)).rejects.toBeInstanceOf(CatalogSignInExpiredError);
      };

      expect(await oauth.signOut()).toBe("revoked");

      expect(answered).toBe(true);
      expect(cloud.requests("/oauth/token")).toHaveLength(1);
      expect(session.signedIn()).toBe(false);
      expect(credentialSets(app)).toBe(0);
    });

    it("keeps no keys of a sign-in whose code exchange is still being answered when the person signs out", async () => {
      const { cloud, app, http } = await setup();
      const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
      const state = cloud.authorize(String(connect.headers.location), "code-1").searchParams.get("state") ?? "";
      cloud.meanwhile = async (request) => {
        if (request.path === "/oauth/token") await app.localCatalog!.oauth.signOut();
      };

      const done = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`, headers });

      expect(cloud.requests("/oauth/token")).toHaveLength(1);
      expect(done.statusCode).toBe(409);
      expect(done.body).toContain("The sign-in did not complete");
      expect(done.body).not.toContain("Return to the chat.");
      expect(app.localCatalog!.session.signedIn()).toBe(false);
      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(credentialSets(app)).toBe(0);

      // The sign-out ends the sign-ins begun before it, not the ones that come after.
      cloud.meanwhile = undefined;
      const again = await signIn(http, cloud);
      expect(again.done.statusCode).toBe(200);
      expect(app.localCatalog!.session.signedIn()).toBe(true);
    });

    it("keeps a sign-in begun with the other cloud", async () => {
      const { cloud, app } = await setup(followingConfig);
      const { oauth, session } = app.localCatalog!;
      const online = cloud.authorize(await oauth.start(), "code-1").searchParams.get("state") ?? "";
      otherProcessSignsIn(app, RU, "ru");
      const ru = cloud.authorize(await oauth.start(), "code-2").searchParams.get("state") ?? "";
      expect(session.origin).toBe(RU);

      expect(await oauth.signOut()).toBe("revoked");

      await expect(oauth.finish("code-2", ru)).rejects.toBeInstanceOf(CatalogSignInExpiredError);
      await oauth.finish("code-1", online);
      expect(await session.tokens()).toEqual({ origin: ORIGIN, accessToken: "catalog-access-1", refreshToken: "catalog-refresh-1" });
      expect(cloud.requests("/oauth/token").map(({ url }) => url)).toEqual([`${ORIGIN}/oauth/token`]);
    });

    it("registers anew on the next sign-in", async () => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);

      expect(await app.localCatalog!.oauth.signOut()).toBe("revoked");
      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBeNull();
      const { authorization, done } = await signIn(http, cloud);

      expect(cloud.requests("/oauth/register")).toHaveLength(2);
      expect(authorization.searchParams.get("client_id")).toBe("local-client-2");
      expect(done.statusCode).toBe(200);
      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBe("local-client-2");
    });
  });

  describe("when the cloud no longer knows this computer's client", () => {
    it.each([400, 401])("registers anew after the code exchange is refused with invalid_client (HTTP %i)", async (status) => {
      const { cloud, app, http } = await setup();
      cloud.codeRefusal = { status, error: "invalid_client" };

      const { done } = await signIn(http, cloud);

      expect(done.statusCode).toBe(400);
      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBeNull();
      cloud.codeRefusal = undefined;
      const again = await signIn(http, cloud);
      expect(again.authorization.searchParams.get("client_id")).toBe("local-client-2");
      expect(again.done.statusCode).toBe(200);
      expect(app.localCatalog!.session.signedIn()).toBe(true);
    });

    it.each([400, 401])("erases the keys and registers anew after a refresh is refused with invalid_client (HTTP %i)", async (status) => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.refreshStatus = status;
      cloud.refreshError = "invalid_client";

      expect(await app.localCatalog!.oauth.refresh()).toBeNull();

      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBeNull();
      const again = await signIn(http, cloud);
      expect(cloud.requests("/oauth/register")).toHaveLength(2);
      expect(again.authorization.searchParams.get("client_id")).toBe("local-client-2");
    });

    it("keeps the client when a refusal is about the code or the key, not the client", async () => {
      const { cloud, app, http } = await setup();
      cloud.codeRefusal = { status: 400, error: "invalid_grant" };
      await signIn(http, cloud);
      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBe("local-client-1");

      cloud.codeRefusal = undefined;
      await signIn(http, cloud);
      cloud.refreshStatus = 400;
      expect(await app.localCatalog!.oauth.refresh()).toBeNull();

      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBe("local-client-1");
      expect(cloud.requests("/oauth/register")).toHaveLength(1);
    });

    it("keeps a client registered meanwhile when the old one is refused", async () => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.refreshStatus = 401;
      cloud.refreshError = "invalid_client";
      cloud.meanwhile = (request) => {
        if (request.form.get("grant_type") === "refresh_token") app.localCatalog!.session.saveClient(CALLBACK, "newer-client", ORIGIN);
      };

      await app.localCatalog!.oauth.refresh();

      expect(app.localCatalog!.session.clientId(CALLBACK, ORIGIN)).toBe("newer-client");
    });
  });

  it("answers only on the loopback address", async () => {
    const { http } = await setup();

    const response = await http.inject({ method: "GET", url: "/catalog/connect", headers: { host: "attacker.example" } });

    expect(response.statusCode).toBe(421);
  });

  describe("when the cloud changes or the person signs out meanwhile", () => {
    it("does not finish a sign-in begun with a cloud this computer no longer uses", async () => {
      const { cloud, app, http } = await setup(followingConfig);
      app.localCatalog!.session.setDisabled(true);
      const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
      const state = cloud.authorize(String(connect.headers.location), "code-1").searchParams.get("state") ?? "";

      otherProcessSignsIn(app, RU, "ru");
      const done = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`, headers });

      expect(done.statusCode).toBe(409);
      expect(done.body).toContain("The sign-in did not complete");
      expect(done.body).not.toContain("Return to the chat.");
      expect(cloud.requests("/oauth/token")).toHaveLength(0);
      expect(await app.localCatalog!.session.tokens()).toEqual({ origin: RU, accessToken: "ru-access", refreshToken: "ru-refresh" });
      expect(app.localCatalog!.session.disabled()).toBe(true);
    });

    it("drops the keys of a sign-in when the cloud changed while they were being issued", async () => {
      const { cloud, app, http } = await setup(followingConfig);
      app.localCatalog!.session.setDisabled(true);
      const connect = await http.inject({ method: "GET", url: "/catalog/connect", headers });
      const state = cloud.authorize(String(connect.headers.location), "code-1").searchParams.get("state") ?? "";
      cloud.meanwhile = (request) => {
        if (request.path === "/oauth/token") otherProcessSignsIn(app, RU, "ru");
      };

      const done = await http.inject({ method: "GET", url: `/catalog/callback?code=code-1&state=${encodeURIComponent(state)}`, headers });

      expect(cloud.requests("/oauth/token").map(({ url }) => url)).toEqual([`${ORIGIN}/oauth/token`]);
      expect(done.statusCode).toBe(409);
      expect(done.body).toContain("The sign-in did not complete");
      expect(await app.localCatalog!.session.tokens()).toEqual({ origin: RU, accessToken: "ru-access", refreshToken: "ru-refresh" });
      expect(await new CatalogSession(app.db, app.vault, ORIGIN).tokens()).toBeNull();
      expect(credentialSets(app)).toBe(1);
      expect(app.localCatalog!.session.disabled()).toBe(true);
    });

    it("refreshes the keys in the cloud that issued them and sends them nowhere else", async () => {
      const { cloud, app } = await setup(followingConfig);
      otherProcessSignsIn(app, RU, "ru");
      expect(app.localCatalog!.session.origin).toBe(RU);

      const refreshed = await app.localCatalog!.oauth.refresh();

      expect(refreshed).toEqual({ origin: RU, accessToken: "catalog-access-2", refreshToken: "catalog-refresh-2" });
      expect(await app.localCatalog!.session.tokens()).toEqual(refreshed);
      const [request] = cloud.seen;
      expect(cloud.seen).toHaveLength(1);
      expect(request!.url).toBe(`${RU}/oauth/token`);
      expect(Object.fromEntries(request!.form)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "ru-refresh",
        client_id: "ru-client",
        resource: `${RU}/catalog`,
      });
    });

    it("revokes the keys only in their own cloud, even when the cloud changes during the sign-out", async () => {
      const { cloud, app } = await setup(followingConfig);
      otherProcessSignsIn(app, RU, "ru");
      cloud.meanwhile = (request) => {
        // Another process signs out after the first revocation; this computer goes back to its language default.
        if (request.path === "/oauth/revoke") new CatalogSession(app.db, app.vault, RU).clearTokens();
      };

      expect(await app.localCatalog!.oauth.signOut()).toBe("revoked");

      expect(app.localCatalog!.session.origin).toBe(ORIGIN);
      expect(cloud.seen.map(({ url, form: sent }) => [url, sent.get("token"), sent.get("client_id")])).toEqual([
        [`${RU}/oauth/revoke`, "ru-refresh", "ru-client"],
        [`${RU}/oauth/revoke`, "ru-access", "ru-client"],
      ]);
    });

    it("lets a sign-out stand when the refresh answer arrives after it", async () => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.meanwhile = async (request) => {
        if (request.form.get("grant_type") === "refresh_token") await app.localCatalog!.oauth.signOut();
      };

      expect(await app.localCatalog!.oauth.refresh()).toBeNull();

      expect(app.localCatalog!.session.signedIn()).toBe(false);
      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(credentialSets(app)).toBe(0);
    });

    it("uses keys another request stored meanwhile instead of its own late ones", async () => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);
      cloud.meanwhile = (request) => {
        if (request.form.get("grant_type") === "refresh_token") otherProcessSignsIn(app, ORIGIN, "newer");
      };

      const refreshed = await app.localCatalog!.oauth.refresh();

      expect(refreshed).toEqual({ origin: ORIGIN, accessToken: "newer-access", refreshToken: "newer-refresh" });
      expect(await app.localCatalog!.session.tokens()).toEqual(refreshed);
    });

    it("erases the keys the cloud refuses to refresh, and keeps them when the cloud is only busy", async () => {
      const { cloud, app, http } = await setup();
      await signIn(http, cloud);

      cloud.refreshStatus = 429;
      await expect(app.localCatalog!.oauth.refresh()).rejects.toThrow("HTTP 429");
      expect(app.localCatalog!.session.signedIn()).toBe(true);
      // A timeout the cloud reports is temporary too.
      cloud.refreshStatus = 408;
      await expect(app.localCatalog!.oauth.refresh()).rejects.toBeInstanceOf(CatalogUnavailableError);
      expect(await app.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, accessToken: "catalog-access-1", refreshToken: "catalog-refresh-1" });

      cloud.refreshStatus = 400;
      expect(await app.localCatalog!.oauth.refresh()).toBeNull();
      expect(await app.localCatalog!.session.tokens()).toBeNull();
      expect(credentialSets(app)).toBe(0);
    });

    it("keeps a newer sign-in to another cloud when a refresh is refused", async () => {
      const { cloud, app } = await setup(followingConfig);
      otherProcessSignsIn(app, RU, "ru");
      cloud.refreshStatus = 400;
      cloud.meanwhile = (request) => {
        if (request.form.get("grant_type") === "refresh_token") otherProcessSignsIn(app, ORIGIN, "online");
      };

      expect(await app.localCatalog!.oauth.refresh()).toBeNull();

      expect(cloud.seen.map(({ url }) => url)).toEqual([`${RU}/oauth/token`]);
      expect(await app.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, accessToken: "online-access", refreshToken: "online-refresh" });
    });
  });
});
