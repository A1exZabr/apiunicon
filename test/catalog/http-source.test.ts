import { afterEach, describe, expect, it } from "vitest";

import { CATALOG_TIMEOUT_MS, HttpCatalogSource } from "../../src/catalog/http-source.js";
import { CatalogSession } from "../../src/catalog/session.js";
import type { CatalogSource } from "../../src/catalog/source.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import type { FetchImplementation } from "../../src/security/network-policy.js";
import { WB_ENTRY_ID, WB_LINK, wbEntry } from "../fixtures/catalog.js";
import { draftSetup } from "../helpers/setup.js";

const ORIGIN = "https://apiunicon.online";
const RU = "https://apiunicon.ru";
const CALLBACK = "http://127.0.0.1:3210/catalog/callback";
const SIGN_IN = { kind: "sign_in", url: "http://127.0.0.1:3210/catalog/connect" };
const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 37),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5, catalogOrigin: ORIGIN,
};
// The address came from the language, so this computer follows the cloud it signed in to.
const followingConfig: AppConfig = { ...config, catalogOriginExplicit: false };

type Request = { method: string; url: URL; authorization: string | null; body: string };
type Route = (request: Request) => Response | Promise<Response>;

// The cloud's catalog and token addresses on every cloud; an unknown address answers 404.
function cloud(routes: Record<string, Route>) {
  const requests: Request[] = [];
  const fetchImpl: FetchImplementation = async (input, init = {}) => {
    const request: Request = {
      method: init.method ?? "GET",
      url: new URL(input.toString()),
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? init.body : "",
    };
    requests.push(request);
    const route = routes[`${request.method} ${request.url.pathname}`];
    return route ? route(request) : new Response("not found", { status: 404 });
  };
  return { fetchImpl, requests };
}

const tokenRequests = (requests: Request[]) => requests.filter(({ url }) => url.pathname === "/oauth/token");
const keysOf = (access: string, refresh: string) => ({ accessToken: access, refreshToken: refresh });

describe("the local catalog client", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function signedIn(fetchImpl: FetchImplementation, appConfig: AppConfig = config): Application {
    application = buildApplication(appConfig, { resolver: async () => ["8.8.8.8"], fetchImpl });
    application.localCatalog!.session.saveClient(CALLBACK, "local-client-1", ORIGIN);
    application.localCatalog!.session.saveTokens(keysOf("access-1", "refresh-1"), ORIGIN);
    return application;
  }

  // Another process of this person, bound to one cloud, signs in there.
  function otherProcessSignsIn(target: Application, origin: string, prefix: string) {
    const other = new CatalogSession(target.db, target.vault, origin);
    other.saveClient(CALLBACK, `${prefix}-client`, origin);
    other.saveTokens(keysOf(`${prefix}-access`, `${prefix}-refresh`), origin);
  }

  it("is the default catalog of the local version, and a host's own catalog replaces it", () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    expect(application.mcpDependencies.onboarding?.catalog).toBe(application.localCatalog?.source);
    expect(application.mcpDependencies.onboarding?.catalog).toBeInstanceOf(HttpCatalogSource);
    application.db.close();

    const own: CatalogSource = { lookup: async () => ({ kind: "none", reason: "not_found" }), entry: async () => ({ kind: "none", reason: "not_found" }) };
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response(""), catalog: own });
    expect(application.mcpDependencies.onboarding?.catalog).toBe(own);
    application.db.close();

    const { catalogOrigin: _origin, ...withoutCatalog } = config;
    application = buildApplication(withoutCatalog, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    expect(application.localCatalog).toBeNull();
    expect(application.mcpDependencies.onboarding?.catalog).toBeUndefined();
  });

  it("asks to sign in before this computer has, without calling the cloud", async () => {
    const { fetchImpl, requests } = cloud({});
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl });

    expect(await application.localCatalog!.source.lookup(WB_LINK)).toEqual(SIGN_IN);
    expect(await application.localCatalog!.source.entry(WB_ENTRY_ID)).toEqual(SIGN_IN);
    expect(requests).toEqual([]);
  });

  it("looks up a link and reads an entry with the catalog key", async () => {
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": () => Response.json({ kind: "entry", entry: wbEntry() }),
      [`GET /api/catalog/v1/entries/${WB_ENTRY_ID}`]: () => Response.json(wbEntry()),
    });
    const target = signedIn(fetchImpl);

    const found = await target.localCatalog!.source.lookup(WB_LINK);
    const entry = await target.localCatalog!.source.entry(WB_ENTRY_ID);

    expect(found).toMatchObject({ kind: "entry", entry: { entryId: WB_ENTRY_ID, version: 3 } });
    expect(entry).toMatchObject({ kind: "entry", entry: { entryId: WB_ENTRY_ID } });
    expect(requests[0]!.url.toString()).toBe(`${ORIGIN}/api/catalog/v1/lookup?url=${encodeURIComponent(WB_LINK)}`);
    expect(requests[1]!.url.toString()).toBe(`${ORIGIN}/api/catalog/v1/entries/${WB_ENTRY_ID}`);
    expect(requests.map(({ authorization }) => authorization)).toEqual(["Bearer access-1", "Bearer access-1"]);
  });

  it("tells the cloud the link's address without its query or fragment", async () => {
    const { fetchImpl, requests } = cloud({ "GET /api/catalog/v1/lookup": () => Response.json({ kind: "none", reason: "not_found" }) });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(`${WB_LINK}?token=person-secret&page=2#x`)).toEqual({ kind: "none", reason: "not_found" });

    expect(requests.map(({ url }) => url.toString())).toEqual([`${ORIGIN}/api/catalog/v1/lookup?url=${encodeURIComponent(WB_LINK)}`]);
    expect(requests[0]!.url.toString()).not.toContain("person-secret");
  });

  it("offers candidates the cloud found for a link", async () => {
    const candidates = [{ entryId: WB_ENTRY_ID, displayName: "Wildberries Statistics", description: "Reports", operations: 4 }];
    const { fetchImpl } = cloud({ "GET /api/catalog/v1/lookup": () => Response.json({ kind: "candidates", candidates }) });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "candidates", candidates });
  });

  it("does not send an entry id the catalog could never have issued", async () => {
    const { fetchImpl, requests } = cloud({});
    const target = signedIn(fetchImpl);

    for (const entryId of ["..", ".", "../lookup", "a/b", "a?b", ""]) {
      expect(await target.localCatalog!.source.entry(entryId)).toEqual({ kind: "none", reason: "not_found" });
    }
    expect(requests).toEqual([]);
  });

  it("refreshes the key once after a 401 and repeats the request with the new key", async () => {
    let lookups = 0;
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": () => (lookups += 1) === 1
        ? new Response("expired", { status: 401 })
        : Response.json({ kind: "none", reason: "not_found" }),
      "POST /oauth/token": () => Response.json({ access_token: "access-2", refresh_token: "refresh-2" }),
    });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });

    const refresh = new URLSearchParams(requests[1]!.body);
    expect([refresh.get("grant_type"), refresh.get("refresh_token"), refresh.get("client_id")]).toEqual(["refresh_token", "refresh-1", "local-client-1"]);
    expect(requests[2]!.authorization).toBe("Bearer access-2");
    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-2", "refresh-2") });
  });

  it("makes one refresh when two requests are refused at once", async () => {
    let refused = 0;
    let bothRefused: () => void = () => undefined;
    const both = new Promise<void>((resolve) => { bothRefused = resolve; });
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": async (request) => {
        if (request.authorization === "Bearer access-1") {
          // Neither request is answered before both have been asked, so both are refused with the same key.
          if ((refused += 1) === 2) bothRefused();
          await both;
          return new Response("expired", { status: 401 });
        }
        return Response.json({ kind: "none", reason: "not_found" });
      },
      "POST /oauth/token": async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ access_token: "access-2", refresh_token: "refresh-2" });
      },
    });
    const target = signedIn(fetchImpl);
    const { source } = target.localCatalog!;

    const answers = await Promise.all([source.lookup(WB_LINK), source.lookup(`${WB_LINK}/other`)]);

    expect(answers).toEqual([{ kind: "none", reason: "not_found" }, { kind: "none", reason: "not_found" }]);
    expect(tokenRequests(requests)).toHaveLength(1);
    expect(requests.filter(({ authorization }) => authorization === "Bearer access-2")).toHaveLength(2);
    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-2", "refresh-2") });
  });

  it("shares one refresh between callers of the sign-in, and makes a new one the next time", async () => {
    let issued = 0;
    const { fetchImpl, requests } = cloud({
      "POST /oauth/token": async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        issued += 1;
        return Response.json({ access_token: `access-${issued + 1}`, refresh_token: `refresh-${issued + 1}` });
      },
    });
    const target = signedIn(fetchImpl);
    const { oauth } = target.localCatalog!;

    const [first, second] = await Promise.all([oauth.refresh(), oauth.refresh()]);
    expect(first).toEqual({ origin: ORIGIN, ...keysOf("access-2", "refresh-2") });
    expect(second).toEqual(first);
    expect(tokenRequests(requests)).toHaveLength(1);

    expect(await oauth.refresh()).toEqual({ origin: ORIGIN, ...keysOf("access-3", "refresh-3") });
    expect(tokenRequests(requests)).toHaveLength(2);
    expect(new URLSearchParams(tokenRequests(requests)[1]!.body).get("refresh_token")).toBe("refresh-2");
  });

  it("uses keys another process stored while its own were refused, without refreshing again", async () => {
    let target: Application;
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": (request) => {
        if (request.authorization !== "Bearer access-1") return Response.json({ kind: "none", reason: "not_found" });
        target.localCatalog!.session.saveTokens(keysOf("access-9", "refresh-9"), ORIGIN);
        return new Response("expired", { status: 401 });
      },
    });
    target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });

    expect(requests.map(({ authorization }) => authorization)).toEqual(["Bearer access-1", "Bearer access-9"]);
    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-9", "refresh-9") });
  });

  it("asks to sign in again when the refresh is refused, or the fresh key is refused too", async () => {
    const refused = cloud({
      "GET /api/catalog/v1/lookup": () => new Response("expired", { status: 401 }),
      "POST /oauth/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const first = signedIn(refused.fetchImpl);
    expect(await first.localCatalog!.source.lookup(WB_LINK)).toEqual(SIGN_IN);
    expect(await first.localCatalog!.session.tokens()).toBeNull();
    expect(refused.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      "GET /api/catalog/v1/lookup", "POST /oauth/token",
    ]);
    first.db.close();

    const stillRefused = cloud({
      "GET /api/catalog/v1/lookup": () => new Response("expired", { status: 401 }),
      "POST /oauth/token": () => Response.json({ access_token: "access-2", refresh_token: "refresh-2" }),
    });
    const second = signedIn(stillRefused.fetchImpl);
    expect(await second.localCatalog!.source.lookup(WB_LINK)).toEqual(SIGN_IN);
    expect(stillRefused.requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      "GET /api/catalog/v1/lookup", "POST /oauth/token", "GET /api/catalog/v1/lookup",
    ]);
    expect(await second.localCatalog!.session.tokens()).toBeNull();
  });

  it("keeps keys stored meanwhile when the fresh key is refused", async () => {
    let target: Application;
    const { fetchImpl } = cloud({
      "GET /api/catalog/v1/lookup": (request) => {
        // Another request stores newer keys while the fresh ones are being refused.
        if (request.authorization === "Bearer access-2") target.localCatalog!.session.saveTokens(keysOf("access-9", "refresh-9"), ORIGIN);
        return new Response("expired", { status: 401 });
      },
      "POST /oauth/token": () => Response.json({ access_token: "access-2", refresh_token: "refresh-2" }),
    });
    target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual(SIGN_IN);

    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-9", "refresh-9") });
  });

  it("keeps the sign-in when the refresh cannot reach the cloud", async () => {
    const { fetchImpl } = cloud({
      "GET /api/catalog/v1/lookup": () => new Response("expired", { status: 401 }),
      "POST /oauth/token": () => { throw new TypeError("fetch failed"); },
    });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "unavailable" });
    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-1", "refresh-1") });
  });

  it("reports a used-up limit when the refresh is rate limited, and keeps the sign-in", async () => {
    const { fetchImpl } = cloud({
      "GET /api/catalog/v1/lookup": () => new Response("expired", { status: 401 }),
      "POST /oauth/token": () => new Response("slow down", { status: 429 }),
    });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "limited" });
    expect(await target.localCatalog!.session.tokens()).toEqual({ origin: ORIGIN, ...keysOf("access-1", "refresh-1") });
  });

  it("sends the key only to the cloud that issued it, even when the address names another", async () => {
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": (request) => request.authorization === "Bearer ru-access"
        ? new Response("expired", { status: 401 })
        : Response.json({ kind: "none", reason: "not_found" }),
      "POST /oauth/token": () => Response.json({ access_token: "ru-access-2", refresh_token: "ru-refresh-2" }),
    });
    // The language default is the other cloud, but the keys were issued by the Russian one.
    application = buildApplication(followingConfig, { resolver: async () => ["8.8.8.8"], fetchImpl });
    otherProcessSignsIn(application, RU, "ru");

    expect(await application.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });

    expect(requests.map(({ method, url, authorization }) => `${method} ${url.origin}${url.pathname} ${authorization ?? "-"}`)).toEqual([
      `GET ${RU}/api/catalog/v1/lookup Bearer ru-access`,
      `POST ${RU}/oauth/token -`,
      `GET ${RU}/api/catalog/v1/lookup Bearer ru-access-2`,
    ]);
  });

  it("does not move a key to another cloud when the address changes while its request is in flight", async () => {
    let target: Application;
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": (request) => {
        if (request.url.origin !== RU) return Response.json({ kind: "none", reason: "not_found" });
        // Another process signs in to the other cloud while the Russian one refuses the key.
        otherProcessSignsIn(target, ORIGIN, "online");
        return new Response("expired", { status: 401 });
      },
    });
    application = buildApplication(followingConfig, { resolver: async () => ["8.8.8.8"], fetchImpl });
    target = application;
    otherProcessSignsIn(application, RU, "ru");

    expect(await application.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });

    // Each key reached only its own cloud, and nothing was refreshed.
    expect(requests.map(({ url, authorization }) => `${url.origin} ${authorization}`)).toEqual([
      `${RU} Bearer ru-access`,
      `${ORIGIN} Bearer online-access`,
    ]);
  });

  it("sends a key it already holds to its own cloud, even when the address changes just before the request", async () => {
    const { fetchImpl, requests } = cloud({ "GET /api/catalog/v1/lookup": () => Response.json({ kind: "none", reason: "not_found" }) });
    application = buildApplication(followingConfig, { resolver: async () => ["8.8.8.8"], fetchImpl });
    otherProcessSignsIn(application, RU, "ru");
    const target = application;
    const readKeys = target.vault.withCredentials.bind(target.vault);
    let switched = false;
    // Once the Russian keys are read, another process signs in to the other cloud, so the session's address changes.
    target.vault.withCredentials = async (credentialSetId, use) => {
      const result = await readKeys(credentialSetId, use);
      if (!switched) {
        switched = true;
        otherProcessSignsIn(target, ORIGIN, "online");
        expect(target.localCatalog!.session.origin).toBe(ORIGIN);
      }
      return result;
    };

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });

    expect(requests.map(({ url, authorization }) => `${url.origin} ${authorization}`)).toEqual([`${RU} Bearer ru-access`]);
  });

  it.each([
    ["a 429 as a used-up limit", () => new Response("slow down", { status: 429 }), "limited"],
    ["a 404 as nothing found", () => new Response("no such thing", { status: 404 }), "not_found"],
    ["a server error as unavailable", () => new Response("oops", { status: 502 }), "unavailable"],
    ["a network error as unavailable", () => { throw new TypeError("fetch failed"); }, "unavailable"],
    ["a redirect as unavailable", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), "unavailable"],
    ["an answer that is not JSON as unavailable", () => new Response("<html>", { status: 200 }), "unavailable"],
    ["an answer of the wrong shape as unavailable", () => Response.json({ kind: "entry" }), "unavailable"],
    ["an adapter the core refuses as unavailable", () => Response.json({
      kind: "entry", entry: { ...wbEntry(), dsl: { ...wbEntry().dsl, baseOrigins: ["http://statistics-api.wildberries.ru"] } },
    }), "unavailable"],
    ["a sign-in sent by the cloud as unavailable", () => Response.json({ kind: "sign_in", url: "https://evil.example/" }), "unavailable"],
    // Valid JSON of the right shape, so only the size limit can refuse it.
    ["an answer that is too long as unavailable", () => Response.json({ kind: "none", reason: "not_found", padding: "x".repeat(1_048_576) }), "unavailable"],
  ])("treats %s", async (_case, answer: Route, reason) => {
    const { fetchImpl } = cloud({ "GET /api/catalog/v1/lookup": answer });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason });
  });

  it("treats an entry that does not fit the schema as unavailable, like a lookup", async () => {
    const { fetchImpl } = cloud({
      [`GET /api/catalog/v1/entries/${WB_ENTRY_ID}`]: () => Response.json({ ...wbEntry(), version: 0 }),
    });
    const target = signedIn(fetchImpl);

    expect(await target.localCatalog!.source.entry(WB_ENTRY_ID)).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("gives up after its time limit", async () => {
    const hanging: FetchImplementation = (_input, init = {}) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    const target = signedIn(hanging);
    const source = new HttpCatalogSource({
      session: target.localCatalog!.session,
      oauth: target.localCatalog!.oauth,
      signInUrl: target.localCatalog!.signInUrl,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: hanging,
      timeoutMs: 20,
    });

    expect(await source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "unavailable" });
    expect(CATALOG_TIMEOUT_MS).toBe(10_000);
  });

  it("does not call the cloud once the person turned the catalog off", async () => {
    const { fetchImpl, requests } = cloud({});
    const target = signedIn(fetchImpl);
    target.localCatalog!.session.setDisabled(true);

    expect(await target.localCatalog!.source.lookup(WB_LINK)).toEqual({ kind: "none", reason: "not_found" });
    expect(await target.localCatalog!.source.entry(WB_ENTRY_ID)).toEqual({ kind: "none", reason: "not_found" });
    expect(requests).toEqual([]);
  });

  it("serves start_connection: sign-in before the first sign-in, then a ready-made adapter", async () => {
    const { fetchImpl, requests } = cloud({
      "GET /api/catalog/v1/lookup": () => Response.json({ kind: "entry", entry: wbEntry() }),
    });
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl });
    const tools = createToolHandlers(application.mcpDependencies);

    const before = await tools.start_connection({ documentationUrl: WB_LINK });
    expect(before).toMatchObject({ stage: "catalog_sign_in", signInUrl: SIGN_IN.url });
    expect(requests).toEqual([]);

    application.localCatalog!.session.saveClient(CALLBACK, "local-client-1", ORIGIN);
    application.localCatalog!.session.saveTokens(keysOf("access-1", "refresh-1"), ORIGIN);
    const after = draftSetup(await tools.start_connection({ documentationUrl: WB_LINK }));
    expect(after).toMatchObject({ stage: "waiting_for_keys", provenance: { kind: "catalog", entryId: WB_ENTRY_ID, version: 3 } });
    expect(requests.map(({ authorization }) => authorization)).toEqual(["Bearer access-1"]);
  });
});
