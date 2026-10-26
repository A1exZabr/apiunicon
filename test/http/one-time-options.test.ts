import Fastify from "fastify";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { registerConnectRoutes } from "../../src/http/connect-page.js";
import { decodeUrlEncoded } from "../../src/http/forms.js";
import { escapeHtml } from "../../src/http/layout.js";
import { linkFormToken, localOneTimePageOptions, type OneTimePageOptions } from "../../src/http/one-time.js";
import { buildApplication, type Application } from "../../src/index.js";
import { cookieHeader, form } from "./helpers.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 21),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";

describe("one-time pages served by another host", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function waitingDraft(app: Application) {
    const draft = app.discovery.start(LINK);
    app.drafts.markDocumentationUnavailable(draft.id);
    return app.discovery.proposeSettings(draft.id, {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru"],
      credentials: [{ fieldName: "Authorization", kind: "api_key", humanLabel: "API token" }],
      rationale: "test",
    });
  }

  // The host parses forms itself, as the local server does.
  function serve(options: OneTimePageOptions) {
    const server = Fastify();
    server.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
      done(null, decodeUrlEncoded(typeof body === "string" ? body : body.toString("utf8")));
    });
    registerConnectRoutes(server, options);
    return server;
  }

  // A host's own page frame, as a hosted service would supply it: Russian, HTTPS-only cookies.
  function cloudOptions(app: Application): OneTimePageOptions {
    return {
      ...localOneTimePageOptions(app),
      locale: () => "ru",
      render: (_request, title, body) => `<html><title>${escapeHtml(title)}</title><body data-host="cloud">${body}</body></html>`,
      secureCookies: true,
    };
  }

  it("derives the form token from the link token and its purpose", () => {
    const token = "a".repeat(43);
    expect(linkFormToken("connect", token)).toBe(createHash("sha256").update(`connect-csrf:${token}`).digest("base64url"));
    expect(linkFormToken("delete", token)).not.toBe(linkFormToken("connect", token));
  });

  it("answers 404 when the host finds no application for the request, leaving the link usable", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const draft = waitingDraft(application);
    const { token } = application.links.issue(draft.id);
    const server = serve({ ...localOneTimePageOptions(application), resolveApplication: async () => null });

    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}` });

    expect(page.statusCode).toBe(404);
    expect(page.body).toContain("Link not found");
    expect(application.links.verify(draft.id, token)).toBe(true);
    await server.close();
  });

  it("renders in Russian inside the host's own page and marks the link cookie Secure", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const draft = waitingDraft(application);
    const { token } = application.links.issue(draft.id);
    const server = serve(cloudOptions(application));

    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}` });
    expect(String(opened.headers["set-cookie"])).toContain("; Secure");
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { cookie: cookieHeader(opened) } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('data-host="cloud"');
    expect(page.body).toContain("Ввод ключей");
    expect(page.body).toContain("Сохранить ключи и подключить");
    expect(page.body).toContain("Эти настройки предложил ваш ИИ-ассистент без документации");
    expect(page.body).not.toContain("Save keys and connect");
    await server.close();
  });

  it("answers 404 to a form sent where the host finds no application, leaving the link usable", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const draft = waitingDraft(application);
    const { token } = application.links.issue(draft.id);
    const server = serve({ ...cloudOptions(application), resolveApplication: async () => null });

    const sent = await server.inject({
      method: "POST", url: `/connect/${draft.id}/complete`,
      headers: { cookie: `apiunicon_connect=${token}`, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", linkFormToken("connect", token)]]),
    });

    expect(sent.statusCode).toBe(404);
    expect(sent.body).toContain("Ссылка не найдена");
    expect(application.links.verify(draft.id, token)).toBe(true);
    await server.close();
  });

  it("finishes in Russian and clears the link cookie with Secure", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const draft = waitingDraft(application);
    const { token } = application.links.issue(draft.id);
    const server = serve(cloudOptions(application));
    const cookie = cookieHeader(await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}` }));
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { cookie } });
    const originIds = [...page.body.matchAll(/name="originId" value="([^"]+)"/gu)].map((match) => match[1]!);
    const credentialId = /name="credentialValue:([^"]+)"/u.exec(page.body)?.[1] ?? "";

    const done = await server.inject({
      method: "POST", url: `/connect/${draft.id}/complete`,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", linkFormToken("connect", token)],
        ...originIds.map((id): [string, string] => ["originId", id]),
        ["credentialId", credentialId],
        [`credentialValue:${credentialId}`, "wb-token-value"],
      ]),
    });

    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('data-host="cloud"');
    expect(done.body).toContain("<title>Подключено</title>");
    expect(done.body).toContain("Ключи зашифрованы и сохранены");
    const cleared = String(done.headers["set-cookie"]);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("; Secure");
    await server.close();
  });
});
