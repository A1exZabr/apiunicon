import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterDsl, AdapterOperation } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { READ_APPROVAL_LINK_TTL_MS } from "../../src/connections/action-links.js";
import { decodeUrlEncoded } from "../../src/http/forms.js";
import { linkFormToken, localOneTimePageOptions } from "../../src/http/one-time.js";
import { READ_APPROVAL_COOKIE, registerReadApprovalRoutes } from "../../src/http/reads-page.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { awaitsReadApproval, createToolHandlers } from "../../src/mcp/tools.js";
import { cookieHeader, form, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 47),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const ORIGIN = "https://api.shop.test";
const HOST = { host: "127.0.0.1:3210" };
const PASSWORD = "correct horse battery staple";

const read = (overrides: Partial<AdapterOperation> & Pick<AdapterOperation, "id">): AdapterOperation => ({
  description: "List orders", risk: "read", method: "POST", path: "/orders/list", input: {}, documentationRefs: [], ...overrides,
});

// Words from someone else: markup, and a direction override that would turn the text around on the page.
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [
    read({ id: "list_orders", description: `List orders <img src=x onerror=alert(1)> ${String.fromCodePoint(0x202e)}sredro` }),
    read({
      id: "sales_report", description: "Sales for a period", path: "/v1/<b>sales</b>",
      input: {
        "query<i>": { type: "string", location: "body", required: false },
        limit: { type: "integer", location: "query", required: false },
      },
    }),
    read({ id: "get_stock", description: "Stock left", method: "GET", path: "/stock" }),
  ],
};

const csrfOf = (body: string) => /name="csrf" value="([^"]+)"/u.exec(body)?.[1] ?? "";
const fingerprintOf = (body: string) => /name="fingerprint" value="([^"]+)"/u.exec(body)?.[1] ?? "";

type Link = { pathname: string; search: string; token: string };

describe("the page that approves reads sent with POST", () => {
  let application: Application;
  let server: FastifyInstance;
  let connectionId: string;
  let adapterId: string;
  let sent: string[];
  // The local workspace's session: the page opens only for the person signed in on this computer.
  let session: string;

  const local = (cookie = "") => ({ ...HOST, cookie: [session, cookie].filter(Boolean).join("; ") });

  beforeEach(async () => {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? "GET"} ${input.toString()}`);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    adapterId = application.adapters.markWorking(draft.id, draft.version).id;
    application.vault.storeFields("keys-1", { "X-Shop-Key": "shop-secret" });
    connectionId = application.connections.createConnection({
      label: "Shop <script>alert(1)</script>", documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: "keys-1", adapterId,
    }).id;
    server = buildHttpServer(application);
    session = (await setupAdmin(server, application, PASSWORD)).cookies;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
    application.db.close();
  });

  // The link the assistant gets when it calls a read that waits.
  async function refusedCall(operationId = "list_orders"): Promise<Link> {
    const result = await createToolHandlers(application.mcpDependencies).call_adapter({ connectionId, operationId, args: {} });
    if (!awaitsReadApproval(result)) throw new Error("Expected the read to wait for approval");
    const url = new URL(result.readApproval.url);
    return { pathname: url.pathname, search: url.search, token: url.searchParams.get("t") ?? "" };
  }

  async function open(link: Link, on: FastifyInstance = server) {
    const opened = await on.inject({ method: "GET", url: `${link.pathname}${link.search}`, headers: local() });
    expect(opened.statusCode).toBe(303);
    expect(opened.headers.location).toBe(link.pathname);
    const cookie = cookieHeader(opened);
    const page = await on.inject({ method: "GET", url: link.pathname, headers: local(cookie) });
    return { opened, cookie, page };
  }

  function submit(link: Link, cookie: string, fields: Array<[string, string]>, on: FastifyInstance = server, headers: Record<string, string> = local(cookie)) {
    return on.inject({
      method: "POST", url: link.pathname,
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: form(fields),
    });
  }

  it("shows the inputs of each read, says the approval covers any of their values, and marks those that take any text", async () => {
    const { page } = await open(await refusedCall());

    expect(page.body).toContain("<p>Allowing a request allows it with any values your assistant chooses for its inputs.</p>");
    expect(page.body).toContain('<div class="row"><span>Inputs</span><span>None</span></div>');
    expect(page.body).toContain(
      '<ul><li class="warning" data-free-form><code>query&lt;i&gt;</code> string, in the body. Takes any text or data: through it the request can ask the service for anything, a change included.</li><li><code>limit</code> integer, in the query</li></ul>',
    );
    expect(page.body).not.toContain("<i>");
  });

  it("lists every read that waits, escaped, approves them on one click, and the link works once", async () => {
    const link = await refusedCall();
    expect(link.pathname).toBe(`/confirm/reads/${connectionId}`);
    const { opened, cookie, page } = await open(link);

    expect(opened.headers["set-cookie"]).toBe(
      `${READ_APPROVAL_COOKIE}=${link.token}; Path=/confirm/reads/${connectionId}; HttpOnly; SameSite=Lax; Max-Age=${READ_APPROVAL_LINK_TTL_MS / 1_000}`,
    );
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain("Allow these requests to “Shop &lt;script&gt;alert(1)&lt;/script&gt;” as reads?");
    expect(page.body).toContain(
      "These requests are sent with the POST method, and the adapter labels them as reads. If you allow them, your assistant will call them without asking you. Allow them only if they change nothing. If one of them changes data, ask your assistant to label it as a change.",
    );
    expect(page.body).toContain("List orders &lt;img src=x onerror=alert(1)&gt; \\u202esredro");
    expect(page.body).toContain("<code>POST https://api.shop.test/v1/&lt;b&gt;sales&lt;/b&gt;</code>");
    expect(page.body).not.toContain("<img");
    expect(page.body).not.toContain("<script>alert");
    expect(page.body).not.toContain(String.fromCodePoint(0x202e));
    expect(page.body).not.toContain("Stock left");
    expect(page.body).toContain('value="approve">Allow as reads</button>');
    expect(page.body).toContain('value="decline" class="secondary">Don&#39;t allow</button>');

    expect((await submit(link, cookie, [["csrf", "forged"], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]])).statusCode)
      .toBe(403);
    const approved = await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]]);
    expect(approved.statusCode).toBe(200);
    expect(approved.body).toContain("<h1>Allowed as reads</h1>");
    expect(approved.headers["set-cookie"]).toContain("Max-Age=0");
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
    const tools = createToolHandlers(application.mcpDependencies);
    expect(await tools.call_adapter({ connectionId, operationId: "list_orders", args: {} })).toMatchObject({ ok: true });
    expect(await tools.call_adapter({ connectionId, operationId: "sales_report", args: {} })).toMatchObject({ ok: true });
    expect(sent).toEqual([`POST ${ORIGIN}/orders/list`, `POST ${ORIGIN}/v1/%3Cb%3Esales%3C/b%3E`]);

    // The link and its form were used up.
    expect((await server.inject({ method: "GET", url: `${link.pathname}${link.search}`, headers: local() })).statusCode).toBe(403);
    expect((await server.inject({ method: "GET", url: link.pathname, headers: local(cookie) })).statusCode).toBe(403);
    const again = await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "decline"]]);
    expect(again.statusCode).toBe(403);
  });

  it("approves nothing on decline, and uses the link", async () => {
    const link = await refusedCall();
    const { cookie, page } = await open(link);

    const declined = await submit(link, cookie, [["csrf", csrfOf(page.body)], ["decision", "decline"]]);
    expect(declined.statusCode).toBe(200);
    expect(declined.body).toContain("<h1>Not allowed</h1>");
    expect(application.readApprovals.pendingCount(connectionId)).toBe(2);
    expect((await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]])).statusCode)
      .toBe(403);
    expect(sent).toEqual([]);
  });

  it("approves nothing when the adapter changed after the page opened, and shows the list as it is now", async () => {
    const link = await refusedCall();
    const { cookie, page } = await open(link);
    const current = application.adapters.get(adapterId);
    application.adapters.patch(adapterId, current.version, {
      ...dsl,
      operations: [{ ...dsl.operations[0]!, description: "List orders and delete the cancelled ones" }, ...dsl.operations.slice(1)],
    });

    const changed = await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]]);
    expect(changed.statusCode).toBe(409);
    expect(changed.body).toContain("The list changed after the page opened, so nothing was allowed. Check it again.");
    expect(changed.body).toContain("List orders and delete the cancelled ones");
    expect(application.readApprovals.pendingCount(connectionId)).toBe(2);
    // An empty or a made-up fingerprint approves nothing either.
    for (const fingerprint of ["", "x"]) {
      expect((await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprint], ["decision", "approve"]])).statusCode)
        .toBe(409);
    }
    const approved = await submit(link, cookie, [["csrf", csrfOf(changed.body)], ["fingerprint", fingerprintOf(changed.body)], ["decision", "approve"]]);
    expect(approved.statusCode).toBe(200);
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
  });

  it("says there is nothing to approve when every read was approved since, and refuses an expired link", async () => {
    const first = await refusedCall();
    const second = await refusedCall();
    const { cookie, page } = await open(first);
    expect((await submit(first, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]])).statusCode)
      .toBe(200);

    const nothing = await open(second);
    expect(nothing.page.statusCode).toBe(200);
    expect(nothing.page.body).toContain("<h1>Nothing to approve</h1>");
    expect(nothing.page.body).not.toContain("<form");

    vi.useFakeTimers({ now: Date.now() + READ_APPROVAL_LINK_TTL_MS + 1_000, toFake: ["Date"] });
    expect((await server.inject({ method: "GET", url: `${second.pathname}${second.search}`, headers: local() })).statusCode).toBe(403);
    const late = await server.inject({ method: "GET", url: second.pathname, headers: local(nothing.cookie) });
    expect(late.statusCode).toBe(403);
    expect(late.body).toContain("This link has expired");
  });

  it("asks for the local sign-in and returns to the link after it; the link, its cookie and its form token alone approve nothing", async () => {
    const link = await refusedCall();
    const { cookie, page } = await open(link);
    const fields: Array<[string, string]> = [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]];
    const href = `${link.pathname}${link.search}`;
    const toSignIn = (next: string) => `/login?next=${encodeURIComponent(next)}`;

    // What the assistant has: the link, the cookie it sets and the form token, which is derived from the link's token.
    expect(fields[0]![1]).toBe(linkFormToken("reads", link.token));
    const post = await submit(link, cookie, fields, server, { ...HOST, cookie });
    expect(post.statusCode).toBe(303);
    expect(post.headers.location).toBe(toSignIn(link.pathname));
    const encoded = await server.inject({
      method: "POST", url: link.pathname.replace("/reads/", "/%72eads/"),
      headers: { ...HOST, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form(fields),
    });
    expect(encoded.statusCode).toBe(303);
    const viaLink = await server.inject({ method: "GET", url: href, headers: HOST });
    expect(viaLink.statusCode).toBe(303);
    expect(viaLink.headers.location).toBe(toSignIn(href));
    expect(viaLink.headers["set-cookie"]).toBeUndefined();
    expect(application.readApprovals.pendingCount(connectionId)).toBe(2);

    // The person signs in and comes back to the link.
    const unlocked = await server.inject({
      method: "POST", url: "/login",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["password", PASSWORD], ["next", href]]),
    });
    expect(unlocked.statusCode).toBe(303);
    expect(unlocked.headers.location).toBe(href);
    session = cookieHeader(unlocked);
    const reopened = await open(link);
    expect((await submit(link, reopened.cookie, fields)).statusCode).toBe(200);
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
  });

  it("opens only on this computer, and takes no form from another site", async () => {
    const link = await refusedCall();
    const away = await server.inject({ method: "GET", url: `${link.pathname}${link.search}`, headers: { ...local(), host: "attacker.example" } });
    expect(away.statusCode).toBe(421);
    // Not before the setup either: the link carries no setup token once an administrator exists.
    expect(link.search).not.toContain("setup=");

    const { cookie, page } = await open(link);
    const fields: Array<[string, string]> = [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]];
    for (const source of [{ origin: "https://attacker.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
      const refused = await submit(link, cookie, fields, server, { ...local(cookie), ...source });
      expect(refused.statusCode, JSON.stringify(source)).toBe(403);
    }
    expect(application.readApprovals.pendingCount(connectionId)).toBe(2);
    const sameSite = await submit(link, cookie, fields, server, { ...local(cookie), origin: "http://127.0.0.1:3210", "sec-fetch-site": "same-origin" });
    expect(sameSite.statusCode).toBe(200);
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
  });

  it("serves the same page for a host that puts its own sign-in in front, in its own design", async () => {
    const host = Fastify();
    host.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, decodeUrlEncoded(typeof body === "string" ? body : body.toString("utf8")));
    });
    registerReadApprovalRoutes(host, {
      ...localOneTimePageOptions(application),
      locale: () => "ru",
      render: (_request, title, body) => `<main data-title="${title}">${body}</main>`,
      secureCookies: true,
    });
    const link = await refusedCall();

    const { opened, cookie, page } = await open(link, host);
    expect(opened.headers["set-cookie"]).toContain("; Secure");
    expect(page.body).toContain('<main data-title="Одобрение чтения">');
    expect(page.body).toContain("Разрешить как чтение");
    const approved = await submit(link, cookie, [["csrf", csrfOf(page.body)], ["fingerprint", fingerprintOf(page.body)], ["decision", "approve"]], host);
    expect(approved.body).toContain("Разрешено как чтение");
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
    await host.close();
  });
});

describe("the first approval link before any administrator exists", () => {
  let application: Application;
  let server: FastifyInstance;
  let connectionId: string;

  beforeEach(() => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    });
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapterId = application.adapters.markWorking(draft.id, draft.version).id;
    application.vault.storeFields("keys-1", { "X-Shop-Key": "shop-secret" });
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: "keys-1", adapterId,
    }).id;
    server = buildHttpServer(application);
  });

  afterEach(async () => {
    await server.close();
    application.db.close();
  });

  const follow = async (url: string, headers: Record<string, string> = HOST) => {
    const response = await server.inject({ method: "GET", url, headers });
    return { response, location: String(response.headers.location ?? "") };
  };

  it("leads through creating the administrator and back to the link, whose page then approves", async () => {
    const result = await createToolHandlers(application.mcpDependencies).call_adapter({ connectionId, operationId: "list_orders", args: {} });
    if (!awaitsReadApproval(result)) throw new Error("Expected the read to wait for approval");
    const url = new URL(result.readApproval.url);
    const setup = url.searchParams.get("setup") ?? "";
    expect(application.setupToken!.matches(setup)).toBe(true);
    const link = `${url.pathname}?t=${url.searchParams.get("t")}`;

    const opened = await follow(`${url.pathname}${url.search}`);
    expect(opened.location).toBe(`/login?next=${encodeURIComponent(link)}&setup=${setup}`);
    const signIn = await follow(opened.location);
    expect(signIn.location).toBe(`/setup?t=${setup}&next=${encodeURIComponent(link)}`);
    const page = await follow(signIn.location);
    expect(page.response.body).toContain(`<input type="hidden" name="next" value="${link}">`);

    const created = await server.inject({
      method: "POST", url: "/setup",
      headers: { ...HOST, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["t", setup], ["next", link], ["password", PASSWORD], ["confirmPassword", PASSWORD]]),
    });
    expect([created.statusCode, created.headers.location]).toEqual([303, link]);
    const session = cookieHeader(created);
    const back = await follow(link, { ...HOST, cookie: session });
    expect(back.location).toBe(url.pathname);
    const cookie = `${session}; ${cookieHeader(back.response)}`;
    const approval = await follow(url.pathname, { ...HOST, cookie });
    expect(approval.response.statusCode).toBe(200);
    const approved = await server.inject({
      method: "POST", url: url.pathname,
      headers: { ...HOST, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrfOf(approval.response.body)], ["fingerprint", fingerprintOf(approval.response.body)], ["decision", "approve"]]),
    });
    expect(approved.statusCode).toBe(200);
    expect(application.readApprovals.pendingCount(connectionId)).toBe(0);
    expect(application.setupToken!.matches(setup)).toBe(false);
  });
});
