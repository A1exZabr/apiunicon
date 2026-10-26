import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { cookieHeader, form, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 12),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";
const SECRET = "wb-connect-page-secret";

describe("key-entry page", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function proposedDraft(app: Application) {
    const draft = app.discovery.start(LINK);
    app.drafts.markDocumentationUnavailable(draft.id);
    return app.discovery.proposeSettings(draft.id, {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru", "https://content-api.wildberries.ru"],
      credentials: [{ fieldName: "Authorization", kind: "api_key", humanLabel: "API token" }],
      rationale: "test",
    });
  }

  it("moves the token into a scoped cookie, shows provenance, and completes once", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const draft = proposedDraft(application);
    const { token } = application.links.issue(draft.id);

    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: { host: "127.0.0.1:3210" } });
    expect(opened.statusCode).toBe(303);
    expect(opened.headers.location).toBe(`/connect/${draft.id}`);
    expect(String(opened.headers["set-cookie"])).toContain(`Path=/connect/${draft.id}`);
    const cookies = cookieHeader(opened);

    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { host: "127.0.0.1:3210", cookie: cookies } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("common-api.wildberries.ru");
    expect(page.body).toContain("proposed by your AI assistant without documentation");
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const originIds = [...page.body.matchAll(/name="originId" value="([^"]+)"/gu)].map((match) => match[1]!);
    const credentialId = /name="credentialValue:([^"]+)"/u.exec(page.body)?.[1] ?? "";
    expect(page.body).toContain(`name="credentialId" value="${credentialId}"`);

    const completed = await server.inject({
      method: "POST",
      url: `/connect/${draft.id}/complete`,
      headers: { host: "127.0.0.1:3210", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", csrf],
        ...originIds.map((id): [string, string] => ["originId", id]),
        ["credentialId", credentialId],
        [`credentialValue:${credentialId}`, SECRET],
      ]),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.body).toContain("Return to your AI assistant");
    expect(application.drafts.get(draft.id).status).toBe("completed");
    expect(findKeyFragment(application.db, SECRET)).toEqual([]);

    // The connection exists now, so a link to its key-entry page would replace its keys, which needs the sign-in; signed
    // in, the spent link still opens nothing.
    const link = `/connect/${draft.id}?t=${token}`;
    const reused = await server.inject({ method: "GET", url: link, headers: { host: "127.0.0.1:3210" } });
    expect(reused.statusCode).toBe(303);
    expect(reused.headers.location).toBe(`/login?next=${encodeURIComponent(link)}`);
    const session = await setupAdmin(server, application);
    const signedIn = await server.inject({ method: "GET", url: link, headers: { host: "127.0.0.1:3210", cookie: session.cookies } });
    expect(signedIn.statusCode).toBe(403);
    await server.close();
  });

  it("shows a destination's non-default port", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const started = application.discovery.start(LINK);
    application.drafts.markDocumentationUnavailable(started.id);
    const draft = application.discovery.proposeSettings(started.id, {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru:8443"],
      credentials: [{ fieldName: "Authorization", kind: "api_key", humanLabel: "API token" }],
      rationale: "test",
    });
    const { token } = application.links.issue(draft.id);
    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: { host: "127.0.0.1:3210" } });
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { host: "127.0.0.1:3210", cookie: cookieHeader(opened) } });
    expect(page.body).toContain("common-api.wildberries.ru:8443");
    await server.close();
  });

  it("rejects wrong CSRF, foreign hosts, and unknown tokens without needing an admin session", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const draft = proposedDraft(application);
    const { token } = application.links.issue(draft.id);

    expect((await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: { host: "attacker.example" } })).statusCode).toBe(421);
    expect((await server.inject({ method: "GET", url: `/connect/${draft.id}?t=wrong`, headers: { host: "127.0.0.1:3210" } })).statusCode).toBe(403);
    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: { host: "127.0.0.1:3210" } });
    const rejected = await server.inject({
      method: "POST",
      url: `/connect/${draft.id}/complete`,
      headers: { host: "127.0.0.1:3210", cookie: cookieHeader(opened), "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", "forged"], ["credentialValue:x", SECRET]]),
    });
    expect(rejected.statusCode).toBe(403);
    expect(application.drafts.get(draft.id).status).toBe("needs_review");
    await server.close();
  });

  it("issues a scoped HttpOnly cookie that a link clicked from another site still carries", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const draft = proposedDraft(application);
    const { token } = application.links.issue(draft.id);

    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers: { host: "127.0.0.1:3210" } });
    const attributes = String(opened.headers["set-cookie"]).split(/;\s*/u);
    expect(attributes).toEqual(expect.arrayContaining([`Path=/connect/${draft.id}`, "HttpOnly", "Max-Age=1800"]));
    expect(attributes.some((attribute) => attribute.startsWith("Domain="))).toBe(false);
    // Strict would drop the cookie on the redirect that follows a click from a web chat (a cross-site navigation),
    // which shows "This link has expired" for a token that is still valid. Lax is not sent on cross-site POSTs.
    expect(attributes).toContain("SameSite=Lax");
    await server.close();
  });

  it("keeps the link usable after a failed completion and never echoes the pasted value", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const draft = proposedDraft(application);
    const { token } = application.links.issue(draft.id);
    const headers = { host: "127.0.0.1:3210", "content-type": "application/x-www-form-urlencoded" };
    const cookies = cookieHeader(await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers }));
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { host: headers.host, cookie: cookies } });
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const originIds = [...page.body.matchAll(/name="originId" value="([^"]+)"/gu)].map((match) => match[1]!);
    const credentialId = /name="credentialValue:([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const submit = (entries: Array<[string, string]>) => server.inject({
      method: "POST", url: `/connect/${draft.id}/complete`, headers: { ...headers, cookie: cookies }, payload: form(entries),
    });
    const origins = originIds.map((id): [string, string] => ["originId", id]);

    const failed = await submit([["csrf", csrf], ...origins, ["credentialId", credentialId], ["credentialValue:not-selected", SECRET]]);
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain(SECRET);
    expect(failed.body).toContain("The keys could not be saved.");
    expect(failed.body).toContain(`name="credentialValue:${credentialId}"`);

    const withoutDestination = await submit([["csrf", csrf], ["credentialId", credentialId], [`credentialValue:${credentialId}`, SECRET]]);
    expect(withoutDestination.statusCode).toBe(400);
    expect(withoutDestination.body).toContain("Select at least one API destination");
    expect(withoutDestination.body).not.toContain("The keys could not be saved.");
    expect(withoutDestination.body).not.toContain(SECRET);
    expect(application.links.verify(draft.id, token)).toBe(true);
    expect(application.drafts.get(draft.id).status).toBe("needs_review");
    expect(application.links.verify(draft.id, token)).toBe(true);

    const completed = await submit([["csrf", csrf], ...origins, ["credentialId", credentialId], [`credentialValue:${credentialId}`, SECRET]]);
    expect(completed.statusCode).toBe(200);
    expect(completed.body).not.toContain(SECRET);
    expect(String(completed.headers["set-cookie"])).toContain("Max-Age=0");
    expect(application.links.verify(draft.id, token)).toBe(false);
    await server.close();
  });

  it("offers a choice when several keys were found and shows no administrator controls", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const started = application.discovery.start(LINK);
    application.drafts.markDocumentationUnavailable(started.id);
    const draft = application.discovery.proposeSettings(started.id, {
      serviceName: "Wildberries",
      origins: ["https://common-api.wildberries.ru"],
      credentials: [
        { fieldName: "Authorization", kind: "api_key", humanLabel: "API token" },
        { fieldName: "X-Seller-Id", kind: "api_key", humanLabel: "Seller id" },
      ],
      rationale: "test",
    });
    const { token } = application.links.issue(draft.id);
    const headers = { host: "127.0.0.1:3210" };
    const cookies = cookieHeader(await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers }));

    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { ...headers, cookie: cookies } });
    expect(page.statusCode).toBe(200);
    expect(page.body.match(/type="checkbox" name="credentialId"/gu)).toHaveLength(2);
    expect(page.body).not.toContain('type="hidden" name="credentialId"');
    expect(page.body).not.toContain("/logout");
    expect(page.body).not.toContain(token);
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const [firstId] = [...page.body.matchAll(/name="credentialId" value="([^"]+)"/gu)].map((match) => match[1]!);
    const [originId] = [...page.body.matchAll(/name="originId" value="([^"]+)"/gu)].map((match) => match[1]!);

    const completed = await server.inject({
      method: "POST",
      url: `/connect/${draft.id}/complete`,
      headers: { ...headers, cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["originId", originId!], ["credentialId", firstId!], [`credentialValue:${firstId}`, SECRET]]),
    });
    expect(completed.statusCode).toBe(200);
    expect(application.drafts.get(draft.id).selectedCredentials).toHaveLength(1);
    await server.close();
  });

  it("binds a link to its own draft and refuses drafts that are not waiting for keys", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("x") });
    const server = buildHttpServer(application);
    const ready = proposedDraft(application);
    const waiting = application.discovery.start("https://docs.other.test/api");
    application.drafts.markDocumentationUnavailable(waiting.id);
    const readyLink = application.links.issue(ready.id);
    const waitingLink = application.links.issue(waiting.id);
    const headers = { host: "127.0.0.1:3210" };

    expect((await server.inject({ method: "GET", url: `/connect/${waiting.id}?t=${readyLink.token}`, headers })).statusCode).toBe(403);
    const readyCookies = cookieHeader(await server.inject({ method: "GET", url: `/connect/${ready.id}?t=${readyLink.token}`, headers }));
    expect((await server.inject({ method: "GET", url: `/connect/${waiting.id}`, headers: { ...headers, cookie: readyCookies } })).statusCode).toBe(403);

    const waitingCookies = cookieHeader(await server.inject({ method: "GET", url: `/connect/${waiting.id}?t=${waitingLink.token}`, headers }));
    const notReady = await server.inject({ method: "GET", url: `/connect/${waiting.id}`, headers: { ...headers, cookie: waitingCookies } });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.body).toContain("Return to your AI assistant");
    await server.close();
  });
});
