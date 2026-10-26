import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 14),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

describe("documentation crawl of a connection", () => {
  let application: Application;
  let database: Database.Database;
  let shouldFail: boolean;

  beforeEach(() => {
    shouldFail = false;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        if (shouldFail) throw new Error("fixture unavailable");
        return new Response("GET /v3/posting/fbs/list", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    database = application.db;
  });

  afterEach(() => database.close());

  it("lets the administrator retry a failed documentation crawl", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/", allowedOrigin: "https://docs.example.test",
    });
    application.vault.storeFields("credentials-retry", { "Api-Key": "secret" });
    const connection = application.connections.createConnection({
      label: "Retry", documentationSourceId: source.id, allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-retry",
    });
    application.jobs.enqueue("crawl_documentation", source.id);
    shouldFail = true;
    await application.jobRunner.runOne();
    expect(application.connections.getDocumentationSource(connection.documentationSourceId).status).toBe("failed");

    shouldFail = false;
    const retried = await server.inject({
      method: "POST",
      url: `/connections/${connection.id}/retry-crawl`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf]]),
    });
    expect(retried.statusCode).toBe(303);
    expect(retried.headers.location).toBe(`/connections/${connection.id}`);
    expect(application.jobs.latest("crawl_documentation", connection.documentationSourceId)?.status).toBe("queued");
    await application.jobRunner.runOne();
    expect(application.connections.getDocumentationSource(connection.documentationSourceId).status).toBe("ready");
    await server.close();
  });
});

const SHOP_ORIGIN = "https://api.shop.test";
const BASE_URL = "http://127.0.0.1:3210";
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT = String.fromCodePoint(0x202e);

const shopDsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [SHOP_ORIGIN],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [
    {
      id: "set_price",
      description: "Set the price of a product",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: {
        nmId: { type: "integer", location: "body", required: true, description: "Product number" },
        price: { type: "integer", location: "body", required: true, description: "Price" },
      },
      documentationRefs: [],
    },
    {
      id: "rename_card",
      description: `Rename <img src=x onerror=alert(1)> ${ZERO_WIDTH}the card`,
      risk: "write",
      method: "PATCH",
      path: "/cards/{sku}",
      input: {
        sku: { type: "string", location: "path", required: true, description: "SKU <b onmouseover=alert(1)>" },
        title: { type: "string", location: "body", required: true, description: "Title" },
      },
      documentationRefs: [],
    },
    {
      id: "delete_card",
      description: "Delete a card",
      risk: "write",
      method: "DELETE",
      path: "/cards/{nmId}",
      input: { nmId: { type: "integer", location: "path", required: true, description: "Product number" } },
      documentationRefs: [],
    },
  ],
};

describe("changing data on the connection page", () => {
  let application: Application;
  let server: ReturnType<typeof buildHttpServer>;
  let session: { cookies: string; csrf: string };
  let sent: Array<{ method: string; url: string }>;
  let answer: () => Response;
  let connectionId: string;
  let otherId: string;

  function connect(label: string, credentialSetId: string): string {
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    const draft = application.adapters.create({ slug: `shop-${credentialSetId}`, displayName: label, documentationSourceId: source.id, dsl: shopDsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.vault.storeFields(credentialSetId, { "X-Shop-Key": `shop-secret-${credentialSetId}` });
    return application.connections.createConnection({
      label, documentationSourceId: source.id, allowedOrigins: [SHOP_ORIGIN], credentialSetId, adapterId: adapter.id,
    }).id;
  }

  beforeEach(async () => {
    sent = [];
    answer = () => new Response(JSON.stringify({ updated: true }), { status: 200 });
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push({ method: init?.method ?? "GET", url: input.toString() });
        return answer();
      },
    });
    connectionId = connect("Shop", "credentials-1");
    otherId = connect("Other shop", "credentials-2");
    server = buildHttpServer(application);
    session = await setupAdmin(server, application);
  });

  afterEach(async () => {
    await server.close();
    application.db.close();
  });

  const page = (id = connectionId) => server.inject({ method: "GET", url: `/connections/${id}`, headers: { ...LOCAL, cookie: session.cookies } });

  const toggle = (enabled: string | null, id = connectionId, csrf = session.csrf, cookies = session.cookies) => server.inject({
    method: "POST",
    url: `/connections/${id}/writes`,
    headers: { ...LOCAL, cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    payload: form([["csrf", csrf], ...(enabled === null ? [] : [["enabled", enabled] as [string, string]])]),
  });

  // The assistant asks for a change; the link's token is what the person's page would carry.
  async function request(id: string, operationId: string, args: Record<string, unknown>, summary = "Change asked for in the chat") {
    const result = await application.changes.request({
      connectionId: id, operationId, args, summary, baseUrl: BASE_URL, requestedVia: "Claude",
    });
    if (result.status !== "pending") throw new Error(`Expected a pending change, got ${result.status}`);
    return { changeId: result.changeId, token: new URL(result.confirmation.url).searchParams.get("t") ?? "" };
  }

  const rowsOf = (body: string) => body.match(/<tr data-change=/gu)?.length ?? 0;

  it("turns changing data on and off on the connection page, off by default", async () => {
    const initial = await page();
    expect(application.connections.getConnection(connectionId).writesEnabled).toBe(false);
    expect(initial.body).toContain("<h2>Changing data</h2>");
    expect(initial.body).toContain('<span class="status">Off</span>');
    expect(initial.body).toContain(
      "Changing data is off, so your assistant cannot propose changes. If you turn it on, each change runs only after you confirm it on a page on this computer.",
    );
    expect(initial.body).toContain("Turn on</button>");
    expect(initial.body).not.toContain("Turn off");
    expect(initial.body).toContain("No changes yet.");
    const posted = new RegExp(
      `<form method="post" action="/connections/${connectionId}/writes"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="enabled" value="1">`,
      "u",
    );
    expect(initial.body).toMatch(posted);

    const on = await toggle("1");
    expect(on.statusCode).toBe(303);
    expect(on.headers.location).toBe(`/connections/${connectionId}`);
    expect(application.connections.getConnection(connectionId).writesEnabled).toBe(true);
    // Only this connection.
    expect(application.connections.getConnection(otherId).writesEnabled).toBe(false);
    const enabled = await page();
    expect(enabled.body).toContain('<span class="status">On</span>');
    expect(enabled.body).toContain("Turn off</button>");
    expect(enabled.body).not.toContain("Turn on");
    expect(enabled.body).toContain(
      "Your assistant can propose changes; each one runs only after you confirm it on a page on this computer.",
    );
    expect(enabled.body).toContain('<input type="hidden" name="enabled" value="0">');
    expect((await page(otherId)).body).toContain('<span class="status">Off</span>');

    const off = await toggle("0");
    expect(off.statusCode).toBe(303);
    expect(off.headers.location).toBe(`/connections/${connectionId}`);
    expect(application.connections.getConnection(connectionId).writesEnabled).toBe(false);
    expect((await page()).body).toContain('<span class="status">Off</span>');
  });

  it("cancels the changes that wait when the page turns changing data off, for this connection only", async () => {
    await toggle("1");
    await toggle("1", otherId);
    const waiting = await request(connectionId, "set_price", { nmId: 1, price: 2 });
    const otherWaiting = await request(otherId, "set_price", { nmId: 3, price: 4 });
    expect((await page()).body).toContain("Waiting for you");

    await toggle("0");

    expect(application.changes.view(waiting.changeId)).toMatchObject({ status: "cancelled", reason: "writes_off" });
    expect(application.changes.view(otherWaiting.changeId).status).toBe("pending");
    const after = await page();
    expect(after.body).toContain("Cancelled: changing data was turned off");
    expect(after.body).not.toContain("Waiting for you");
    expect((await page(otherId)).body).toContain("Waiting for you");
    expect(sent).toEqual([]);
  });

  it("lists the last changes of the connection on its page, escaped", async () => {
    await toggle("1");
    await toggle("1", otherId);

    const done = await request(connectionId, "set_price", { nmId: 111, price: 349 }, "<svg onload=alert(1)> the assistant's words");
    expect(await application.changes.decide(done.changeId, done.token, "run", 0)).toMatchObject({ kind: "decided" });
    const waiting = await request(connectionId, "rename_card", {
      sku: "<script>alert(1)</script>",
      title: `Fake${RIGHT_TO_LEFT} title${ZERO_WIDTH}`,
    });
    const declined = await request(connectionId, "delete_card", { nmId: 222 });
    await application.changes.decide(declined.changeId, declined.token, "cancel", 0);
    await request(otherId, "set_price", { nmId: 424242, price: 1 });

    const listed = (await page()).body;

    expect(rowsOf(listed)).toBe(3);
    expect(listed).toContain("Recent changes</h2>");
    // Newest first.
    expect(listed.indexOf("Delete a card")).toBeLessThan(listed.indexOf("Rename"));
    expect(listed.indexOf("Rename")).toBeLessThan(listed.indexOf("Set the price of a product"));
    expect(listed).toMatch(/<time datetime="\d{4}-\d\d-\d\dT[\d:.]+Z">\d{4}-\d\d-\d\d \d\d:\d\d UTC<\/time>/u);
    expect(listed).toContain("<code>POST https://api.shop.test/prices</code>");
    expect(listed).toContain("<code>DELETE https://api.shop.test/cards/222</code>");
    expect(listed).toContain("Done, the service answered 200");
    expect(listed).toContain("Cancelled by you");
    expect(listed).toContain("Waiting for you");
    // The values of each change sit under a disclosure, in full.
    expect(listed).toContain("<details><summary>Values</summary>");
    expect(listed).toContain("<dt>Product number <code>nmId</code></dt><dd>111</dd>");
    expect(listed).toContain("<dt>Price <code>price</code></dt><dd>349</dd>");
    // Text that is not APIUniCon's is escaped, and its invisible and direction characters are written out.
    expect(listed).not.toContain("<script>alert(1)</script>");
    expect(listed).not.toContain("<img src=x");
    expect(listed).not.toContain("<b onmouseover");
    expect(listed).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(listed).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(listed).toContain("\\u200bthe card");
    expect(listed).toContain("Fake\\u202e title\\u200b");
    expect(listed).not.toContain(ZERO_WIDTH);
    expect(listed).not.toContain(RIGHT_TO_LEFT);
    // The assistant's words are not shown as if they were the change; another connection's changes are not shown.
    expect(listed).not.toContain("the assistant's words");
    expect(listed).not.toContain("svg onload");
    expect(listed).not.toContain("424242");
    expect((await page(otherId)).body).toContain("424242");
    expect((await page(otherId)).body).not.toContain("<dd>349</dd>");
    // Neither the secret nor the token of a link is on the page.
    expect(listed).not.toContain("shop-secret-credentials-1");
    expect(listed).not.toContain(done.token);
    expect(listed).not.toContain(waiting.token);
  });

  it("says in a few words how each change ended", async () => {
    await toggle("1");
    const stored = (changeId: string, set: string, ...values: unknown[]) => {
      application.db.prepare(`update change_requests set ${set} where id = ?`).run(...values, changeId);
    };
    const labelsOf = (body: string) => [...body.matchAll(/<td[^>]*data-outcome[^>]*>([^<]*)<\/td>/gu)].map((match) => match[1]);
    const ask = async (nmId: number) => request(connectionId, "set_price", { nmId, price: 1 });
    const run = async (nmId: number, reply: () => Response) => {
      answer = reply;
      const created = await ask(nmId);
      await application.changes.decide(created.changeId, created.token, "run", 0);
    };

    await run(1, () => new Response("{}", { status: 200 }));
    await run(2, () => new Response("{}", { status: 500 }));
    await run(3, () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    await run(4, () => { throw new DOMException("timed out", "TimeoutError"); });
    await run(5, () => { throw new Error("socket hang up"); });
    const refused = await ask(6);
    // The switch goes off without the page cancelling what waits, as a cloud plan ending does.
    application.connections.setWritesEnabled(connectionId, false);
    await application.changes.decide(refused.changeId, refused.token, "run", 0);
    application.connections.setWritesEnabled(connectionId, true);

    expect(labelsOf((await page()).body)).toEqual([
      "Not done: changing data was turned off",
      "Sent, result not confirmed",
      "No answer in time, the change may have been made",
      "Not sent, nothing changed",
      "The service answered 500, most likely nothing changed",
      "Done, the service answered 200",
    ]);

    const reasons: Array<[string, string, string]> = [
      ["refused", "plan", "Not done: changing data is not available"],
      ["refused", "adapter_changed", "Not done: the connection changed after the request"],
      ["refused", "limit", "Not done: the call limit was reached"],
      ["refused", "origin", "Not done: the address is no longer allowed"],
      ["cancelled", "superseded", "Replaced by a newer request"],
      ["running", "", "Running"],
    ];
    for (const [index, [status, reason, label]] of reasons.entries()) {
      const created = await ask(100 + index);
      if (status === "running") stored(created.changeId, "status = 'running', decided_at = ?", new Date().toISOString());
      else stored(created.changeId, "status = ?, reason = ?, decided_at = ?", status, reason, new Date().toISOString());
      expect(labelsOf((await page()).body)[0]).toBe(label);
    }

    const lapsed = await ask(200);
    stored(lapsed.changeId, "expires_at = ?", new Date(Date.now() - 1_000).toISOString());
    expect(labelsOf((await page()).body)[0]).toBe("Expired, nothing changed");
  });

  it("marks a change confirmed in the chat card in the journal", async () => {
    await toggle("1");
    const asked = await application.changes.requestWithCard({
      connectionId, operationId: "set_price", args: { nmId: 7, price: 1 }, summary: "Asked for in the chat", baseUrl: BASE_URL,
      requestedVia: "Claude",
    });
    if (asked.result.status !== "pending" || asked.card.kind !== "confirm") throw new Error("Expected a change for the card");
    const { changeId } = asked.result;
    expect(await application.changes.confirmFromCard(changeId, asked.card.cardToken, "run", 0)).toMatchObject({
      kind: "decided", record: { status: "succeeded", confirmation: "card" },
    });
    // Beside it, one confirmed on its page, as before.
    const paged = await request(connectionId, "set_price", { nmId: 8, price: 1 });
    await application.changes.decide(paged.changeId, paged.token, "run", 0);

    const listed = (await page()).body;
    const outcomes = [...listed.matchAll(/<tr data-change="([^"]+)">.*?<td[^>]*data-outcome[^>]*>([^<]*)<\/td><\/tr>/gu)]
      .map((match) => [match[1], match[2]]);

    expect(outcomes).toEqual([
      [paged.changeId, "Done, the service answered 200"],
      [changeId, "Done, the service answered 200 · confirmed in the chat card"],
    ]);
    expect(listed).not.toContain(asked.card.cardToken);
  });

  it("shows only the last 20 changes, newest first", async () => {
    await toggle("1");
    for (let index = 1; index <= 22; index += 1) {
      const created = await request(connectionId, "set_price", { nmId: 1000 + index, price: index });
      await application.changes.decide(created.changeId, created.token, "cancel", 0);
    }

    const listed = (await page()).body;

    expect(rowsOf(listed)).toBe(20);
    expect(listed).toContain("<dd>1022</dd>");
    expect(listed).toContain("<dd>1003</dd>");
    expect(listed).not.toContain("<dd>1002</dd>");
    expect(listed).not.toContain("<dd>1001</dd>");
    expect(listed.indexOf("<dd>1022</dd>")).toBeLessThan(listed.indexOf("<dd>1003</dd>"));
  });

  it("refuses the switch without the session or the form token", async () => {
    const unchanged = () => expect(application.connections.getConnection(connectionId).writesEnabled).toBe(false);

    // No session: the local pages send the visitor to the login.
    const anonymous = await server.inject({
      method: "POST",
      url: `/connections/${connectionId}/writes`,
      headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["enabled", "1"]]),
    });
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe("/login");
    unchanged();

    // The session cookie alone, with no token, a wrong one, or one that is not the cookie's.
    const sessionOnly = session.cookies.split("; ").filter((entry) => entry.startsWith("apiunicon_session=")).join("; ");
    expect((await toggle("1", connectionId, session.csrf, sessionOnly)).statusCode).toBe(403);
    unchanged();
    expect((await toggle("1", connectionId, "")).statusCode).toBe(403);
    expect((await toggle("1", connectionId, "not-the-token")).statusCode).toBe(403);
    unchanged();
    const noToken = await server.inject({
      method: "POST",
      url: `/connections/${connectionId}/writes`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["enabled", "1"]]),
    });
    expect(noToken.statusCode).toBe(403);
    unchanged();

    // A link or an image cannot turn it on: GET changes nothing.
    const viaGet = await server.inject({
      method: "GET", url: `/connections/${connectionId}/writes?enabled=1&csrf=${session.csrf}`, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(viaGet.statusCode).not.toBe(200);
    unchanged();

    // A good token with a value that is neither 1 nor 0, or none: refused, and the switch stays.
    for (const value of ["yes", "true", "", "11", null]) {
      expect((await toggle(value)).statusCode).toBe(400);
    }
    unchanged();
    await toggle("1");
    expect((await toggle("maybe")).statusCode).toBe(400);
    expect(application.connections.getConnection(connectionId).writesEnabled).toBe(true);

    // A connection that does not exist is refused too.
    expect((await toggle("1", "missing")).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("is the only way to turn it on: a request from the chat is refused and points at this page", async () => {
    const handlers = createToolHandlers(application.mcpDependencies);

    const { result: refused } = await handlers.request_change({
      connectionId, operationId: "set_price", args: { nmId: 1, price: 2 }, summary: "Raise the price",
    });

    expect(refused).toMatchObject({ status: "refused", reason: "writes_off" });
    if (refused.status !== "refused") throw new Error("Expected a refusal");
    expect(refused.nextStep).toContain(`${BASE_URL}/connections/${connectionId}`);
    expect(application.connections.getConnection(connectionId).writesEnabled).toBe(false);
    // Nothing the chat can call switches it: the tools do not include the switch.
    expect(Object.keys(handlers).filter((name) => /writ|switch|enable|toggle/iu.test(name))).toEqual([]);
    expect((await page()).body).toContain('<span class="status">Off</span>');
  });
});
