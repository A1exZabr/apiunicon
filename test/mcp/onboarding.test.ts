import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";
import { draftSetup } from "../helpers/setup.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 13),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};
const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";
const SPEC = "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml?region=ru";

describe("MCP onboarding tools", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function app(): Application {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => input.toString() === SPEC
        ? new Response(WB_STYLE_YAML, { status: 200, headers: { "content-type": "text/yaml" } })
        : new Response("<html>Проверяем браузер</html>", { status: 498, headers: { "content-type": "text/html" } }),
    });
    return application;
  }

  it("asks the AI for documentation, accepts spec URLs, and issues one key-entry link", async () => {
    const tools = createToolHandlers(app().mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    expect(started).toMatchObject({ stage: "needs_documentation", keyEntry: null });
    expect(started.nextStep).toContain("attach_documentation");

    const attached = await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
    if (!("results" in attached)) throw new Error("expected a completed attachment");
    expect(attached.results).toEqual([expect.objectContaining({ outcome: "attached", provenance: "official" })]);
    expect(attached.setup).toMatchObject({ stage: "waiting_for_keys", serviceName: "Заказы FBS" });
    expect(attached.setup.keyEntry).toMatchObject({ url: expect.stringMatching(new RegExp(`^http://127\\.0\\.0\\.1:3210/connect/${started.draftId}\\?t=`, "u")) });
    expect(attached.setup.destinations).toEqual(expect.arrayContaining([
      { origin: "https://marketplace-api.wildberries.ru", preselected: true, confidence: "high" },
      { origin: "https://marketplace-api-sandbox.wildberries.ru", preselected: true, confidence: "low" },
    ]));

    const again = await tools.get_connection_setup({ draftId: started.draftId });
    expect(again.keyEntry).toMatchObject({ active: true });
    const fresh = await tools.get_connection_setup({ draftId: started.draftId, newKeyEntryLink: true });
    expect(fresh.keyEntry).toMatchObject({ url: expect.stringContaining("?t=") });
  });

  it("preselects the hosts of the link's own domain from AI-supplied text as well", async () => {
    const tools = createToolHandlers(app().mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    const attached = await tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: SPEC, mediaType: "openapi-yaml", partIndex: 0, partCount: 1, text: WB_STYLE_YAML },
    });
    if (!("setup" in attached)) throw new Error("expected a completed attachment");
    expect(attached.setup.stage).toBe("waiting_for_keys");
    expect(attached.setup.destinations.length).toBeGreaterThan(0);
    expect(attached.setup.destinations.every(({ preselected }) => preselected)).toBe(true);
  });

  it("assembles text parts and accepts proposals only within the link's domain", async () => {
    const tools = createToolHandlers(app().mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    const partial = await tools.attach_documentation({
      draftId: started.draftId,
      content: { sourceUrl: SPEC, mediaType: "openapi-yaml", partIndex: 0, partCount: 2, text: WB_STYLE_YAML.slice(0, 500) },
    });
    expect(partial).toMatchObject({ received: 1, expected: 2 });
    await expect(tools.propose_connection_settings({
      draftId: started.draftId, serviceName: "WB", origins: ["https://evil.example"],
      credentials: [{ fieldName: "Authorization", kind: "api_key", humanLabel: "Token" }], rationale: "guess",
    })).rejects.toThrow(/outside/u);
  });

  it("says plainly, without naming the product, that an authentication method is not supported", async () => {
    const application = app();
    const tools = createToolHandlers(application.mcpDependencies);
    const draft = application.discovery.begin("https://docs.example.test/oauth-only");
    application.drafts.recordDiscovery(draft.id, {
      serviceName: "OAuth API", suggestedLabel: "OAuth", origins: [], credentials: [], unsupportedAuthMethods: ["OAuth 2.0"],
    });

    const setup = await tools.get_connection_setup({ draftId: draft.id });

    expect(setup.stage).toBe("failed");
    expect(setup.nextStep).toBe("This service requires OAuth 2.0, which is not supported yet. Tell the person.");
  });

  it("reports how an adapter's documentation was obtained", async () => {
    const application = app();
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
    const draft = application.drafts.get(started.draftId);
    const connection = application.discovery.completeWithSelection(draft.id, {
      originIds: [draft.discovery.origins[0]!.id],
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "token" },
    });
    const adapter = await tools.create_adapter({
      connectionId: connection.id, slug: "wb-orders", displayName: "WB orders",
      dsl: {
        schemaVersion: 1,
        baseOrigins: ["https://marketplace-api.wildberries.ru"],
        credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
        operations: [{ id: "orders_new", description: "New orders", risk: "read", method: "GET", path: "/api/v3/orders/new", input: {}, documentationRefs: [] }],
      },
    });
    expect((await tools.get_adapter_state({ adapterId: adapter.id })).documentationProvenance).toEqual(["official"]);
  });

  it("labels an adapter built on AI-proposed settings as built without documentation", async () => {
    const application = app();
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    const proposed = await tools.propose_connection_settings({
      draftId: started.draftId, serviceName: "WB", origins: ["https://common-api.wildberries.ru"],
      credentials: [{ fieldName: "Authorization", kind: "api_key", humanLabel: "Token" }], rationale: "Docs blocked",
    });
    expect(proposed).toMatchObject({ stage: "waiting_for_keys", provenance: { kind: "model_settings" } });
    const draft = application.drafts.get(started.draftId);
    const connection = application.discovery.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "token" },
    });
    const adapter = await tools.create_adapter({
      connectionId: connection.id, slug: "wb-seller", displayName: "WB seller",
      dsl: {
        schemaVersion: 1,
        baseOrigins: ["https://common-api.wildberries.ru"],
        credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
        operations: [{ id: "seller_info", description: "Seller info", risk: "read", method: "GET", path: "/api/v1/seller-info", input: {}, documentationRefs: [] }],
      },
    });
    expect((await tools.get_adapter_state({ adapterId: adapter.id })).documentationProvenance).toEqual(["model_settings"]);
  });

  it("keeps room for the AI's spec when the crawled link sits under an openapi path with many pages", async () => {
    const docsLink = "https://docs.shop.test/docs/openapi/";
    const spec = "https://docs.shop.test/files/shop.yaml";
    const nav = Array.from({ length: 40 }, (_, index) => `<a href="/docs/openapi/page-${index}">Page ${index}</a>`).join("");
    const page = (path: string) => `<html><body><h1>Docs ${path}</h1><p>${`Reference text for ${path}. `.repeat(20)}</p>${nav}</body></html>`;
    const yaml = `openapi: 3.0.1
info: { title: Shop }
servers: [{ url: "https://api.shop.test" }]
paths:
  /orders:
    get: { responses: { "200": { description: ok } } }
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Shop-Key }
`;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url === spec) return new Response(yaml, { status: 200, headers: { "content-type": "text/yaml" } });
        return new Response(page(new URL(url).pathname), { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: docsLink }));
    const sourceId = application.drafts.get(started.draftId).documentationSourceId;
    expect(application.documents.list(sourceId).map(({ kind }) => kind)).toEqual(["html"]);

    const attached = await tools.attach_documentation({ draftId: started.draftId, urls: [spec] });
    if (!("results" in attached)) throw new Error("expected a completed attachment");
    expect(attached.results).toEqual([expect.objectContaining({ url: spec, outcome: "attached", kind: "openapi" })]);
    expect(attached.setup.stage).toBe("waiting_for_keys");
  });

  it("is not stopped by OAuth found in a third-party copy or next to a supported key", async () => {
    const thirdParty = "https://raw.githubusercontent.com/someone/wb-sdk/main/oauth.yaml";
    const official = "https://dev.wildberries.ru/api/swagger/yaml/ru/oauth-and-key.yaml";
    const oauthOnly = `openapi: 3.0.1
info: { title: Copy }
paths: {}
components:
  securitySchemes:
    oauth: { type: oauth2, flows: {} }
`;
    const keyAndOAuth = WB_STYLE_YAML.replace("components:\n  securitySchemes:\n", "components:\n  securitySchemes:\n    OAuth:\n      type: oauth2\n      flows: {}\n");
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url === SPEC) return new Response(WB_STYLE_YAML, { status: 200, headers: { "content-type": "text/yaml" } });
        if (url === thirdParty) return new Response(oauthOnly, { status: 200, headers: { "content-type": "text/plain" } });
        if (url === official) return new Response(keyAndOAuth, { status: 200, headers: { "content-type": "text/yaml" } });
        return new Response("<html>Проверяем браузер</html>", { status: 498, headers: { "content-type": "text/html" } });
      },
    });
    const tools = createToolHandlers(application.mcpDependencies);
    const started = draftSetup(await tools.start_connection({ documentationUrl: LINK }));
    await tools.attach_documentation({ draftId: started.draftId, urls: [SPEC] });
    const copied = await tools.attach_documentation({ draftId: started.draftId, urls: [thirdParty] });
    if (!("setup" in copied)) throw new Error("expected a completed attachment");
    expect(copied.setup).toMatchObject({ stage: "waiting_for_keys", unsupportedAuthMethods: [] });

    const both = draftSetup(await tools.start_connection({ documentationUrl: "https://dev.wildberries.ru/docs/openapi/oauth" }));
    const attached = await tools.attach_documentation({ draftId: both.draftId, urls: [official] });
    if (!("setup" in attached)) throw new Error("expected a completed attachment");
    expect(attached.setup).toMatchObject({ stage: "waiting_for_keys", unsupportedAuthMethods: ["OAuth 2.0"] });
  });
});
