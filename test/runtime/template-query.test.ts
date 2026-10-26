import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { prepareCall } from "../../src/runtime/runtime.js";
import { ran } from "../helpers/results.js";
import { cookieHeader, form, LOCAL, setupAdmin, setupTokenPath } from "../http/helpers.js";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 53),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768, requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const ORIGIN = "https://erp.example.test";

// Templates that carry their own query: an OData filter on a read, and the action of a write.
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [
    {
      id: "posted_items",
      description: "Posted catalog items",
      risk: "read",
      method: "GET",
      path: "/odata/Catalog_Items?$filter=Posted eq true",
      input: { $top: { type: "integer", location: "query", required: false } },
      documentationRefs: [],
    },
    {
      id: "archive_item",
      description: "Archive an item",
      risk: "write",
      method: "POST",
      path: "/items/{id}?action=archive",
      input: {
        id: { type: "string", location: "path", required: true, description: "Item" },
        reason: { type: "string", location: "query", required: false, description: "Reason" },
        note: { type: "string", location: "body", required: false, description: "Note" },
      },
      documentationRefs: [],
    },
  ],
};

const READ_URL = `${ORIGIN}/odata/Catalog_Items?$filter=Posted%20eq%20true`;
const WRITE_URL = `${ORIGIN}/items/a%2F7?action=archive&reason=sold+out`;

describe("a path template with its own query", () => {
  let application: Application;
  let server: FastifyInstance;
  let sent: Array<{ method: string; url: string; body: string | null }>;
  let connectionId: string;

  beforeEach(() => {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push({ method: init?.method ?? "GET", url: input.toString(), body: typeof init?.body === "string" ? init.body : null });
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const source = application.connections.createDocumentationSource({ rootUrl: "https://erp.example.test/docs", allowedOrigin: ORIGIN });
    const draft = application.adapters.create({ slug: "erp", displayName: "ERP", documentationSourceId: source.id, dsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    application.vault.storeFields("keys-1", { Authorization: "Basic secret" });
    connectionId = application.connections.createConnection({
      label: "ERP", documentationSourceId: source.id, allowedOrigins: [ORIGIN], credentialSetId: "keys-1", adapterId: adapter.id,
    }).id;
    server = buildHttpServer(application);
  });

  afterEach(async () => {
    await server.close();
    application.db.close();
  });

  it("keeps the template's query and adds the arguments after it", () => {
    const adapter = application.adapters.get(application.connections.getConnection(connectionId).adapterId!);
    const connection = application.connections.getConnection(connectionId);
    const [read, write] = adapter.dsl.operations as [AdapterDsl["operations"][number], AdapterDsl["operations"][number]];
    expect(prepareCall(adapter, connection, read, {}).url.toString()).toBe(READ_URL);
    expect(prepareCall(adapter, connection, read, { $top: 5 }).url.toString()).toBe(`${READ_URL}&%24top=5`);
    expect(prepareCall(adapter, connection, write, { id: "a/7", reason: "sold out" }).url.toString()).toBe(WRITE_URL);
    // A template without a query, or with an empty one, gets only the arguments.
    const plain = { ...read, path: "/odata/Catalog_Items?" };
    expect(prepareCall(adapter, connection, plain, {}).url.toString()).toBe(`${ORIGIN}/odata/Catalog_Items`);
    expect(prepareCall(adapter, connection, plain, { $top: 5 }).url.toString()).toBe(`${ORIGIN}/odata/Catalog_Items?%24top=5`);
  });

  it("sends a read to the filtered address", async () => {
    const tools = createToolHandlers(application.mcpDependencies);
    expect(ran(await tools.call_adapter({ connectionId, operationId: "posted_items", args: { $top: 5 } }))).toMatchObject({ ok: true });
    expect(sent).toEqual([{ method: "GET", url: `${READ_URL}&%24top=5`, body: null }]);
  });

  it("shows the real address of a write on its confirmation page and in the journal, and sends it there", async () => {
    const session = await setupAdmin(server, application);
    application.changes.setWrites(connectionId, true);
    const { result } = await createToolHandlers(application.mcpDependencies).request_change({
      connectionId, operationId: "archive_item", args: { id: "a/7", reason: "sold out", note: "gone" }, summary: "Archive item a/7",
    });
    if (result.status !== "pending") throw new Error(`Expected a pending change, got ${result.status}`);
    expect(application.db.prepare("select method, target_url from change_requests where id = ?").get(result.changeId))
      .toEqual({ method: "POST", target_url: WRITE_URL });

    const url = new URL(result.confirmation.url);
    const opened = await server.inject({ method: "GET", url: `${url.pathname}${url.search}`, headers: { ...LOCAL, cookie: session.cookies } });
    const cookie = `${session.cookies}; ${cookieHeader(opened)}`;
    const page = await server.inject({ method: "GET", url: url.pathname, headers: { ...LOCAL, cookie } });
    expect(page.body).toContain(`<code>POST ${WRITE_URL.replaceAll("&", "&amp;")}</code>`);

    const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
    const done = await server.inject({
      method: "POST", url: url.pathname,
      headers: { ...LOCAL, cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", csrf], ["decision", "run"]]),
    });
    expect(done.body).toContain("<h1>Done</h1>");
    expect(sent).toEqual([{ method: "POST", url: WRITE_URL, body: JSON.stringify({ note: "gone" }) }]);

    const journal = await server.inject({ method: "GET", url: `/connections/${connectionId}`, headers: { ...LOCAL, cookie: session.cookies } });
    expect(journal.body).toContain(`<code>POST ${WRITE_URL.replaceAll("&", "&amp;")}</code>`);
  });
});
