import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { registerConfirmRoutes } from "../../src/http/confirm-page.js";
import { decodeUrlEncoded } from "../../src/http/forms.js";
import { localOneTimePageOptions, type OneTimePageOptions } from "../../src/http/one-time.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { cookieHeader, form } from "./helpers.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 34),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

describe("offering the adapter to the catalog when deleting", () => {
  let application: Application | undefined;
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    await server?.close();
    application?.db.close();
  });

  function addConnection(app: Application, label: string): string {
    const source = app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    app.vault.storeFields(`credentials-${label}`, { "X-Shop-Key": "shop-secret" });
    return app.connections.createConnection({
      label, documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: `credentials-${label}`,
    }).id;
  }

  function setup(extra: Partial<OneTimePageOptions>) {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const app = application;
    const id = addConnection(app, "Shop");
    server = Fastify();
    server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, decodeUrlEncoded(typeof body === "string" ? body : body.toString("utf8")));
    });
    registerConfirmRoutes(server, { ...localOneTimePageOptions(app), ...extra });
    return { app, id, http: server };
  }

  async function open(app: Application, http: FastifyInstance, connectionId: string) {
    const requested = await createToolHandlers(app.mcpDependencies).delete_connection({ connectionId });
    const { pathname, search } = new URL(requested.confirmation.url);
    const cookie = cookieHeader(await http.inject({ method: "GET", url: `${pathname}${search}` }));
    const page = await http.inject({ method: "GET", url: pathname, headers: { cookie } });
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const submit = (fields: Array<[string, string]>) => http.inject({
      method: "POST", url: pathname,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ...fields]),
    });
    return { page, submit, pathname, cookie, csrf };
  }

  it("proposes before deleting when the person ticks the box", async () => {
    const events: string[] = [];
    const { app, id, http } = setup({
      offerProposal: async () => true,
      propose: async (target, connectionId) => {
        events.push(`propose:${target.connections.getConnection(connectionId).label}`);
      },
    });

    const { page, submit } = await open(app, http, id);
    expect(page.body).toContain('name="propose" value="yes"');
    expect(page.body).toContain("Offer the adapter to the shared catalog");
    const deleted = await submit([["propose", "yes"]]);

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain("Connection deleted");
    expect(deleted.body).not.toContain("the adapter was not offered to the catalog");
    expect(events).toEqual(["propose:Shop"]);
    expect(() => app.connections.getConnection(id)).toThrow(/not found/u);
  });

  it("neither proposes nor deletes on a post this link did not make", async () => {
    const events: string[] = [];
    const { app, id, http } = setup({ offerProposal: async () => true, propose: async () => { events.push("propose"); } });
    const otherId = addConnection(app, "Other shop");
    const own = await open(app, http, id);
    const other = await open(app, http, otherId);
    const post = (headers: Record<string, string>, csrf: string) => http.inject({
      method: "POST", url: own.pathname,
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["propose", "yes"]]),
    });

    const answers = await Promise.all([
      post({ cookie: own.cookie }, "forged"),
      post({}, own.csrf),
      // Another connection's link: its cookie and its form token, sent to this connection's address.
      post({ cookie: other.cookie }, other.csrf),
    ]);

    expect(answers.map(({ statusCode }) => statusCode)).toEqual([403, 403, 403]);
    expect(events).toEqual([]);
    expect(app.connections.getConnection(id).label).toBe("Shop");
    expect(app.connections.getConnection(otherId).label).toBe("Other shop");
  });

  it("does not propose when the box is left empty", async () => {
    const events: string[] = [];
    const { app, id, http } = setup({ offerProposal: async () => true, propose: async () => { events.push("propose"); } });

    const { submit } = await open(app, http, id);
    await submit([]);

    expect(events).toEqual([]);
    expect(() => app.connections.getConnection(id)).toThrow(/not found/u);
  });

  it("deletes anyway and says why when the proposal fails", async () => {
    const { app, id, http } = setup({
      offerProposal: async () => true,
      propose: async () => { throw new Error("No operation has been checked yet."); },
    });

    const { submit } = await open(app, http, id);
    const deleted = await submit([["propose", "yes"]]);

    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain("The connection is deleted, but the adapter was not offered to the catalog.");
    expect(deleted.body).toContain("No operation has been checked yet.");
    expect(() => app.connections.getConnection(id)).toThrow(/not found/u);
  });

  it("shows the host's reason as text, never as markup", async () => {
    const { app, id, http } = setup({
      offerProposal: async () => true,
      propose: async () => { throw new Error("<script>alert(1)</script> & more"); },
    });

    const { submit } = await open(app, http, id);
    const deleted = await submit([["propose", "yes"]]);

    expect(deleted.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
    expect(deleted.body).not.toContain("<script>alert(1)");
  });

  it("shows no box and ignores a forged one when the host does not offer it", async () => {
    const events: string[] = [];
    const { app, id, http } = setup({ offerProposal: async () => false, propose: async () => { events.push("propose"); } });

    const { page, submit } = await open(app, http, id);
    expect(page.body).not.toContain('name="propose"');
    await submit([["propose", "yes"]]);

    expect(events).toEqual([]);
  });

  it("still lets the person delete when the host cannot tell whether to offer", async () => {
    const { app, id, http } = setup({
      offerProposal: async () => { throw new Error("database is locked"); },
      propose: async () => {},
    });

    const { page, submit } = await open(app, http, id);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain('name="propose"');
    const deleted = await submit([["propose", "yes"]]);

    expect(deleted.statusCode).toBe(200);
    expect(() => app.connections.getConnection(id)).toThrow(/not found/u);
  });

  describe("a note and a success line from the host", () => {
    const notes = (body: string) => /<label class="confirm">.*?<\/label>(.*?)<button/su.exec(body)?.[1] ?? null;

    it("shows the host's note right under the box, built for the connection and the page's language", async () => {
      const seen: string[] = [];
      const { app, id, http } = setup({
        locale: () => "ru",
        offerProposal: async () => true,
        propose: async () => {},
        proposalNote: async (target, connectionId, locale) => {
          seen.push(`${target.connections.getConnection(connectionId).label}:${locale}`);
          return '<p class="muted">Terms <a href="/terms">here</a></p>';
        },
      });

      const { page } = await open(app, http, id);

      expect(notes(page.body)).toBe('<p class="muted">Terms <a href="/terms">here</a></p>');
      expect(page.body.indexOf('name="propose"')).toBeLessThan(page.body.indexOf("Terms"));
      expect(seen).toEqual(["Shop:ru"]);
    });

    it("shows no note, and does not ask for one, when the box is not offered", async () => {
      const asked: string[] = [];
      const { app, id, http } = setup({
        offerProposal: async () => false,
        propose: async () => {},
        proposalNote: async () => { asked.push("note"); return "<p>Terms</p>"; },
      });

      const { page } = await open(app, http, id);

      expect(page.body).not.toContain('name="propose"');
      expect(page.body).not.toContain("Terms");
      expect(asked).toEqual([]);
    });

    it.each([
      ["throws", async () => { throw new Error("no adapter"); }],
      ["returns null", async () => null],
    ])("still renders the page, box included, without a note when the hook %s", async (_case, proposalNote) => {
      const { app, id, http } = setup({ offerProposal: async () => true, propose: async () => {}, proposalNote });

      const { page, submit } = await open(app, http, id);

      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('name="propose" value="yes"');
      expect(notes(page.body)).toBe("");
      expect((await submit([["propose", "yes"]])).statusCode).toBe(200);
    });

    it("shows the success line the proposal returns as text, after the lede", async () => {
      const { app, id, http } = setup({ offerProposal: async () => true, propose: async () => "Sent for <b>review</b> & more." });

      const { submit } = await open(app, http, id);
      const deleted = await submit([["propose", "yes"]]);

      expect(deleted.statusCode).toBe(200);
      expect(deleted.body).toContain('<p class="lede">Its keys are erased. Return to your AI assistant.</p><p>Sent for &lt;b&gt;review&lt;/b&gt; &amp; more.</p>');
      expect(deleted.body).not.toContain("<b>review");
      expect(deleted.body).not.toContain("the adapter was not offered to the catalog");
      expect(() => app.connections.getConnection(id)).toThrow(/not found/u);
    });

    it("keeps the old page when the proposal returns nothing", async () => {
      const { app, id, http } = setup({ offerProposal: async () => true, propose: async () => {} });
      const otherId = addConnection(app, "Other shop");
      const ticked = await open(app, http, id);
      const empty = await open(app, http, otherId);

      const offered = await ticked.submit([["propose", "yes"]]);
      const notOffered = await empty.submit([]);

      expect(offered.statusCode).toBe(200);
      expect(offered.body).toBe(notOffered.body);
    });

    it("shows no line when the box stays empty", async () => {
      const proposals: string[] = [];
      const { app, id, http } = setup({
        offerProposal: async () => true,
        propose: async () => { proposals.push("propose"); return "Sent."; },
      });

      const { submit } = await open(app, http, id);
      const deleted = await submit([]);

      expect(deleted.body).not.toContain("Sent.");
      expect(proposals).toEqual([]);
    });
  });

  it("hands the proposal the page's language, the same one the note gets", async () => {
    const seen: string[] = [];
    const { app, id, http } = setup({
      locale: () => "ru",
      offerProposal: async () => true,
      proposalNote: async (_app, _connectionId, locale) => { seen.push(`note:${locale}`); return null; },
      propose: async (_app, _connectionId, locale) => { seen.push(`propose:${locale}`); },
    });

    const { submit } = await open(app, http, id);
    await submit([["propose", "yes"]]);

    expect(seen).toEqual(["note:ru", "propose:ru"]);
  });

  it("offers it in Russian on a Russian page", async () => {
    const { app, id, http } = setup({ locale: () => "ru", offerProposal: async () => true, propose: async () => {} });

    const { page } = await open(app, http, id);

    expect(page.body).toContain("Предложить адаптер в общий каталог");
  });
});
