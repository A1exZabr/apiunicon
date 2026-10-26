import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import { ranAtOnce } from "../../src/changes/service.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 15),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

const SHOP_ORIGIN = "https://api.shop.test";
const BASE_URL = "http://127.0.0.1:3210";

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
  ],
};

const WARNING =
  "<p class=\"warning\">Your assistant will change data in the service at once, without showing you the change and without your “Run”. The assistant's mistakes reach the service at once.</p>";
const FIRST_TIME =
  "<p>Only an action you have already confirmed on this connection once on a page on this computer, in its current form, runs at once, and from then on it runs with any values. A new action, or one your assistant has changed since, comes to you as a link to confirm the first time.</p>";
const FIRST_TIME_EVERYWHERE =
  "<p>Only an action you have already confirmed on the same connection once on a page on this computer, in its current form, runs at once, and from then on it runs with any values. A new action, or one your assistant has changed since, comes to you as a link to confirm the first time.</p>";
const DELETIONS = "<p>Deletions still need your confirmation on a page on this computer.</p>";
const BACK = '<p class="muted">You can turn confirmation back on with one button at any time.</p>';
const TICK = '<label class="confirm"><input required type="checkbox" name="understood" value="yes"> I understand</label>';
const UNTICKED = "<p class=\"error\">Tick “I understand” to stop asking for confirmation.</p>";
// The hints of a connection's card: confirmation asked or off, with changing data on or off.
const HINT_REQUIRED =
  "Your assistant can propose changes; each one runs only after you confirm it on a page on this computer.";
const HINT_REQUIRED_WRITES_OFF =
  "Changing data is off, so your assistant cannot propose changes. If you turn it on, each change runs only after you confirm it on a page on this computer.";
const HINT_OFF =
  "Your assistant runs at once, without your confirmation, only actions you have already confirmed once on this connection in their current form, and from then on with any values. A new or changed action comes as a link to confirm on a page on this computer the first time; deletions always do.";
const HINT_OFF_WRITES_OFF =
  "Changing data is off, so your assistant changes nothing through this connection. If you turn it on, your assistant will run at once, without your confirmation, only actions you have already confirmed once on this connection in their current form, and from then on with any values. A new or changed action will come as a link to confirm on a page on this computer the first time; deletions always will.";
const ALSO_EVERYWHERE = "It is also off for every connection on the start page.";
const START_HINT =
  '<p class="muted">By default every change waits for your confirmation on a page on this computer. Deletions always do. A connection can have its own setting on its page.</p>';
const START_HINT_OFF =
  '<p class="muted">On connections where changing data is on, your assistant runs at once, without your confirmation, only actions you have already confirmed once on that connection in their current form, and from then on with any values. A new or changed action comes as a link to confirm on a page on this computer the first time; deletions always do.</p>';
const hint = (text: string) => `<p class="muted">${text}</p>`;

const statusRow = (name: string, value: string) => `<div class="row"><span>${name}</span><span class="status">${value}</span></div>`;

describe("confirming changes in the local workspace", () => {
  let application: Application;
  let server: ReturnType<typeof buildHttpServer>;
  let session: { cookies: string; csrf: string };
  let connectionId: string;
  let otherId: string;

  function connect(label: string, credentialSetId: string): string {
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    const draft = application.adapters.create({ slug: `shop-${credentialSetId}`, displayName: "Shop", documentationSourceId: source.id, dsl: shopDsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.vault.storeFields(credentialSetId, { "X-Shop-Key": `shop-secret-${credentialSetId}` });
    return application.connections.createConnection({
      label, documentationSourceId: source.id, allowedOrigins: [SHOP_ORIGIN], credentialSetId, adapterId: adapter.id,
    }).id;
  }

  beforeEach(async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(JSON.stringify({ updated: true }), { status: 200 }),
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

  const get = (url: string) => server.inject({ method: "GET", url, headers: { ...LOCAL, cookie: session.cookies } });
  const page = (id = connectionId) => get(`/connections/${id}`);
  const post = (url: string, fields: Array<[string, string]>, csrf = session.csrf, cookies = session.cookies) => server.inject({
    method: "POST",
    url,
    headers: { ...LOCAL, cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
    payload: form([["csrf", csrf], ...fields]),
  });
  const confirmChanges = (id = connectionId) => application.connections.getConnection(id).confirmChanges;
  const writes = (enabled: "1" | "0", id = connectionId) => post(`/connections/${id}/writes`, [["enabled", enabled]]);

  it("turns confirmation off for one connection only after the warning and the tick, and back with one button", async () => {
    const warningPath = `/connections/${connectionId}/changes-confirmation`;
    const initial = (await page()).body;
    expect(initial).toContain(statusRow("Confirmation", "Ask"));
    expect(initial).toContain(`<a class="button secondary" href="${warningPath}">Stop asking for confirmation</a>`);
    // Changing data is off by default, and the hint says what that means before it says what confirmation does.
    expect(initial).toContain(hint(HINT_REQUIRED_WRITES_OFF));
    expect(initial).not.toContain(HINT_REQUIRED);
    expect(initial).not.toContain(HINT_OFF);
    await writes("1");
    expect((await page()).body).toContain(hint(HINT_REQUIRED));

    const warning = await get(warningPath);
    expect(warning.statusCode).toBe(200);
    expect(warning.headers["content-type"]).toContain("text/html");
    for (const text of [
      "<title>Changes without confirmation · APIUniCon</title>",
      "<h1>Changes without confirmation</h1>",
      WARNING,
      FIRST_TIME,
      DELETIONS,
      "<p>This is for the connection “Shop” only.</p>",
      BACK,
      `<form method="post" action="${warningPath}"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="required" value="0">`,
      TICK,
      "Stop asking for confirmation</button>",
      `<a class="button secondary" href="/connections/${connectionId}">Keep confirmation</a>`,
    ]) expect(warning.body).toContain(text);
    expect(warning.body).not.toContain("every connection, new ones too");
    expect(warning.body).not.toContain('class="error"');
    // The confirmation buttons say what they do and do not borrow the words of the switch for changing data.
    expect(warning.body).not.toMatch(/Turn (?:on|off)/u);

    // No tick, or a tick with another value: the warning again, and nothing changes.
    for (const fields of [[["required", "0"]], [["required", "0"], ["understood", "on"]]] as Array<Array<[string, string]>>) {
      const unticked = await post(warningPath, fields);
      expect(unticked.statusCode).toBe(400);
      expect(unticked.headers["content-type"]).toContain("text/html");
      expect(unticked.body).toContain(UNTICKED);
      expect(unticked.body).toContain(WARNING);
      expect(unticked.body).toContain(TICK);
      expect(confirmChanges()).toBe(true);
    }
    // Another form's token, none, or no session at all.
    expect((await post(warningPath, [["required", "0"], ["understood", "yes"]], "not-the-token")).statusCode).toBe(403);
    expect((await post(warningPath, [["required", "0"], ["understood", "yes"]], "")).statusCode).toBe(403);
    const sessionOnly = session.cookies.split("; ").filter((entry) => entry.startsWith("apiunicon_session=")).join("; ");
    expect((await post(warningPath, [["required", "0"], ["understood", "yes"]], session.csrf, sessionOnly)).statusCode).toBe(403);
    const anonymous = await server.inject({
      method: "POST",
      url: warningPath,
      headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["required", "0"], ["understood", "yes"]]),
    });
    expect([anonymous.statusCode, anonymous.headers.location]).toEqual([303, "/login"]);
    expect((await server.inject({ method: "GET", url: warningPath, headers: LOCAL })).headers.location).toBe("/login");
    // A link or an image: GET only shows the page.
    expect((await get(`${warningPath}?required=0&understood=yes&csrf=${session.csrf}`)).statusCode).toBe(200);
    // A good token with a value that is neither 1 nor 0, or none.
    for (const fields of [[["required", "yes"], ["understood", "yes"]], [["understood", "yes"]], [["required", ""]]] as Array<Array<[string, string]>>) {
      const refused = await post(warningPath, fields);
      expect(refused.statusCode).toBe(400);
      expect(refused.headers["content-type"]).toContain("text/plain");
      expect(refused.body).toBe("The setting must be 1 or 0");
    }
    expect(confirmChanges()).toBe(true);
    expect(application.changes.changesConfirmation(application.connections.getConnection(connectionId))).toBe("required");

    const off = await post(warningPath, [["required", "0"], ["understood", "yes"]]);
    expect([off.statusCode, off.headers.location]).toEqual([303, `/connections/${connectionId}`]);
    expect(confirmChanges()).toBe(false);
    // Only this connection, and not every one.
    expect(confirmChanges(otherId)).toBe(true);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(false);

    const offPage = (await page()).body;
    expect(offPage).toContain(statusRow("Confirmation", "Don't ask"));
    expect(offPage).toContain(hint(HINT_OFF));
    expect(offPage).not.toContain(HINT_REQUIRED);
    expect(offPage).not.toContain(ALSO_EVERYWHERE);
    expect(offPage).toContain(
      `<form method="post" action="${warningPath}"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="required" value="1"><button type="submit">Ask for confirmation again</button></form>`,
    );
    expect(offPage).not.toContain(`href="${warningPath}"`);
    const otherPage = (await page(otherId)).body;
    expect(otherPage).toContain(statusRow("Confirmation", "Ask"));
    expect(otherPage).toContain(hint(HINT_REQUIRED_WRITES_OFF));
    // With changing data off, the hint does not say the assistant changes data at once.
    await writes("0");
    const writesOff = (await page()).body;
    expect(writesOff).toContain(statusRow("Confirmation", "Don't ask"));
    expect(writesOff).toContain(hint(HINT_OFF_WRITES_OFF));
    expect(writesOff).not.toContain(hint(HINT_OFF));

    // Back with one button: no warning, no tick.
    const back = await post(warningPath, [["required", "1"]]);
    expect([back.statusCode, back.headers.location]).toEqual([303, `/connections/${connectionId}`]);
    expect(confirmChanges()).toBe(true);
    const asked = (await page()).body;
    expect(asked).toContain(statusRow("Confirmation", "Ask"));
    expect(asked).toContain(hint(HINT_REQUIRED_WRITES_OFF));

    // A connection that does not exist is refused, on the page and in the form.
    expect((await get("/connections/missing/changes-confirmation")).statusCode).toBeGreaterThanOrEqual(400);
    expect((await post("/connections/missing/changes-confirmation", [["required", "0"], ["understood", "yes"]])).statusCode)
      .toBeGreaterThanOrEqual(400);
  });

  it("turns confirmation off for every connection on the start page the same way and shows it on each connection", async () => {
    const start = (await get("/")).body;
    expect(start).toContain('<section class="card section-gap" id="changes-confirmation"><h2>Confirming changes</h2>');
    expect(start).toContain(statusRow("Every connection", "Ask"));
    expect(start).toContain(START_HINT);
    expect(start).not.toContain(START_HINT_OFF);
    expect(start).toContain('<a class="button secondary" href="/changes-confirmation">Stop asking for confirmation</a>');
    // After the connections and the steps, not inside them.
    expect(start.indexOf('id="changes-confirmation"')).toBeGreaterThan(start.indexOf("What happens automatically"));

    const warning = await get("/changes-confirmation");
    expect(warning.statusCode).toBe(200);
    for (const text of [
      "<h1>Changes without confirmation</h1>",
      WARNING,
      FIRST_TIME_EVERYWHERE,
      DELETIONS,
      "<p>This is for every connection, new ones too.</p>",
      BACK,
      `<form method="post" action="/changes-confirmation"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="required" value="0">`,
      TICK,
      '<a class="button secondary" href="/">Keep confirmation</a>',
    ]) expect(warning.body).toContain(text);
    expect(warning.body).not.toContain("This is for the connection");
    expect(warning.body).not.toContain("on this connection");

    const unticked = await post("/changes-confirmation", [["required", "0"]]);
    expect(unticked.statusCode).toBe(400);
    expect(unticked.body).toContain(UNTICKED);
    expect(unticked.body).toContain("<p>This is for every connection, new ones too.</p>");
    expect((await post("/changes-confirmation", [["required", "0"], ["understood", "yes"]], "not-the-token")).statusCode).toBe(403);
    expect((await post("/changes-confirmation", [["required", "off"], ["understood", "yes"]])).body).toBe("The setting must be 1 or 0");
    expect(application.changes.skipsConfirmationEverywhere()).toBe(false);

    const off = await post("/changes-confirmation", [["required", "0"], ["understood", "yes"]]);
    expect([off.statusCode, off.headers.location]).toEqual([303, "/"]);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(true);
    // The connections' own settings stay as they were.
    expect([confirmChanges(), confirmChanges(otherId)]).toEqual([true, true]);

    const startOff = (await get("/")).body;
    expect(startOff).toContain(statusRow("Every connection", "Don't ask"));
    // The hint says what is in effect now, as on a connection's page, and only where changing data is on.
    expect(startOff).toContain(START_HINT_OFF);
    expect(startOff).not.toContain(START_HINT);
    expect(startOff).toContain(
      `<form method="post" action="/changes-confirmation"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="required" value="1"><button type="submit">Ask for confirmation again</button></form>`,
    );
    expect(startOff).not.toContain('href="/changes-confirmation"');
    // Changing data on for the first connection only.
    await writes("1");
    for (const [id, expected] of [[connectionId, HINT_OFF], [otherId, HINT_OFF_WRITES_OFF]]) {
      const body = (await page(id)).body;
      expect(body).toContain(statusRow("Confirmation", "Don't ask — setting for every connection"));
      expect(body).toContain('<a href="/#changes-confirmation">Change it on the start page</a>');
      expect(body).toContain(hint(expected!));
      expect(body).not.toContain(ALSO_EVERYWHERE);
      expect(body).not.toContain(`href="/connections/${id}/changes-confirmation"`);
      expect(body).not.toContain("Ask for confirmation again");
    }

    // A connection turned off on its own page says so, keeps its own way back, and says the start page has it off too.
    application.changes.setConfirmChanges(connectionId, false);
    application.changes.setConfirmChanges(otherId, false);
    const own = (await page()).body;
    expect(own).toContain(statusRow("Confirmation", "Don't ask"));
    expect(own).toContain("Ask for confirmation again</button>");
    expect(own).toContain(hint(`${HINT_OFF} ${ALSO_EVERYWHERE}`));
    expect((await page(otherId)).body).toContain(hint(`${HINT_OFF_WRITES_OFF} ${ALSO_EVERYWHERE}`));
    application.changes.setConfirmChanges(connectionId, true);
    application.changes.setConfirmChanges(otherId, true);

    const back = await post("/changes-confirmation", [["required", "1"]]);
    expect([back.statusCode, back.headers.location]).toEqual([303, "/"]);
    expect(application.changes.skipsConfirmationEverywhere()).toBe(false);
    const startBack = (await get("/")).body;
    expect(startBack).toContain(statusRow("Every connection", "Ask"));
    expect(startBack).toContain(START_HINT);
    const after = (await page()).body;
    expect(after).toContain(statusRow("Confirmation", "Ask"));
    expect(after).toContain(hint(HINT_REQUIRED));
    expect((await page(otherId)).body).toContain(hint(HINT_REQUIRED_WRITES_OFF));
  });

  it("marks in the journal a change made without confirmation", async () => {
    await writes("1");
    application.changes.setConfirmChanges(connectionId, false);
    const ask = (nmId: number) => application.changes.request({
      connectionId, operationId: "set_price", args: { nmId, price: 2 }, summary: "Set the price", baseUrl: BASE_URL, requestedVia: "Claude",
    });
    const labelsOf = (body: string) => [...body.matchAll(/<td[^>]*data-outcome[^>]*>([^<]*)<\/td>/gu)].map((match) => match[1]);

    // The first time the operation still goes by link, and the person confirms it on the page.
    const first = await ask(1);
    if (first.status !== "pending") throw new Error(`Expected a pending change, got ${first.status}`);
    const token = new URL(first.confirmation.url).searchParams.get("t") ?? "";
    expect(await application.changes.decide(first.changeId, token, "run", 0)).toMatchObject({ kind: "decided" });
    // Then the same operation runs at once.
    const second = await ask(2);
    expect(ranAtOnce(second) && second.status).toBe("succeeded");
    const third = await ask(3);
    expect(ranAtOnce(third)).toBe(true);
    application.changes.setConfirmChanges(connectionId, true);
    expect((await ask(4)).status).toBe("pending");

    expect(labelsOf((await page()).body)).toEqual([
      "Waiting for you",
      "Done, the service answered 200 · without confirmation",
      "Done, the service answered 200 · without confirmation",
      "Done, the service answered 200",
    ]);
  });

  it("writes the connection's name on the warning page as text, with its invisible and direction characters written out", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const backslash = String.fromCharCode(92);
    const hostile = connect(`<script>alert(1)</script>${rlo}pohS${zwsp}`, "credentials-3");
    const spelled = `&lt;script&gt;alert(1)&lt;/script&gt;${backslash}u202epohS${backslash}u200b`;

    const warning = (await get(`/connections/${hostile}/changes-confirmation`)).body;
    expect(warning).toContain(`<p>This is for the connection “${spelled}” only.</p>`);
    expect(warning).not.toContain("<script>alert");
    expect(warning).not.toMatch(/\p{Cf}/u);
    const unticked = (await post(`/connections/${hostile}/changes-confirmation`, [["required", "0"]])).body;
    expect(unticked).toContain(`<p>This is for the connection “${spelled}” only.</p>`);
    expect(unticked).not.toContain("<script>alert");
    expect(unticked).not.toMatch(/\p{Cf}/u);
  });
});
