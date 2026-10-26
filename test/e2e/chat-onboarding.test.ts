import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers, type ToolName } from "../../src/mcp/tools.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { draftSetup } from "../helpers/setup.js";
import { cookieHeader, form, LOCAL, setupAdmin, setupTokenPath } from "../http/helpers.js";
import { ran } from "../helpers/results.js";

const LINK = "https://docs.shop.test/docs/api";
const SPEC = "https://docs.shop.test/api/swagger/orders.yaml";
const FIRST = "first-chat-secret";
const SECOND = "second-chat-secret";
const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 14),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const SPEC_YAML = `openapi: 3.0.1
info: { title: Shop Orders }
paths:
  /orders:
    servers: [{ url: "https://api.shop.test" }]
    get:
      operationId: listOrders
      summary: List recent orders
      responses: { "200": { description: ok } }
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Shop-Key }
`;

describe("chat-first onboarding proof", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  it("connects from one link, builds once, and reuses without documentation work", async () => {
    const apiKeys: Array<string | null> = [];
    const documentationFetches: string[] = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init = {}) => {
        const url = input.toString();
        if (new URL(url).hostname === "docs.shop.test") documentationFetches.push(url);
        if (url === SPEC) return new Response(SPEC_YAML, { status: 200, headers: { "content-type": "text/yaml" } });
        if (url.startsWith("https://api.shop.test/orders")) {
          apiKeys.push(new Headers(init.headers).get("X-Shop-Key"));
          return new Response(JSON.stringify({ orders: [{ id: 1 }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("<html>Checking your browser</html>", { status: 498, headers: { "content-type": "text/html" } });
      },
    });
    const server = buildHttpServer(application);
    try {
      const session = await setupAdmin(server, application);
      // Everything the AI is shown. Secrets must never appear in it.
      const seenByAi: unknown[] = [];

      const firstCalls: ToolName[] = [];
      const first = createToolHandlers({ ...application.mcpDependencies, onToolCall: (name) => firstCalls.push(name) });
      const started = draftSetup(await first.start_connection({ documentationUrl: LINK }));
      seenByAi.push(started);
      expect(started.stage).toBe("needs_documentation");
      const attached = await first.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
      seenByAi.push(attached);
      if (!("setup" in attached) || !attached.setup.keyEntry || !("url" in attached.setup.keyEntry)) throw new Error("no key link");
      await enterKeys(server, attached.setup.keyEntry.url, FIRST);
      const firstSetup = await first.get_connection_setup({ draftId: started.draftId });
      seenByAi.push(firstSetup);
      expect(firstSetup.stage).toBe("completed");
      expect(firstSetup.nextStep).toContain("set origin on each operation");
      expect(firstSetup.nextStep).toContain("tell the person in plain words what they can now ask you");
      const connectionId = firstSetup.connectionId!;
      expect(firstCalls).toContain("attach_documentation");
      expect(firstCalls).not.toContain("propose_connection_settings");
      expect(documentationFetches).toContain(SPEC);
      const firstSourceId = application.drafts.get(started.draftId).documentationSourceId;
      expect(application.documents.list(firstSourceId).length).toBeGreaterThan(0);

      const found = await first.search_docs({ connectionId, query: "orders" });
      seenByAi.push(found);
      expect(found[0]?.heading).toContain("GET /orders");
      const adapter = await first.create_adapter({
        connectionId, slug: "shop-orders", displayName: "Shop Orders",
        dsl: {
          schemaVersion: 1,
          baseOrigins: ["https://api.shop.test"],
          credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
          operations: [{ id: "list_orders", description: "List recent orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
        },
      });
      seenByAi.push(adapter);
      const tested = ran(await first.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));
      seenByAi.push(tested);
      expect(tested.ok).toBe(true);
      const adapterState = await first.get_adapter_state({ adapterId: adapter.id });
      seenByAi.push(adapterState);
      expect(adapterState.documentationProvenance).toEqual(["official"]);
      const reuse = await server.inject({
        method: "POST",
        url: `/adapters/${adapter.id}/mark-reusable`,
        headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["csrf", session.csrf], ["expectedVersion", String(tested.adapterVersion)], ["confirmContribution", "yes"]]),
      });
      expect(reuse.statusCode).toBe(303);
      const versionBefore = application.adapters.get(adapter.id).version;
      const documentationFetchesBefore = documentationFetches.length;

      const secondCalls: ToolName[] = [];
      const second = createToolHandlers({ ...application.mcpDependencies, onToolCall: (name) => secondCalls.push(name) });
      const restarted = draftSetup(await second.start_connection({ documentationUrl: LINK }));
      seenByAi.push(restarted);
      expect(restarted).toMatchObject({ stage: "waiting_for_keys", provenance: { kind: "registry", adapterId: adapter.id } });
      if (!restarted.keyEntry || !("url" in restarted.keyEntry)) throw new Error("no key link");
      await enterKeys(server, restarted.keyEntry.url, SECOND);
      const secondSetup = await second.get_connection_setup({ draftId: restarted.draftId });
      seenByAi.push(secondSetup);
      expect(application.connections.getConnection(secondSetup.connectionId!).adapterId).toBe(adapter.id);
      const reused = ran(await second.call_adapter({ connectionId: secondSetup.connectionId!, operationId: "list_orders", args: {} }));
      seenByAi.push(reused);

      expect(reused).toMatchObject({ ok: true, status: 200 });
      expect(secondCalls).toEqual(["start_connection", "get_connection_setup", "call_adapter"]);
      // No documentation work, proven beyond the list of handlers called.
      expect(documentationFetches.length).toBe(documentationFetchesBefore);
      const secondSourceId = application.drafts.get(restarted.draftId).documentationSourceId;
      expect(secondSourceId).not.toBe(firstSourceId);
      expect(application.documents.list(secondSourceId)).toHaveLength(0);
      expect(application.adapters.get(adapter.id).version).toBe(versionBefore);
      expect(apiKeys).toEqual([FIRST, SECOND]);

      expect(findKeyFragment(application.db, FIRST)).toEqual([]);
      expect(findKeyFragment(application.db, SECOND)).toEqual([]);
      const shown = JSON.stringify(seenByAi);
      expect(shown).not.toContain(FIRST);
      expect(shown).not.toContain(SECOND);
    } finally {
      await server.close();
    }
  });
});

describe("replacing keys from the chat", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  it("swaps the key of a finished connection through a one-time page, keeping its adapter", async () => {
    const REPLACED = "replaced-chat-secret";
    const apiKeys: Array<string | null> = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init = {}) => {
        const url = input.toString();
        if (url === SPEC) return new Response(SPEC_YAML, { status: 200, headers: { "content-type": "text/yaml" } });
        if (url.startsWith("https://api.shop.test/orders")) {
          apiKeys.push(new Headers(init.headers).get("X-Shop-Key"));
          return new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("blocked", { status: 498 });
      },
    });
    const server = buildHttpServer(application);
    try {
      // Replacing keys needs the person signed in on this computer, unlike the first key entry.
      const session = (await setupAdmin(server, application)).cookies;
      const seenByAi: unknown[] = [];
      const tools = createToolHandlers(application.mcpDependencies);
      const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
      const attached = await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
      if (!("setup" in attached) || !attached.setup.keyEntry || !("url" in attached.setup.keyEntry)) throw new Error("no key link");
      const spare = await tools.get_connection_setup({ draftId: started.draftId, newKeyEntryLink: true });
      if (!spare.keyEntry || !("url" in spare.keyEntry)) throw new Error("no spare key link");
      await enterKeys(server, attached.setup.keyEntry.url, FIRST);
      const opensForm = async (url: string) => {
        const { pathname, search } = new URL(url);
        return (await server.inject({ method: "GET", url: `${pathname}${search}`, headers: { host: "127.0.0.1:3210", cookie: session } })).statusCode;
      };
      // Saving keys spends every link of the setup, so an unused one cannot later open the replacement form.
      expect(await opensForm(spare.keyEntry.url)).toBe(403);
      const connectionId = (await tools.get_connection_setup({ draftId: started.draftId })).connectionId!;
      const adapter = await tools.create_adapter({
        connectionId, slug: "shop-orders", displayName: "Shop Orders",
        dsl: {
          schemaVersion: 1,
          baseOrigins: ["https://api.shop.test"],
          credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
          operations: [{ id: "list_orders", description: "List recent orders", risk: "read", method: "GET", path: "/orders", input: {}, documentationRefs: [] }],
        },
      });
      ran(await tools.test_adapter_operation({ connectionId, adapterId: adapter.id, operationId: "list_orders", args: {} }));
      const versionBefore = application.adapters.get(adapter.id).version;

      const unusedReplacement = await tools.replace_connection_keys({ connectionId });
      const replacement = await tools.replace_connection_keys({ connectionId });
      seenByAi.push(unusedReplacement, replacement);
      expect(replacement.nextStep).toContain(replacement.keyEntry.url);
      const { pathname, search } = new URL(replacement.keyEntry.url);
      const headers = { host: "127.0.0.1:3210", cookie: session };
      const opened = await server.inject({ method: "GET", url: `${pathname}${search}`, headers });
      const cookie = `${session}; ${cookieHeader(opened)}`;
      const page = await server.inject({ method: "GET", url: pathname, headers: { ...headers, cookie } });
      expect(page.body).toContain("Replace keys");
      expect(page.body).toContain("api.shop.test");
      expect(page.body).toContain('name="credentialValue:X-Shop-Key"');
      expect(page.body).not.toContain('name="originId"');
      const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
      const submit = (value: string) => server.inject({
        method: "POST",
        url: `${pathname}/complete`,
        headers: { ...headers, cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: form([["csrf", csrf], ["credentialValue:X-Shop-Key", value]]),
      });

      const empty = await submit("");
      expect(empty.statusCode).toBe(400);
      expect(empty.body).toContain("Replace keys");
      const saved = await submit(REPLACED);
      expect(saved.statusCode).toBe(200);
      expect(saved.body).toContain("Keys replaced");
      expect((await submit("another-secret")).statusCode).toBe(403);
      expect(await opensForm(unusedReplacement.keyEntry.url)).toBe(403);

      const called = ran(await tools.call_adapter({ connectionId, operationId: "list_orders", args: {} }));
      seenByAi.push(called);
      expect(called).toMatchObject({ ok: true });
      expect(apiKeys).toEqual([FIRST, REPLACED]);
      expect(application.connections.getConnection(connectionId).adapterId).toBe(adapter.id);
      expect(application.adapters.get(adapter.id).version).toBe(versionBefore);
      expect(JSON.stringify(seenByAi)).not.toContain(REPLACED);
      expect(findKeyFragment(application.db, REPLACED)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses a connection that was not set up through the chat", async () => {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response("") });
    const source = application.connections.createDocumentationSource({ rootUrl: LINK, allowedOrigin: "https://docs.shop.test" });
    application.vault.storeFields("manual-credentials", { "X-Shop-Key": FIRST });
    const manual = application.connections.createConnection({
      label: "Manual", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "manual-credentials",
    });
    const tools = createToolHandlers(application.mcpDependencies);

    await expect(tools.replace_connection_keys({ connectionId: manual.id })).rejects.toThrow(/not set up through the chat/u);
  });
});

async function enterKeys(server: FastifyInstance, keyEntryUrl: string, secret: string): Promise<void> {
  const { pathname, search } = new URL(keyEntryUrl);
  const headers = { host: "127.0.0.1:3210" };
  const opened = await server.inject({ method: "GET", url: `${pathname}${search}`, headers });
  const cookie = cookieHeader(opened);
  const page = await server.inject({ method: "GET", url: pathname, headers: { ...headers, cookie } });
  const csrf = /name="csrf" value="([^"]+)"/u.exec(page.body)?.[1] ?? "";
  const originIds = [...page.body.matchAll(/name="originId" value="([^"]+)" checked/gu)].map((match) => match[1]!);
  const credentialIds = [...page.body.matchAll(/name="credentialId" value="([^"]+)"/gu)].map((match) => match[1]!);
  const done = await server.inject({
    method: "POST",
    url: `${pathname}/complete`,
    headers: { ...headers, cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: form([
      ["csrf", csrf],
      ...originIds.map((id): [string, string] => ["originId", id]),
      ...credentialIds.map((id): [string, string] => ["credentialId", id]),
      ...credentialIds.map((id): [string, string] => [`credentialValue:${id}`, secret]),
    ]),
  });
  if (done.statusCode !== 200) throw new Error(`Key entry failed: ${done.statusCode} ${done.body}`);
}
