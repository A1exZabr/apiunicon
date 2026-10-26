import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { cookieHeader, form, setupAdmin, setupTokenPath } from "./helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 25),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [{ id: "list_orders", description: "List orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
};

describe("deleting a connection from the chat", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function connection(app: Application) {
    const source = app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    app.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    return app.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "credentials-1",
    });
  }

  // The page opens only for the person signed in on this computer: the link alone, which the assistant holds, deletes
  // nothing. The headers of the signed-in browser on this computer.
  async function signedIn(app: Application, server: ReturnType<typeof buildHttpServer>) {
    const session = (await setupAdmin(server, app)).cookies;
    return (cookie = "") => ({ host: "127.0.0.1:3210", cookie: [session, cookie].filter(Boolean).join("; ") });
  }

  it("deletes only after the person confirms on the one-time page", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const server = buildHttpServer(application);
    const local = await signedIn(application, server);
    const { id } = connection(application);
    const tools = createToolHandlers(application.mcpDependencies);

    const requested = await tools.delete_connection({ connectionId: id });
    expect(requested.confirmation.url.startsWith(`http://127.0.0.1:3210/confirm/delete/${id}?t=`)).toBe(true);
    expect(requested.nextStep).toContain(requested.confirmation.url);
    expect(application.connections.getConnection(id).id).toBe(id);

    const { pathname, search } = new URL(requested.confirmation.url);
    const headers = local();
    expect((await server.inject({ method: "GET", url: `${pathname}${search}`, headers: { host: "attacker.example" } })).statusCode).toBe(421);
    const opened = await server.inject({ method: "GET", url: `${pathname}${search}`, headers });
    expect(opened.statusCode).toBe(303);
    const cookie = cookieHeader(opened);
    // Without the sign-in, neither the link nor the page behind its cookie opens: both lead to the sign-in and back.
    const toSignIn = (next: string) => `/login?next=${encodeURIComponent(next)}`;
    const anonymous = { host: "127.0.0.1:3210" };
    const viaLink = await server.inject({ method: "GET", url: `${pathname}${search}`, headers: anonymous });
    expect([viaLink.statusCode, viaLink.headers.location]).toEqual([303, toSignIn(`${pathname}${search}`)]);
    const viaCookie = await server.inject({ method: "GET", url: pathname, headers: { ...anonymous, cookie } });
    expect([viaCookie.statusCode, viaCookie.headers.location]).toEqual([303, toSignIn(pathname)]);
    const page = await server.inject({ method: "GET", url: pathname, headers: local(cookie) });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Delete “Shop”?");
    expect(page.body).toContain("The connection and its keys will be erased, and requests to api.shop.test will stop.");
    expect(page.body).not.toContain("adapter");
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const submit = (token: string, signed = true) => server.inject({
      method: "POST", url: pathname,
      headers: { ...(signed ? local(cookie) : { ...anonymous, cookie }), "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", token]]),
    });

    expect((await submit("forged")).statusCode).toBe(403);
    // The link's cookie and its form token alone, as the assistant could send them, go to the sign-in.
    const unsigned = await submit(csrf, false);
    expect([unsigned.statusCode, unsigned.headers.location]).toEqual([303, toSignIn(pathname)]);
    expect(application.connections.getConnection(id).id).toBe(id);
    const deleted = await submit(csrf);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toContain("Connection deleted");
    expect(() => application!.connections.getConnection(id)).toThrow(/not found/u);
    expect((await server.inject({ method: "GET", url: `${pathname}${search}`, headers })).statusCode).toBe(403);
    await server.close();
  });

  async function confirmPage(app: Application, server: ReturnType<typeof buildHttpServer>, connectionId: string): Promise<string> {
    const local = await signedIn(app, server);
    const requested = await createToolHandlers(app.mcpDependencies).delete_connection({ connectionId });
    const { pathname, search } = new URL(requested.confirmation.url);
    const opened = await server.inject({ method: "GET", url: `${pathname}${search}`, headers: local() });
    const page = await server.inject({ method: "GET", url: pathname, headers: local(cookieHeader(opened)) });
    expect(page.statusCode).toBe(200);
    return page.body;
  }

  function withAdapter(app: Application, connectionId: string, reusable: boolean): void {
    const { documentationSourceId } = app.connections.getConnection(connectionId);
    const adapter = app.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId, dsl });
    if (reusable) app.adapters.markReusable(adapter.id, app.adapters.markWorking(adapter.id, adapter.version).version);
    app.connections.bindAdapter(connectionId, adapter.id);
  }

  it("escapes the label and says the private adapter goes with the connection", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const server = buildHttpServer(application);
    const { id } = connection(application);
    application.connections.rename(id, "<script>x</script>");
    withAdapter(application, id, false);

    const body = await confirmPage(application, server, id);

    expect(body).toContain("Delete “&lt;script&gt;x&lt;/script&gt;”?");
    expect(body).not.toContain("<script>x</script>");
    expect(body).toContain("The connection, its keys, and its adapter will be erased, and requests to api.shop.test will stop. Connecting this service again builds a new adapter.");
    await server.close();
  });

  it("says a shared adapter stays", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const server = buildHttpServer(application);
    const { id } = connection(application);
    withAdapter(application, id, true);

    const body = await confirmPage(application, server, id);

    expect(body).toContain("The connection and its keys will be erased, and requests to api.shop.test will stop. The shared adapter stays.");
    await server.close();
  });

  it("shows a plain error and keeps the link when the deletion fails", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const server = buildHttpServer(application);
    const local = await signedIn(application, server);
    const { id } = connection(application);
    const requested = await createToolHandlers(application.mcpDependencies).delete_connection({ connectionId: id });
    const { pathname, search } = new URL(requested.confirmation.url);
    const cookie = cookieHeader(await server.inject({ method: "GET", url: `${pathname}${search}`, headers: local() }));
    const page = await server.inject({ method: "GET", url: pathname, headers: local(cookie) });
    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const submit = () => server.inject({
      method: "POST", url: pathname,
      headers: { ...local(cookie), "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf]]),
    });
    const failing = vi.spyOn(application.connections, "delete").mockImplementation(() => {
      throw new Error("SQLITE_IOERR: /private/state/db.sqlite");
    });

    const failed = await submit();

    expect(failed.statusCode).toBe(500);
    expect(failed.body).toContain("The connection was not deleted");
    expect(failed.body).not.toContain("SQLITE_IOERR");
    expect(failed.headers["set-cookie"]).toBeUndefined();
    expect(application.connections.getConnection(id).id).toBe(id);
    failing.mockRestore();
    const retried = await submit();
    expect(retried.statusCode).toBe(200);
    expect(() => application!.connections.getConnection(id)).toThrow(/not found/u);
    await server.close();
  });

  it("renames a connection straight from the chat", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const { id } = connection(application);
    const tools = createToolHandlers(application.mcpDependencies);

    const renamed = await tools.rename_connection({ connectionId: id, label: "Магазин" });

    expect(renamed.label).toBe("Магазин");
  });
});
