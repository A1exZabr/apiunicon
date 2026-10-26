import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import { localWritePolicy, type WriteRefusal } from "../../src/changes/policy.js";
import type { AppConfig } from "../../src/config.js";
import { CHANGE_COOKIE } from "../../src/http/change-page.js";
import { registerConfirmRoutes } from "../../src/http/confirm-page.js";
import { decodeUrlEncoded } from "../../src/http/forms.js";
import { linkFormToken, localOneTimePageOptions, type OneTimePageOptions } from "../../src/http/one-time.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { UsageLimitError, unlimitedUsage } from "../../src/usage/gate.js";
import { cookieHeader, form, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 44),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768, maxUpstreamBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const SECRET = "shop-secret-9d41c7e2";
const ORIGIN = "https://api.shop.test";
const NM_ID = 123456789;
const SUMMARY = "Цена товара 123456789: 299 ₽ → 349 ₽, вы просили 349 ₽";
const HOST = { host: "127.0.0.1:3210" };
const PASSWORD = "correct horse battery staple";

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [
    {
      id: "set_price",
      description: "Установить цену товара",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: {
        nmId: { type: "integer", location: "body", required: true, description: "Артикул" },
        price: { type: "integer", location: "body", required: true, description: "Цена, ₽" },
        note: { type: "string", location: "body", required: false, description: "Комментарий" },
        comment: { type: "string", location: "body", required: false },
        card: { type: "object", location: "body", required: false, description: "Карточка" },
      },
      documentationRefs: [],
    },
    {
      id: "delete_card",
      description: "Удалить карточку товара",
      risk: "write",
      method: "DELETE",
      path: "/cards/{nmId}",
      input: { nmId: { type: "integer", location: "path", required: true, description: "Артикул" } },
      documentationRefs: [],
    },
    {
      id: "rename_card",
      description: `Переименовать <img src=x onerror=alert(1)> ${String.fromCodePoint(0x200b)}карточку`,
      risk: "write",
      method: "PATCH",
      path: "/cards/{sku}",
      input: {
        sku: { type: "string", location: "path", required: true, description: "Артикул <b onmouseover=alert(1)>" },
        title: { type: "string", location: "body", required: true, description: "Название" },
      },
      documentationRefs: [],
    },
  ],
};

type Sent = { method: string; url: string; body: string | null };
type Change = { changeId: string; pathname: string; search: string; token: string };

const csrfOf = (body: string) => /name="csrf" value="([^"]+)"/u.exec(body)?.[1] ?? "";

describe("the page that confirms a change", () => {
  let application: Application;
  let server: FastifyInstance;
  let sent: Sent[];
  let answer: () => Promise<Response>;
  let planRefusal: WriteRefusal | null;
  let afterCallError: Error | null;
  let connectionId: string;
  // The local workspace's session: the page that confirms a change opens only for the person signed in on this computer.
  let session: string;

  // Headers of a request on this computer, from the signed-in browser, with the link's cookie when there is one.
  const local = (cookie = "") => ({ ...HOST, cookie: [session, cookie].filter(Boolean).join("; ") });

  beforeEach(async () => {
    sent = [];
    answer = async () => new Response(JSON.stringify({ updated: true }), { status: 200 });
    planRefusal = null;
    afterCallError = null;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push({
          method: init?.method ?? "GET",
          url: input.toString(),
          body: typeof init?.body === "string" ? init.body : null,
        });
        return answer();
      },
      writes: { check: async () => planRefusal, settingsUrl: localWritePolicy.settingsUrl },
      usage: {
        ...unlimitedUsage,
        afterCall: async () => {
          if (afterCallError !== null) throw afterCallError;
        },
      },
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.vault.storeFields("credentials-1", { "X-Shop-Key": SECRET });
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: "credentials-1",
      adapterId: adapter.id,
    }).id;
    application.changes.setWrites(connectionId, true);
    server = buildHttpServer(application);
    session = (await setupAdmin(server, application, PASSWORD)).cookies;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await server.close();
    application.db.close();
  });

  async function requestChange(operationId: string, args: Record<string, unknown>, summary = SUMMARY): Promise<Change> {
    const { result } = await createToolHandlers(application.mcpDependencies).request_change({ connectionId, operationId, args, summary });
    if (result.status !== "pending") throw new Error(`Expected a pending change, got ${result.status}`);
    const url = new URL(result.confirmation.url);
    return { changeId: result.changeId, pathname: url.pathname, search: url.search, token: url.searchParams.get("t") ?? "" };
  }

  async function open(change: Change, on: FastifyInstance = server) {
    const opened = await on.inject({ method: "GET", url: `${change.pathname}${change.search}`, headers: local() });
    expect(opened.statusCode).toBe(303);
    expect(opened.headers.location).toBe(change.pathname);
    const cookie = cookieHeader(opened);
    const page = await on.inject({ method: "GET", url: change.pathname, headers: local(cookie) });
    return { opened, cookie, page };
  }

  function reload(change: Change, cookie: string, on: FastifyInstance = server) {
    return on.inject({ method: "GET", url: change.pathname, headers: local(cookie) });
  }

  function submit(
    change: Change,
    cookie: string,
    csrf: string,
    decision: string,
    extra: Array<[string, string]> = [],
    on: FastifyInstance = server,
  ) {
    return on.inject({
      method: "POST",
      url: change.pathname,
      headers: { ...local(cookie), "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["decision", decision], ...extra]),
    });
  }

  // A host that serves the pages itself, without the local server's headers, as a hosted service would.
  function hosted(overrides: Partial<OneTimePageOptions> = {}): FastifyInstance {
    const host = Fastify();
    host.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, decodeUrlEncoded(typeof body === "string" ? body : body.toString("utf8")));
    });
    registerConfirmRoutes(host, { ...localOneTimePageOptions(application), ...overrides });
    return host;
  }

  it("changes only after the person confirms, with exactly the stored values", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });

    const { cookie, page } = await open(change);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<title>Confirm a change · APIUniCon</title>");
    expect(page.body).toContain("<h1>Change data in “Shop”?</h1>");
    expect(page.body).toContain(
      "Your AI assistant asks to do this in api.shop.test. Nothing changes until you press “Run”.",
    );
    expect(page.body).toContain("Action (as the adapter describes it)");
    expect(page.body).toContain("Установить цену товара");
    expect(page.body).toContain("<code>POST https://api.shop.test/prices</code>");
    expect(page.body).toContain("<h2 class=\"section-gap\">What will be sent</h2>");
    expect(page.body).toContain("<dt>Артикул <code>nmId</code></dt><dd>123456789</dd>");
    expect(page.body).toContain("<dt>Цена, ₽ <code>price</code></dt><dd>349</dd>");
    expect(page.body).toContain(`<blockquote>Your assistant writes: “${SUMMARY}”</blockquote>`);
    expect(page.body).toContain("These are the assistant&#39;s words. The values above are what will be sent.");
    // The assistant's words come after what will be sent, never in its place.
    expect(page.body.indexOf("<dd>349</dd>")).toBeLessThan(page.body.indexOf("<blockquote>"));
    expect(page.body).toContain("<p class=\"warning\">This action has never run through APIUniCon before.</p>");
    expect(page.body).toContain("The link works for 15 minutes from when your assistant created it.");
    expect(page.body).toContain(`<form method="post" action="/confirm/change/${change.changeId}">`);
    expect(page.body).toContain("<button type=\"submit\" name=\"decision\" value=\"run\">Run</button>");
    expect(page.body).toContain("<button type=\"submit\" name=\"decision\" value=\"cancel\" class=\"secondary\">Cancel</button>");
    expect(csrfOf(page.body)).toBe(linkFormToken("change", change.token));
    expect(page.body).not.toMatch(/<script/iu);
    expect(page.body).not.toContain(change.token);
    expect(sent).toEqual([]);

    // Values the form carries are ignored: what runs is what was stored and shown.
    const done = await submit(change, cookie, csrfOf(page.body), "run", [["price", "1"], ["nmId", "7"]]);

    expect(done.statusCode).toBe(200);
    expect(done.body).toContain("<h1>Done</h1>");
    expect(done.body).toContain("The service answered 200. Go back to the chat: your assistant will see the result.");
    expect(done.body).not.toContain("updated");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "POST", url: `${ORIGIN}/prices` });
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({ nmId: NM_ID, price: 349 });
    expect(await createToolHandlers(application.mcpDependencies).get_change({ changeId: change.changeId })).toMatchObject({
      status: "succeeded",
    });

    // Once the action ran, the next request for it is no longer a first.
    const next = await open(await requestChange("set_price", { nmId: NM_ID, price: 350 }));
    expect(next.page.body).not.toContain("This action has never run through APIUniCon before.");
  });

  it("warns above the button when this run lets the action run at once from then on, and only then", async () => {
    const standing =
      "<p class=\"warning\">Confirmation is off on this connection: once you run this, your assistant will run this action at once next time, with any values, without asking you.</p>";
    // Confirmation asked: the run trusts nothing, and the page says nothing of it.
    const askedChange = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const asked = await open(askedChange);
    expect(asked.page.body).not.toContain(standing);

    application.changes.setConfirmChanges(connectionId, false);
    // The same waiting change, with confirmation off now: its run would be the one that trusts the action.
    expect((await reload(askedChange, asked.cookie)).body).toContain(standing);
    const change = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    const { cookie, page } = await open(change);
    expect(page.body).toContain(standing);
    expect(page.body.indexOf(standing)).toBeLessThan(page.body.indexOf("value=\"run\">Run</button>"));
    expect(page.body.indexOf(standing)).toBeGreaterThan(page.body.indexOf("<blockquote>"));
    const ru = hosted({ locale: () => "ru" });
    const russian = await open(change, ru);
    expect(russian.page.body).toContain(
      "<p class=\"warning\">Подтверждение на этом подключении выключено: после этого запуска ассистент будет выполнять это действие сразу, с любыми значениями, не спрашивая вас.</p>",
    );
    await ru.close();

    // A deletion, here a DELETE labelled as a write, never runs at once: neither of its steps says so.
    const deletion = await requestChange("delete_card", { nmId: NM_ID });
    const destructive = await open(deletion);
    expect(destructive.page.body).toContain("<h1>Delete data in “Shop”?</h1>");
    expect(destructive.page.body).not.toContain(standing);
    expect((await submit(deletion, destructive.cookie, csrfOf(destructive.page.body), "run")).statusCode).toBe(303);
    const final = await reload(deletion, destructive.cookie);
    expect(final.body).toContain("value=\"run\">Yes, delete</button>");
    expect(final.body).not.toContain(standing);

    // Once the person ran the action, it is trusted: a change of it that still waits no longer says the run trusts it.
    expect((await submit(change, cookie, csrfOf(page.body), "run")).body).toContain("<h1>Done</h1>");
    const trusted = await reload(askedChange, asked.cookie);
    expect(trusted.body).toContain("value=\"run\">Run</button>");
    expect(trusted.body).not.toContain(standing);
    // And with confirmation asked again, no page says it.
    application.changes.setConfirmChanges(connectionId, true);
    const renamed = await open(await requestChange("rename_card", { sku: "A-17", title: "Футболка" }));
    expect(renamed.page.body).toContain("value=\"run\">Run</button>");
    expect(renamed.page.body).not.toContain(standing);
  });

  it("shows every value escaped and in full, and no key", async () => {
    const long = "0123456789".repeat(1_000);
    const card = { title: "<b>Футболка</b>", sku: "A\u202e-17" };
    const change = await requestChange(
      "set_price",
      { nmId: NM_ID, price: 349, note: "<script>alert(1)</script>", comment: long, card },
      "Заменить карточку <img src=x onerror=alert(1)>",
    );

    const { page } = await open(change);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<dt>Комментарий <code>note</code></dt><dd>&lt;script&gt;alert(1)&lt;/script&gt;</dd>");
    expect(page.body).not.toContain("<script>alert(1)</script>");
    // Without a description the name alone labels the value.
    expect(page.body).toContain(`<dt><code>comment</code></dt><dd>${long}</dd>`);
    // The direction mark is spelled out, so it cannot turn the value around on the screen.
    const json = "{\n  &quot;title&quot;: &quot;&lt;b&gt;Футболка&lt;/b&gt;&quot;,\n  &quot;sku&quot;: &quot;A\\u202e-17&quot;\n}";
    expect(page.body).toContain(`<dt>Карточка <code>card</code></dt><dd><pre class="value">${json}</pre></dd>`);
    expect(page.body).not.toContain("\u202e");
    expect(page.body).toContain("Заменить карточку &lt;img src=x onerror=alert(1)&gt;");
    expect(page.body).not.toContain("<img");
    expect(page.body).not.toContain(SECRET);
  });

  it("asks twice for a destructive change and refuses the final form at the first step", async () => {
    const change = await requestChange("delete_card", { nmId: NM_ID }, "Удалить карточку 123456789, как вы просили");
    const { cookie, page } = await open(change);

    expect(page.body).toContain("<h1>Delete data in “Shop”?</h1>");
    expect(page.body).toContain(`<code>DELETE https://api.shop.test/cards/${NM_ID}</code>`);
    expect(page.body).toContain("value=\"run\">Run</button>");

    // The second step's form before the first step was taken: refused, and nothing sent.
    const early = await submit(change, cookie, linkFormToken("change-final", change.token), "run");
    expect(early.statusCode).toBe(403);
    expect(early.body).toContain("This link has expired");
    expect(sent).toEqual([]);

    const first = await submit(change, cookie, csrfOf(page.body), "run");
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe(change.pathname);
    expect(sent).toEqual([]);

    const final = await reload(change, cookie);
    expect(final.statusCode).toBe(200);
    expect(final.body).toContain("<h1>Delete for good? This cannot be undone.</h1>");
    expect(final.body).toContain("api.shop.test will delete the data of the request above. APIUniCon cannot bring it back.");
    expect(final.body).toContain(`<code>DELETE https://api.shop.test/cards/${NM_ID}</code>`);
    expect(final.body).toContain("value=\"run\">Yes, delete</button>");
    expect(final.body).toContain("value=\"cancel\" class=\"secondary\">Cancel</button>");
    expect(csrfOf(final.body)).toBe(linkFormToken("change-final", change.token));

    // The first step's form, sent again, does not delete either: it only leads back to the final form.
    const stale = await submit(change, cookie, linkFormToken("change", change.token), "run");
    expect(stale.statusCode).toBe(303);
    expect(stale.headers.location).toBe(change.pathname);
    expect(sent).toEqual([]);

    const deleted = await submit(change, cookie, csrfOf(final.body), "run");
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain("<h1>Done</h1>");
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([`DELETE ${ORIGIN}/cards/${NM_ID}`]);
  });

  it("cancels without sending anything", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);

    const cancelled = await submit(change, cookie, csrfOf(page.body), "cancel");

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toContain("<h1>Cancelled</h1>");
    expect(cancelled.body).toContain("Nothing changed.");
    expect(sent).toEqual([]);
    expect(application.changes.view(change.changeId)).toMatchObject({ status: "cancelled", reason: "person" });

    // Opening the link again, or pressing Run on a page left open, only shows that it was cancelled.
    const reopened = await open(change);
    expect(reopened.page.statusCode).toBe(200);
    expect(reopened.page.body).toContain("<h1>Cancelled</h1>");
    expect(reopened.page.body).not.toContain("value=\"run\"");
    const late = await submit(change, cookie, csrfOf(page.body), "run");
    expect(late.statusCode).toBe(200);
    expect(late.body).toContain("<h1>Cancelled</h1>");
    expect(sent).toEqual([]);
  });

  it("runs a change once when two confirmations race", async () => {
    // The service answers only once the second click has its answer, so the two clicks overlap whatever the timing.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer = async () => {
      await held;
      return new Response(JSON.stringify({ updated: true }), { status: 200 });
    };
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const csrf = csrfOf(page.body);

    const clicks = [submit(change, cookie, csrf, "run"), submit(change, cookie, csrf, "run")];
    // The click that took the change waits for the service, so the first answer is the other click's.
    await Promise.race(clicks);
    release();
    const answers = await Promise.all(clicks);

    expect(answers.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(sent).toHaveLength(1);
    const bodies = answers.map(({ body }) => body);
    expect(bodies.filter((body) => body.includes("The service answered 200."))).toHaveLength(1);
    // The other click sees the change that is already running, not a form and not a second request.
    expect(bodies.filter((body) => body.includes("The change is running. Refresh the page in a minute."))).toHaveLength(1);
    expect(bodies.every((body) => !body.includes("value=\"run\""))).toBe(true);
    expect((await reload(change, cookie)).body).toContain("The service answered 200.");
    expect(sent).toHaveLength(1);
  });

  it("sends a click that decided nothing, or carried no decision, back to the change's page", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const csrf = csrfOf(page.body);

    for (const decision of ["", "delete", "RUN"]) {
      const odd = await submit(change, cookie, csrf, decision);
      expect(odd.statusCode, decision).toBe(303);
      expect(odd.headers.location, decision).toBe(change.pathname);
    }
    // Another tab moved the change on in between: this click took nothing, and the page shows where it stands.
    vi.spyOn(application.changes, "decide").mockResolvedValueOnce(null);
    const lost = await submit(change, cookie, csrf, "run");
    expect(lost.statusCode).toBe(303);
    expect(lost.headers.location).toBe(change.pathname);
    expect(sent).toEqual([]);
    expect(application.changes.view(change.changeId).status).toBe("pending");
    expect((await reload(change, cookie)).body).toContain("value=\"run\"");
  });

  it("refuses a used, expired or foreign link, a missing cookie and a wrong form token", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const other = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    const { cookie, page } = await open(change);
    const csrf = csrfOf(page.body);
    const foreignCookie = `${CHANGE_COOKIE}=${other.token}`;

    // Missing cookie.
    const bare = await server.inject({ method: "GET", url: change.pathname, headers: local() });
    expect(bare.statusCode).toBe(403);
    expect(bare.body).toContain("This link has expired");
    expect((await submit(change, "", csrf, "run")).statusCode).toBe(403);
    // Wrong form token, or one with no value at all.
    expect((await submit(change, cookie, "forged", "run")).statusCode).toBe(403);
    expect((await submit(change, cookie, "", "run")).statusCode).toBe(403);
    // Another change's link, its cookie and its form token, and a token of the wrong shape.
    expect((await server.inject({ method: "GET", url: `${change.pathname}?t=${other.token}`, headers: local() })).statusCode).toBe(403);
    expect((await reload(change, foreignCookie)).statusCode).toBe(403);
    expect((await submit(change, foreignCookie, linkFormToken("change", other.token), "run")).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: `${change.pathname}?t=short`, headers: local() })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: `${change.pathname}?t=${change.token}&t=${change.token}`, headers: local() })).statusCode)
      .toBe(403);
    expect(sent).toEqual([]);
    expect(application.changes.view(change.changeId).status).toBe("pending");

    // A used link: the form of a step already passed decides nothing, not even a cancel, and only leads back to the
    // change's page; a link whose change ran never sends it again.
    const deletion = await requestChange("delete_card", { nmId: NM_ID });
    const destructive = await open(deletion);
    expect((await submit(deletion, destructive.cookie, csrfOf(destructive.page.body), "run")).statusCode).toBe(303);
    for (const decision of ["run", "cancel"]) {
      const passed = await submit(deletion, destructive.cookie, csrfOf(destructive.page.body), decision);
      expect(passed.statusCode, decision).toBe(303);
      expect(passed.headers.location, decision).toBe(deletion.pathname);
    }
    expect(application.changes.view(deletion.changeId).status).toBe("pending");
    expect(sent).toEqual([]);
    expect((await submit(change, cookie, csrf, "run")).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    const used = await open(change);
    expect(used.page.body).toContain("<h1>Done</h1>");
    expect(used.page.body).not.toContain("value=\"run\"");
    expect((await submit(change, used.cookie, csrf, "run")).body).toContain("<h1>Done</h1>");
    expect(sent).toHaveLength(1);

    // Expired: the link, the page behind the cookie and the form all stop working after 15 minutes.
    vi.useFakeTimers({ toFake: ["Date"] });
    const late = await requestChange("set_price", { nmId: NM_ID, price: 351 });
    const lateOpened = await open(late);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    expect((await server.inject({ method: "GET", url: `${late.pathname}${late.search}`, headers: local() })).statusCode).toBe(403);
    const expiredPage = await reload(late, lateOpened.cookie);
    expect(expiredPage.statusCode).toBe(403);
    expect(expiredPage.body).toContain("This link has expired");
    const expiredRun = await submit(late, lateOpened.cookie, csrfOf(lateOpened.page.body), "run");
    expect(expiredRun.statusCode).toBe(403);
    expect(expiredRun.body).toContain("This link has expired");
    expect(sent).toHaveLength(1);

    // A host that finds no application for the request.
    vi.useRealTimers();
    const fresh = await requestChange("set_price", { nmId: NM_ID, price: 352 });
    const nowhere = hosted({ resolveApplication: async () => null });
    const missing = await nowhere.inject({ method: "GET", url: `${fresh.pathname}${fresh.search}`, headers: HOST });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain("Link not found");
    expect((await submit(fresh, `${CHANGE_COOKIE}=${fresh.token}`, linkFormToken("change", fresh.token), "run", [], nowhere)).statusCode)
      .toBe(404);
    expect(sent).toHaveLength(1);
    expect((await open(fresh)).page.statusCode).toBe(200);
    await nowhere.close();
  });

  it("opens only on this computer", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const foreign = { host: "attacker.example" };

    expect((await server.inject({ method: "GET", url: `${change.pathname}${change.search}`, headers: foreign })).statusCode).toBe(421);
    // Even from the signed-in browser.
    const signedIn = local(cookie).cookie;
    expect((await server.inject({ method: "GET", url: `${change.pathname}${change.search}`, headers: { ...foreign, cookie: session } })).statusCode)
      .toBe(421);
    expect((await server.inject({ method: "GET", url: change.pathname, headers: { ...foreign, cookie: signedIn } })).statusCode).toBe(421);
    const post = await server.inject({
      method: "POST", url: change.pathname,
      headers: { ...foreign, cookie: signedIn, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrfOf(page.body)], ["decision", "run"]]),
    });
    expect(post.statusCode).toBe(421);
    expect(sent).toEqual([]);
  });

  it("asks for the local sign-in and returns to the link after it, and the link, its cookie and its form token alone change nothing", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const csrf = csrfOf(page.body);
    const link = `${change.pathname}${change.search}`;
    const toSignIn = (next: string) => `/login?next=${encodeURIComponent(next)}`;

    // What the assistant has: the link, the cookie it sets and the form token, which is derived from the link's token.
    expect(csrf).toBe(linkFormToken("change", change.token));
    for (const run of ["run", "cancel"]) {
      const post = await server.inject({
        method: "POST", url: change.pathname,
        headers: { ...HOST, cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["csrf", csrf], ["decision", run]]),
      });
      expect(post.statusCode, run).toBe(303);
      expect(post.headers.location, run).toBe(toSignIn(change.pathname));
    }
    const forgedSession = `apiunicon_session=${"A".repeat(43)}; ${cookie}`;
    const forged = await server.inject({
      method: "POST", url: change.pathname,
      headers: { ...HOST, cookie: forgedSession, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["decision", "run"]]),
    });
    expect(forged.statusCode).toBe(303);
    expect(forged.headers.location).toBe(toSignIn(change.pathname));
    // Nor can it read the page, whether the link is the one with the token or the one behind the cookie.
    const viaLink = await server.inject({ method: "GET", url: link, headers: HOST });
    expect(viaLink.statusCode).toBe(303);
    expect(viaLink.headers.location).toBe(toSignIn(link));
    expect(viaLink.headers["set-cookie"]).toBeUndefined();
    const viaCookie = await server.inject({ method: "GET", url: change.pathname, headers: { ...HOST, cookie } });
    expect(viaCookie.statusCode).toBe(303);
    expect(viaCookie.headers.location).toBe(toSignIn(change.pathname));
    // Nor through a spelling of the path that the router reads as the same page.
    const encoded = await server.inject({
      method: "POST", url: change.pathname.replace("/change/", "/%63hange/"),
      headers: { ...HOST, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["decision", "run"]]),
    });
    expect(encoded.statusCode).toBe(303);
    expect(sent).toEqual([]);
    expect(application.changes.view(change.changeId).status).toBe("pending");

    // The person signs in and comes back to the link.
    const signIn = await server.inject({ method: "GET", url: toSignIn(link), headers: HOST });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.body).toContain(`<input type="hidden" name="next" value="${link}">`);
    const unlocked = await server.inject({
      method: "POST", url: "/login",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["password", PASSWORD], ["next", link]]),
    });
    expect(unlocked.statusCode).toBe(303);
    expect(unlocked.headers.location).toBe(link);
    session = cookieHeader(unlocked);
    const reopened = await open(change);
    expect(reopened.page.body).toContain("value=\"run\"");
    // Already signed in, the sign-in page leads straight back.
    expect((await server.inject({ method: "GET", url: toSignIn(link), headers: local() })).headers.location).toBe(link);
    expect((await submit(change, reopened.cookie, csrfOf(reopened.page.body), "run")).body).toContain("<h1>Done</h1>");
    expect(sent).toHaveLength(1);

    // A wrong password keeps the way back; the sign-in never sends the person anywhere but this page or the start page.
    const wrong = await server.inject({
      method: "POST", url: "/login",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["password", "wrong"], ["next", link]]),
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain(`href="${toSignIn(link).replaceAll("&", "&amp;")}"`);
    for (const next of ["//evil.test/", "https://evil.test/", "/\\evil.test", "/connections", `${change.pathname}?t=short`, `${link}&x=1`]) {
      const away = await server.inject({
        method: "POST", url: "/login",
        headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["password", PASSWORD], ["next", next]]),
      });
      expect(away.headers.location, next).toBe("/");
      const shown = await server.inject({ method: "GET", url: toSignIn(next), headers: HOST });
      expect(shown.body, next).not.toContain('name="next"');
    }
  });

  it("sets the link cookie on its own path for the remaining time, and no-store and no frames on the page, leaving Referrer-Policy to the host", async () => {
    expect(CHANGE_COOKIE).toBe("apiunicon_change");
    const host = hosted();
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });

    const { opened, cookie, page } = await open(change, host);

    const setCookie = String(opened.headers["set-cookie"]);
    const shape = new RegExp(
      `^apiunicon_change=${change.token}; Path=/confirm/change/${change.changeId}; HttpOnly; SameSite=Lax; Max-Age=(\\d+)$`,
      "u",
    );
    expect(setCookie).toMatch(shape);
    const maxAge = Number(shape.exec(setCookie)?.[1]);
    expect(maxAge).toBeLessThanOrEqual(900);
    expect(maxAge).toBeGreaterThan(890);
    const refused = await host.inject({ method: "GET", url: change.pathname, headers: HOST });
    const done = await submit(change, cookie, csrfOf(page.body), "run", [], host);
    const nowhere = hosted({ resolveApplication: async () => null });
    const missing = await nowhere.inject({ method: "GET", url: change.pathname, headers: HOST });
    for (const response of [opened, page, refused, done, missing]) {
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBeUndefined();
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
    // The local server adds its policy: no frames, nothing loaded from elsewhere, forms only to itself, and the
    // Referrer-Policy under which a browser names the page's origin on its form.
    const local = await open(await requestChange("set_price", { nmId: NM_ID, price: 351 }));
    for (const response of [local.opened, local.page]) {
      expect(response.headers["referrer-policy"]).toBe("same-origin");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      const policy = String(response.headers["content-security-policy"]);
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("form-action 'self'");
    }
    expect([opened.statusCode, page.statusCode, refused.statusCode, done.statusCode, missing.statusCode]).toEqual([303, 200, 403, 200, 404]);

    const secure = hosted({ secureCookies: true });
    const second = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    const secured = await secure.inject({ method: "GET", url: `${second.pathname}${second.search}`, headers: HOST });
    expect(String(secured.headers["set-cookie"])).toMatch(/; Secure$/u);
    await Promise.all([host.close(), nowhere.close(), secure.close()]);
  });

  it("says why on the page when the plan or the switch does not allow the change, without a run button", async () => {
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page: first } = await open(change);
    const csrf = csrfOf(first.body);

    planRefusal = { reason: "plan", message: "Changing data is not on this plan." };
    const plan = await reload(change, cookie);
    expect(plan.statusCode).toBe(200);
    expect(plan.body).toContain("<h1>Not done</h1>");
    expect(plan.body).toContain("Changing data is not available on your plan. Choose another plan on the Pricing page. Nothing changed.");
    expect(plan.body).not.toContain("value=\"run\"");
    expect(plan.body).not.toContain("<form");

    planRefusal = null;
    application.connections.setWritesEnabled(connectionId, false);
    const off = await reload(change, cookie);
    expect(off.body).toContain("Changing data is turned off for this connection. Nothing changed.");
    expect(off.body).not.toContain("value=\"run\"");

    // Turned back on, the same link shows the form again.
    application.connections.setWritesEnabled(connectionId, true);
    expect((await reload(change, cookie)).body).toContain("value=\"run\"");

    // A form left open is refused at the click, and the page says why.
    planRefusal = { reason: "plan", message: "Changing data is not on this plan." };
    const refused = await submit(change, cookie, csrf, "run");
    expect(refused.statusCode).toBe(200);
    expect(refused.body).toContain("Changing data is not available on your plan. Choose another plan on the Pricing page. Nothing changed.");
    expect(application.changes.view(change.changeId)).toMatchObject({ status: "refused", reason: "plan" });
    expect(sent).toEqual([]);
  });

  it("says the connection changed, without blaming the assistant, when the adapter was replaced, edited or stopped working", async () => {
    const english = "The connection changed after the request. Ask your assistant to request the change again.";
    const russian = "Подключение изменилось после запроса. Попросите ассистента запросить изменение заново.";
    const russianHost = hosted({ locale: () => "ru" });
    const click = async (change: Change, on: FastifyInstance = server) => {
      const { cookie, page } = await open(change, on);
      return submit(change, cookie, csrfOf(page.body), "run", [], on);
    };

    // Another adapter bound to the connection.
    const rebound = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const source = application.connections.getConnection(connectionId).documentationSourceId;
    const other = application.adapters.create({ slug: "shop-two", displayName: "Shop two", documentationSourceId: source, dsl });
    application.connections.replaceAdapter(connectionId, application.adapters.markWorking(other.id, other.version).id);
    const afterRebind = await click(rebound);
    // A new version of the bound adapter.
    const bumped = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    application.adapters.markWorking(other.id, application.adapters.patch(other.id, application.adapters.get(other.id).version, dsl).version);
    const afterBump = await click(bumped, russianHost);
    // The bound adapter edited back to a draft, so it no longer works.
    const stopped = await requestChange("set_price", { nmId: NM_ID, price: 351 });
    application.adapters.patch(other.id, application.adapters.get(other.id).version, dsl);
    const afterStop = await click(stopped);

    for (const [response, text] of [[afterRebind, english], [afterBump, russian], [afterStop, english]] as const) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(text);
      expect(response.body).not.toMatch(/assistant changed|ассистент изменил/u);
    }
    expect(sent).toEqual([]);
    for (const change of [rebound, bumped, stopped]) {
      expect(application.changes.view(change.changeId)).toMatchObject({
        status: "refused",
        reason: "adapter_changed",
        nextStep: "Nothing was changed: the connection or its adapter changed after the request. Request the change again.",
      });
    }
    await russianHost.close();
  });

  it("tells the person a timed-out change may have been made", async () => {
    answer = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);

    const result = await submit(change, cookie, csrfOf(page.body), "run");

    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("<h1>No answer from the service</h1>");
    expect(result.body).toContain(
      "The service did not answer in time. The change may have been made. Check in the service before you ask for it again.",
    );
    expect(sent).toHaveLength(1);
    expect((await reload(change, cookie)).body).toContain("No answer from the service");
  });

  it("says what the service answered when it refused, and that nothing changed when the request never left", async () => {
    answer = async () => new Response(JSON.stringify({ error: "price too low", key: SECRET }), { status: 400 });
    const rejected = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const first = await open(rejected);
    const failed = await submit(rejected, first.cookie, csrfOf(first.page.body), "run");
    expect(failed.body).toContain("<h1>The service answered with an error</h1>");
    expect(failed.body).toContain("The service answered 400, so most likely nothing changed.");
    expect(failed.body).not.toContain("price too low");

    answer = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    };
    const unsent = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    const second = await open(unsent);
    const notSent = await submit(unsent, second.cookie, csrfOf(second.page.body), "run");
    expect(notSent.body).toContain("<h1>Not done</h1>");
    expect(notSent.body).toContain("The request did not reach the service, so nothing changed. Go back to the chat.");
  });

  it("escapes a hostile connection name, action, parameter label and address, and writes out hidden characters", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const backslash = String.fromCharCode(92);
    application.connections.rename(connectionId, `<script>alert("label")</script>${rlo}`);
    const change = await requestChange(
      "rename_card",
      { sku: "it's\"><svg onload=alert(1)>", title: "Футболка" },
      `Переименовать ${lri}карточку</blockquote><script>x</script>`,
    );

    const { page } = await open(change);

    expect(page.body).toContain(`<h1>Change data in “&lt;script&gt;alert(&quot;label&quot;)&lt;/script&gt;${backslash}u202e”?</h1>`);
    expect(page.body).toContain(`<span>Переименовать &lt;img src=x onerror=alert(1)&gt; ${backslash}u200bкарточку</span>`);
    expect(page.body).toContain(
      "<dt>Артикул &lt;b onmouseover=alert(1)&gt; <code>sku</code></dt><dd>it&#39;s&quot;&gt;&lt;svg onload=alert(1)&gt;</dd>",
    );
    expect(page.body).toContain("<code>PATCH https://api.shop.test/cards/it&#39;s%22%3E%3Csvg%20onload%3Dalert(1)%3E</code>");
    expect(page.body).toContain(
      `<blockquote>Your assistant writes: “Переименовать ${backslash}u2066карточку&lt;/blockquote&gt;&lt;script&gt;x&lt;/script&gt;”</blockquote>`,
    );
    for (const tag of ["<script", "<img", "<svg", "<b onmouseover", "</blockquote><script"]) expect(page.body).not.toContain(tag);
    expect(page.body).not.toMatch(/\p{Cf}/u);
  });

  it("keeps the value blocks at full height and lets long values wrap on the local page", async () => {
    const card = { lines: Array.from({ length: 300 }, (_, index) => `line ${index}`) };
    const long = "x".repeat(5_000);
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349, comment: long, card });

    const { page } = await open(change);

    expect(page.body).toContain("<div class=\"change\"><h1>");
    expect(page.body).toMatch(/<pre class="value">[^<]*&quot;line 0&quot;,[^<]*&quot;line 299&quot;[^<]*<\/pre>/u);
    expect(page.body).toContain(`<dd>${long}</dd>`);
    // The layout's general limit on <pre> (a height with an inner scroll) does not apply to what will be sent.
    expect(page.body).toContain("pre.value{max-height:none;overflow:visible}");
    expect(page.body).toContain(".change{overflow-wrap:anywhere}");
  });

  it("says a change was sent but its result is not confirmed when the service may have answered", async () => {
    afterCallError = new UsageLimitError("The call limit is reached.");
    const limited = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const first = await open(limited);
    const afterCall = await submit(limited, first.cookie, csrfOf(first.page.body), "run");
    expect(afterCall.statusCode).toBe(200);
    expect(afterCall.body).toContain("<h1>Result not confirmed</h1>");
    expect(afterCall.body).toContain(
      "The change was sent, but we could not confirm the result. Check in the service before asking again.",
    );
    expect(afterCall.body).not.toContain("did not answer in time");
    const russian = hosted({ locale: () => "ru" });
    expect((await reload(limited, first.cookie, russian)).body).toContain(
      "Изменение отправлено, но итог подтвердить не удалось. Проверьте в сервисе, прежде чем просить снова.",
    );
    await russian.close();
    afterCallError = null;

    answer = async () => new Response(null, { status: 303, headers: { location: "https://elsewhere.test/" } });
    const redirected = await requestChange("set_price", { nmId: NM_ID, price: 350 });
    const second = await open(redirected);
    expect((await submit(redirected, second.cookie, csrfOf(second.page.body), "run")).body).toContain("<h1>Result not confirmed</h1>");
    expect(sent).toHaveLength(2);
    expect(application.changes.view(limited.changeId).status).toBe("unknown");
    expect(application.changes.view(redirected.changeId).status).toBe("unknown");
  });

  it("keeps “did not answer in time” for a run that never came back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let release: (response: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => {
      release = resolve;
    });
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const running = submit(change, cookie, csrfOf(page.body), "run");
    while (sent.length === 0) await new Promise((resolve) => setImmediate(resolve));

    // The process that ran it is taken for gone once the request timeout and the grace minute pass.
    vi.setSystemTime(Date.now() + config.requestTimeoutMs + 60_001);
    const stuck = await reload(change, cookie);
    expect(stuck.body).toContain("<h1>No answer from the service</h1>");
    expect(stuck.body).toContain("The service did not answer in time.");

    release(new Response("{}", { status: 200 }));
    await running;
  });

  it("cancels a destructive change from its final form", async () => {
    const change = await requestChange("delete_card", { nmId: NM_ID });
    const { cookie, page } = await open(change);
    expect((await submit(change, cookie, csrfOf(page.body), "run")).statusCode).toBe(303);
    const final = await reload(change, cookie);

    const cancelled = await submit(change, cookie, csrfOf(final.body), "cancel");

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toContain("<h1>Cancelled</h1>");
    expect(application.changes.view(change.changeId)).toMatchObject({ status: "cancelled", reason: "person" });
    expect((await submit(change, cookie, csrfOf(final.body), "run")).body).toContain("<h1>Cancelled</h1>");
    expect(sent).toEqual([]);
  });

  it("does not cancel a change that is already running", async () => {
    let release: (response: Response) => void = () => {};
    answer = () => new Promise<Response>((resolve) => {
      release = resolve;
    });
    const change = await requestChange("set_price", { nmId: NM_ID, price: 349 });
    const { cookie, page } = await open(change);
    const csrf = csrfOf(page.body);
    const running = submit(change, cookie, csrf, "run");
    while (sent.length === 0) await new Promise((resolve) => setImmediate(resolve));

    const cancel = await submit(change, cookie, csrf, "cancel");

    expect(cancel.statusCode).toBe(200);
    expect(cancel.body).toContain("The change is running. Refresh the page in a minute.");
    expect(application.changes.view(change.changeId).status).toBe("running");
    release(new Response(JSON.stringify({ updated: true }), { status: 200 }));
    const done = await running;
    expect(done.body).toContain("The service answered 200.");
    expect(application.changes.view(change.changeId).status).toBe("succeeded");
    expect(sent).toHaveLength(1);
  });

  it("takes one first step when two clicks on a deletion race, sends nothing, and leads both to the final form", async () => {
    const change = await requestChange("delete_card", { nmId: NM_ID });
    const { cookie, page } = await open(change);
    const decide = vi.spyOn(application.changes, "decide");

    const answers = await Promise.all([
      submit(change, cookie, csrfOf(page.body), "run"),
      submit(change, cookie, csrfOf(page.body), "run"),
    ]);

    expect(answers.map(({ statusCode }) => statusCode)).toEqual([303, 303]);
    expect(answers.map(({ headers }) => headers.location)).toEqual([change.pathname, change.pathname]);
    const decisions = await Promise.all(decide.mock.results.map(({ value }) => value as Promise<{ kind: string } | null>));
    expect(decisions.filter((decision) => decision?.kind === "final_step")).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(application.changes.list({ connectionId, limit: 1 })[0]).toMatchObject({ id: change.changeId, status: "pending", step: 1 });
    const final = await reload(change, cookie);
    expect(final.body).toContain("Delete for good? This cannot be undone.");
    expect(csrfOf(final.body)).toBe(linkFormToken("change-final", change.token));
    expect((await submit(change, cookie, csrfOf(final.body), "run")).statusCode).toBe(200);
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([`DELETE ${ORIGIN}/cards/${NM_ID}`]);
  });

  it("speaks Russian when the host's locale is ru", async () => {
    const host = hosted({ locale: () => "ru" });
    const change = await requestChange("delete_card", { nmId: NM_ID });

    const { cookie, page } = await open(change, host);

    expect(page.body).toContain("<title>Подтвердите изменение · APIUniCon</title>");
    expect(page.body).toContain("<h1>Удалить данные в «Shop»?</h1>");
    expect(page.body).toContain("Ваш ИИ-ассистент просит сделать это в api.shop.test. Пока вы не нажмёте «Выполнить», ничего не изменится.");
    expect(page.body).toContain("Действие (так его описывает адаптер)");
    expect(page.body).toContain("Будет отправлено");
    expect(page.body).toContain("value=\"run\">Выполнить</button>");
    expect(page.body).toContain("value=\"cancel\" class=\"secondary\">Отмена</button>");
    expect(page.body).toContain("Это слова ассистента. Отправлены будут значения выше.");

    expect((await submit(change, cookie, csrfOf(page.body), "run", [], host)).statusCode).toBe(303);
    const final = await reload(change, cookie, host);
    expect(final.body).toContain("Точно удалить? Это нельзя отменить.");
    expect(final.body).toContain("value=\"run\">Да, удалить</button>");
    const done = await submit(change, cookie, csrfOf(final.body), "run", [], host);
    expect(done.body).toContain("<h1>Готово</h1>");
    expect(done.body).toContain("Сервис ответил: 200. Вернитесь в чат — ассистент увидит результат.");
    await host.close();
  });
});

describe("the first change link before any administrator exists", () => {
  let application: Application;
  let server: FastifyInstance;
  let sent: string[];
  let connectionId: string;

  beforeEach(() => {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        sent.push(input.toString());
        return new Response(JSON.stringify({ updated: true }), { status: 200 });
      },
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.vault.storeFields("credentials-1", { "X-Shop-Key": SECRET });
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: "credentials-1",
      adapterId: adapter.id,
    }).id;
    server = buildHttpServer(application);
  });

  afterEach(async () => {
    await server.close();
    application.db.close();
  });

  const tools = () => createToolHandlers(application.mcpDependencies);
  const follow = async (url: string, headers: Record<string, string> = HOST) => {
    const response = await server.inject({ method: "GET", url, headers });
    return { response, location: String(response.headers.location ?? "") };
  };

  it("leads through creating the administrator and back to the change, which then runs once", async () => {
    application.changes.setWrites(connectionId, true);
    const { result } = await tools().request_change({ connectionId, operationId: "set_price", args: { nmId: NM_ID, price: 349 }, summary: SUMMARY });
    if (result.status !== "pending") throw new Error(`Expected a pending change, got ${result.status}`);
    const url = new URL(result.confirmation.url);
    const setup = url.searchParams.get("setup") ?? "";
    // The link carries the setup token, and only while no administrator exists.
    expect(application.setupToken!.matches(setup)).toBe(true);
    const change = `${url.pathname}?t=${url.searchParams.get("t")}`;

    // The change asks for the sign-in, the sign-in for the setup, and each keeps the way back to the change.
    const opened = await follow(`${url.pathname}${url.search}`);
    expect(opened.location).toBe(`/login?next=${encodeURIComponent(change)}&setup=${setup}`);
    const signIn = await follow(opened.location);
    expect(signIn.location).toBe(`/setup?t=${setup}&next=${encodeURIComponent(change)}`);
    const page = await follow(signIn.location);
    expect(page.response.statusCode).toBe(200);
    expect(page.response.body).toContain(`<input type="hidden" name="next" value="${change}">`);
    expect(sent).toEqual([]);

    const created = await server.inject({
      method: "POST",
      url: "/setup",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["t", setup], ["next", change], ["password", PASSWORD], ["confirmPassword", PASSWORD]]),
    });
    expect([created.statusCode, created.headers.location]).toEqual([303, change]);
    const session = cookieHeader(created);

    const back = await follow(change, { ...HOST, cookie: session });
    expect(back.location).toBe(url.pathname);
    const cookie = `${session}; ${cookieHeader(back.response)}`;
    const confirm = await follow(url.pathname, { ...HOST, cookie });
    expect(confirm.response.statusCode).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/u.exec(confirm.response.body)?.[1] ?? "";
    const done = await server.inject({
      method: "POST",
      url: url.pathname,
      headers: { ...HOST, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["decision", "run"]]),
    });
    expect(done.body).toContain("<h1>Done</h1>");
    expect(sent).toEqual([`${ORIGIN}/prices`]);

    // The token is spent, and links made from now on lead to the sign-in alone.
    expect(application.setupToken!.matches(setup)).toBe(false);
    const later = await tools().request_change({ connectionId, operationId: "set_price", args: { nmId: NM_ID, price: 350 }, summary: SUMMARY });
    if (later.result.status !== "pending") throw new Error("Expected a pending change");
    expect(new URL(later.result.confirmation.url).searchParams.has("setup")).toBe(false);
  });

  it("gives the setup token to the connection page the assistant names when changing data is off, and returns there", async () => {
    const { result } = await tools().request_change({ connectionId, operationId: "set_price", args: { nmId: NM_ID, price: 349 }, summary: SUMMARY });
    expect(result.status).toBe("refused");
    const link = /on this page: (\S+) \./u.exec(result.nextStep)?.[1] ?? "";
    const url = new URL(link);
    const setup = url.searchParams.get("setup") ?? "";
    expect(url.pathname).toBe(`/connections/${connectionId}`);
    expect(application.setupToken!.matches(setup)).toBe(true);

    const opened = await follow(`${url.pathname}${url.search}`);
    expect(opened.location).toBe(`/setup?t=${setup}&next=${encodeURIComponent(url.pathname)}`);
    const page = await follow(opened.location);
    expect(page.response.body).toContain(`<input type="hidden" name="next" value="${url.pathname}">`);
  });

  it("does not give the way back to a page the assistant's links do not lead to", async () => {
    const setup = application.setupToken!.issue();
    for (const next of ["//evil.test/", "https://evil.test/", "/connections", "/tunnel", `/confirm/change/${connectionId}?t=short`]) {
      const signIn = await follow(`/login?next=${encodeURIComponent(next)}&setup=${setup}`);
      expect(signIn.location, next).toBe(`/setup?t=${setup}`);
      const created = await server.inject({
        method: "POST",
        url: "/setup",
        headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["t", setup], ["next", next], ["password", PASSWORD], ["confirmPassword", "mismatch on purpose"]]),
      });
      expect(created.body, next).not.toContain(encodeURIComponent(next));
    }
  });
});
