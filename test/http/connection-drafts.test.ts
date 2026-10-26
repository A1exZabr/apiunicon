import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cookieHeader, form, LOCAL, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 6),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

describe("zero-knowledge connection wizard", () => {
  let application: Application;

  beforeEach(() => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Fixture Orders API" },
        servers: [{ url: "https://api.example.test/v1" }],
        components: {
          securitySchemes: {
            apiKey: { type: "apiKey", in: "header", name: "Api-Key" },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
  });

  afterEach(() => application.db.close());

  it("completes the primary web path while asking only for a docs URL and secret values", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const dashboard = await server.inject({ method: "GET", url: "/", headers: { ...LOCAL, cookie: session.cookies } });
    expect(dashboard.body).toContain("Connect an API");
    expect(dashboard.body).not.toContain("Allowed API origin");
    expect(dashboard.body).not.toContain('name="allowedOrigin[]"');

    const start = await server.inject({
      method: "GET",
      url: "/connections/new",
      headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(start.body).toContain('name="documentationUrl"');
    expect(start.body).toContain("Advanced setup");
    expect(start.body).not.toContain('name="label"');
    expect(start.body).not.toContain('name="credentialName');

    const rejected = await server.inject({
      method: "POST",
      url: "/connection-drafts",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["documentationUrl", "https://docs.example.test/openapi.json"]]),
    });
    expect(rejected.statusCode).toBe(403);

    const created = await server.inject({
      method: "POST",
      url: "/connection-drafts",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf],
        ["documentationUrl", "https://docs.example.test/openapi.json"],
      ]),
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toMatch(/^\/connection-drafts\/[0-9a-f-]+$/u);
    const draftId = created.headers.location!.split("/").at(-1)!;
    const discovering = await server.inject({
      method: "GET", url: created.headers.location!, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(discovering.body).toContain("Reading documentation");
    expect(discovering.body).toContain("Finding the API");
    expect(discovering.body).toContain("Finding required keys");
    expect(discovering.body).toContain("Ready to review");
    const clientScript = await server.inject({
      method: "GET", url: "/assets/app.js", headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(clientScript.body).toContain("'discovering'");

    await application.jobRunner.runOne();
    const status = await server.inject({
      method: "GET", url: `/api/connection-drafts/${draftId}/status`, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(status.json()).toEqual(expect.objectContaining({ status: "needs_review" }));
    expect(JSON.stringify(status.json())).not.toContain("openapi.json");
    const draft = application.drafts.get(draftId);
    const review = await server.inject({
      method: "GET", url: created.headers.location!, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(review.body).toContain("api.example.test");
    expect(review.body).toContain("Continue securely");

    const selected = await server.inject({
      method: "POST",
      url: `/connection-drafts/${draftId}/select`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf],
        ["originId", draft.discovery.origins[0]!.id],
        ["credentialId", draft.discovery.credentials[0]!.id],
        ["allowedOrigin", "https://evil.example.test"],
      ]),
    });
    expect(selected.statusCode).toBe(303);
    expect(application.drafts.get(draftId).selectedOrigins).toEqual(["https://api.example.test"]);

    const credentials = await server.inject({
      method: "GET", url: created.headers.location!, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(credentials.body).toContain("API key");
    expect(credentials.body).toContain("Api-Key");
    expect(credentials.body).toContain("Save keys and connect");
    expect(credentials.body).not.toContain('name="credentialName');

    const secret = "wizard-secret-value";
    const completed = await server.inject({
      method: "POST",
      url: `/connection-drafts/${draftId}/complete`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf],
        [`credentialValue:${draft.discovery.credentials[0]!.id}`, secret],
      ]),
    });
    expect(completed.statusCode).toBe(303);
    expect(completed.headers.location).toMatch(/^\/connections\/[0-9a-f-]+$/u);
    expect(completed.body).not.toContain(secret);
    expect(JSON.stringify(application.drafts.get(draftId))).not.toContain(secret);
    await server.close();
  });

  it("explains empty and OAuth discovery without rendering secret fields", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const empty = application.discovery.begin("https://docs.example.test/empty");
    application.drafts.recordDiscovery(empty.id, {
      serviceName: null,
      suggestedLabel: null,
      origins: [],
      credentials: [],
      unsupportedAuthMethods: [],
    });
    const emptyPage = await server.inject({
      method: "GET", url: `/connection-drafts/${empty.id}`, headers: { ...LOCAL, cookie: session.cookies },
    });
    // An empty discovery is classified documentation_unavailable, so it gets the assistant hint and not the contradictory sentence.
    expect(emptyPage.body).toContain("This documentation can’t be read automatically.");
    expect(emptyPage.body).not.toContain("We read the documentation");

    const oauth = application.discovery.begin("https://docs.example.test/oauth");
    application.drafts.recordDiscovery(oauth.id, {
      serviceName: "OAuth API",
      suggestedLabel: "OAuth",
      origins: [],
      credentials: [],
      unsupportedAuthMethods: ["OAuth 2.0"],
    });
    const oauthPage = await server.inject({
      method: "GET", url: `/connection-drafts/${oauth.id}`, headers: { ...LOCAL, cookie: session.cookies },
    });
    expect(oauthPage.body).toContain("This API uses OAuth, which this version cannot connect yet");
    expect(oauthPage.body).not.toContain('type="password"');
    await server.close();
  });

  it("tells the person to continue in their AI assistant when documentation is blocked", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const draft = application.discovery.begin("https://dev.wildberries.ru/docs/openapi/api-information");
    application.drafts.markDocumentationUnavailable(draft.id);
    const page = await server.inject({ method: "GET", url: `/connection-drafts/${draft.id}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(page.body).toContain("· APIUniCon</title>");
    expect(page.body).toContain('<a class="brand" href="/">APIUniCon</a>');
    expect(page.body).toContain("<pre>Connect this API with APIUniCon: https://dev.wildberries.ru/docs/openapi/api-information</pre>");
    expect(page.body).toContain("<code>/mcp__apiunicon__connect https://dev.wildberries.ru/docs/openapi/api-information</code>");
    expect(page.body.indexOf("Connect this API with APIUniCon")).toBeLessThan(page.body.indexOf("/mcp__apiunicon__connect"));
    expect(page.body).toContain("This documentation can’t be read automatically.");
    expect(page.body).toContain("Your AI assistant can find the official files and finish the setup.");
    expect(page.body).not.toContain("We need one technical detail.");
    expect(page.body).not.toContain("We read the documentation");
    expect(page.body).toContain("Try reading again");
    expect(page.body).toContain("Advanced setup");
    const status = await server.inject({ method: "GET", url: `/api/connection-drafts/${draft.id}/status`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(status.json()).toMatchObject({ status: "needs_help", helpReason: "documentation_unavailable" });
    await server.close();
  });

  it("keeps the assistant command off pages blocked by unsupported auth", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const oauth = application.discovery.begin("https://docs.example.test/oauth-only");
    application.drafts.recordDiscovery(oauth.id, {
      serviceName: "OAuth API",
      suggestedLabel: "OAuth",
      origins: [],
      credentials: [],
      unsupportedAuthMethods: ["OAuth 2.0"],
    });
    const page = await server.inject({ method: "GET", url: `/connection-drafts/${oauth.id}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(page.body).toContain("This API uses OAuth, which this version cannot connect yet");
    expect(page.body).not.toContain("mcp__apiunicon__connect");
    expect(page.body).not.toContain("Connect this API with APIUniCon");
    await server.close();
  });

  it("does not call OAuth a blocker when a supported key was found and only destinations are missing", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const draft = application.discovery.begin("https://docs.example.test/oauth-and-key");
    application.drafts.recordDiscovery(draft.id, {
      serviceName: "Mixed API",
      suggestedLabel: "Mixed",
      origins: [],
      credentials: [{
        id: "credential-api-key",
        fieldName: "Api-Key",
        kind: "api_key",
        placement: "header",
        humanLabel: "API key",
        confidence: "high",
        evidence: [{ pageUrl: "https://docs.example.test/oauth-and-key", kind: "openapi_security" }],
      }],
      unsupportedAuthMethods: ["OAuth 2.0"],
    });
    const page = await server.inject({ method: "GET", url: `/connection-drafts/${draft.id}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(page.body).toContain("This documentation can’t be read automatically.");
    expect(page.body).not.toContain("cannot connect yet");
    await server.close();
  });

  it("escapes query characters in the link shown in the assistant command", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const draft = application.discovery.begin("https://dev.wildberries.ru/docs/openapi/api-information?a=1&b=2");
    application.drafts.markDocumentationUnavailable(draft.id);
    const page = await server.inject({ method: "GET", url: `/connection-drafts/${draft.id}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(page.body).toContain("Connect this API with APIUniCon: https://dev.wildberries.ru/docs/openapi/api-information?a=1&amp;b=2");
    expect(page.body).toContain("/mcp__apiunicon__connect https://dev.wildberries.ru/docs/openapi/api-information?a=1&amp;b=2");
    expect(page.body).not.toContain("api-information?a=1&b=2");
    await server.close();
  });

  it("answers a mistake in the form with 400 and what to change, and nothing is created", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const post = (url: string, fields: Array<[string, string]>) => server.inject({
      method: "POST",
      url,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ...fields]),
    });

    for (const [link, message] of [
      ["http://docs.example.test/openapi.json", "Documentation URL must use HTTPS and contain no credentials"],
      ["https://user:pass@docs.example.test/", "Documentation URL must use HTTPS and contain no credentials"],
      ["docs.example.test", "Documentation URL must be a full address, such as https://docs.example.com/api"],
    ] as const) {
      const refused = await post("/connection-drafts", [["documentationUrl", link]]);
      expect([refused.statusCode, refused.body], link).toEqual([400, message]);
    }
    expect(application.connections.listConnections()).toEqual([]);
    expect(application.db.prepare("select count(*) as count from connection_drafts").get()).toEqual({ count: 0 });

    // The advanced form of a draft that needs help: an address the person typed is checked the same way.
    const source = application.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    const draft = application.drafts.recordDiscovery(application.drafts.create({ documentationSourceId: source.id }).id, {
      serviceName: null, suggestedLabel: null, origins: [], credentials: [], unsupportedAuthMethods: [],
    });
    const advanced = (origin: string, credentialName = "Api-Key") =>
      post(`/connection-drafts/${draft.id}/select`, [["mode", "advanced"], ["origin", origin], ["credentialName", credentialName]]);
    for (const [origin, message] of [
      ["http://api.shop.test", "API origin must use HTTPS"],
      ["https://10.0.0.7", "API origin cannot use a private or reserved address"],
      ["https://api.shop.test/v1", "API origin cannot contain a path, query, or fragment"],
      ["api.shop.test", "API origin must be a full address, such as https://api.example.com"],
    ] as const) {
      const refused = await advanced(origin);
      expect([refused.statusCode, refused.body], origin).toEqual([400, message]);
    }
    const badName = await advanced("https://api.shop.test", "Api Key");
    expect([badName.statusCode, badName.body]).toEqual([400, "Enter 1 to 20 credential header names, each of letters, digits and hyphens only"]);
    expect(application.drafts.get(draft.id).status).toBe("needs_help");
    expect((await advanced("https://api.shop.test")).statusCode).toBe(303);
    expect(application.drafts.get(draft.id)).toMatchObject({ status: "ready", selectedOrigins: ["https://api.shop.test"] });
    await server.close();
  });

  it("leaves an address on another domain unselected, as the key-entry page does, and asks again when none is chosen", async () => {
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const headers = { ...LOCAL, cookie: session.cookies };
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    const evidence = [{ pageUrl: "https://docs.shop.test/api", kind: "openapi_server" as const }];
    const created = application.drafts.create({ documentationSourceId: source.id });
    const draft = application.drafts.recordDiscovery(created.id, {
      serviceName: "Shop",
      suggestedLabel: "Shop",
      origins: [
        { id: "origin-own", origin: "https://api.shop.test", serviceLabel: null, confidence: "high", evidence, observationCount: 1 },
        { id: "origin-other", origin: "https://payments.other.test", serviceLabel: "Payments", confidence: "high", evidence, observationCount: 1 },
      ],
      credentials: [{ id: "credential-key", fieldName: "Api-Key", kind: "api_key", placement: "header", humanLabel: "API key", confidence: "high", evidence }],
      unsupportedAuthMethods: [],
    });
    const choice = (body: string, id: string) => new RegExp(`name="originId" value="${id}"( checked)?>`, "u").exec(body)?.[1] === " checked";

    const review = await server.inject({ method: "GET", url: `/connection-drafts/${draft.id}`, headers });
    expect(review.statusCode).toBe(200);
    expect(choice(review.body, "origin-own")).toBe(true);
    expect(choice(review.body, "origin-other")).toBe(false);
    expect(review.body).toContain("payments.other.test");

    // The one-time key-entry page draws the same step the same way.
    const { token } = application.links.issue(draft.id);
    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: LOCAL });
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { ...LOCAL, cookie: cookieHeader(opened) } });
    const choices = (body: string) => /<div class="choices">(.*?)<\/div>/su.exec(body)?.[1];
    expect(choices(page.body)).toBe(choices(review.body));

    // Sent with nothing ticked, the review comes back asking for a destination, and nothing is selected.
    const empty = await server.inject({
      method: "POST",
      url: `/connection-drafts/${draft.id}/select`,
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["credentialId", "credential-key"]]),
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain("Select at least one API destination.");
    expect(application.drafts.get(draft.id).status).toBe("needs_review");
    await server.close();
  });
});
