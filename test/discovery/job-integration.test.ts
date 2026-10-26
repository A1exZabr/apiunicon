import type { AppConfig } from "../../src/config.js";
import { emptyDiscoveryResult } from "../../src/discovery/schema.js";
import { DOCUMENT_LIMITS } from "../../src/docs/documents.js";
import { buildApplication, type Application } from "../../src/index.js";
import { MAX_JOB_ATTEMPTS } from "../../src/jobs/repository.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const config: AppConfig = {
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 3),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

describe("connection discovery crawl integration", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  it("persists discovery candidates when the queued documentation crawl succeeds", async () => {
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

    const draft = application.discovery.begin("https://docs.example.test/openapi.json");
    expect(await application.jobRunner.runOne()).toBe(true);
    const discovered = application.drafts.get(draft.id);
    expect(discovered).toMatchObject({
      status: "needs_review",
      serviceName: "Fixture Orders API",
      discovery: {
        origins: [expect.objectContaining({ origin: "https://api.example.test" })],
        credentials: [expect.objectContaining({ fieldName: "Api-Key" })],
      },
    });
  });

  it("finishes discovery for a spec whose title is longer than a destination label", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Orders ".repeat(25) },
        servers: [{ url: "https://api.example.test/v1" }],
        components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "Api-Key" } } },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const draft = application.discovery.begin("https://docs.example.test/openapi.json");

    await application.jobRunner.runOne();

    expect(application.drafts.get(draft.id).status).toBe("needs_review");
  });

  it("moves a blocked documentation link to documentation_unavailable without guessing", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response("<html>Проверяем браузер</html>", { status: 498, headers: { "content-type": "text/html" } }),
    });
    const draft = application.discovery.begin("https://dev.wildberries.ru/docs/openapi/api-information");

    await application.jobRunner.runOne();

    expect(application.drafts.get(draft.id)).toMatchObject({
      status: "needs_help",
      helpReason: "documentation_unavailable",
      errorCategory: null,
    });
    expect(application.drafts.get(draft.id).discovery.origins).toEqual([]);
  });

  it("follows a Redoc spec link from the crawled page and discovers from the spec", async () => {
    const yaml = `openapi: 3.0.1
info: { title: Shop API }
paths:
  /orders:
    servers: [{ url: "https://api.shop.test" }]
    get: { summary: List orders, responses: { "200": { description: ok } } }
components:
  securitySchemes:
    key: { type: apiKey, in: header, name: X-Shop-Key }
`;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => {
        const url = input.toString();
        if (url === "https://docs.shop.test/api") {
          return new Response(`<html><body><h1>Shop API</h1><redoc spec-url="/spec/shop.yaml"></redoc></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url === "https://docs.shop.test/spec/shop.yaml") {
          return new Response(yaml, { status: 200, headers: { "content-type": "text/yaml" } });
        }
        return new Response("missing", { status: 404 });
      },
    });
    const draft = application.discovery.begin("https://docs.shop.test/api");

    await application.jobRunner.runOne();

    const discovered = application.drafts.get(draft.id);
    expect(discovered).toMatchObject({ status: "needs_review", serviceName: "Shop API" });
    expect(discovered.discovery.origins.map(({ origin }) => origin)).toEqual(["https://api.shop.test"]);
    expect(discovered.discovery.credentials.map(({ fieldName }) => fieldName)).toEqual(["X-Shop-Key"]);
    expect(application.documents.list(draft.documentationSourceId).map(({ kind }) => kind)).toEqual(["html", "openapi"]);
  });

  it("skips a broken linked page instead of failing the whole crawl", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input) => input.toString() === "https://docs.shop.test/"
        ? new Response(`<html><body><h1>Docs</h1><a href="/gone">Gone</a><p>curl -H "X-Shop-Key: value" https://api.shop.test/orders</p><p>GET https://api.shop.test/orders with X-Shop-Key: value</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } })
        : new Response("gone", { status: 404 }),
    });
    const draft = application.discovery.begin("https://docs.shop.test/");

    await application.jobRunner.runOne();

    const stored = application.drafts.get(draft.id);
    expect(stored).toMatchObject({ status: "needs_review", serviceName: null });
    expect(stored.discovery.origins.map(({ origin }) => origin)).toEqual(["https://api.shop.test"]);
    expect(stored.discovery.credentials.map(({ fieldName }) => fieldName)).toEqual(["X-Shop-Key"]);
    expect(application.documents.list(draft.documentationSourceId).map(({ kind, url }) => ({ kind, url })))
      .toEqual([{ kind: "html", url: "https://docs.shop.test/" }]);
    expect(application.connections.getDocumentationSource(draft.documentationSourceId).status).toBe("ready");
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)?.status).toBe("succeeded");
  });

  const documentationPage = `<html><body><h1>Shop docs</h1><p>Orders are listed here.</p></body></html>`;
  const htmlResponse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("does not leave the draft discovering when refreshing from documents throws after the crawl", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => htmlResponse(documentationPage),
    });
    const draft = application.discovery.begin("https://docs.shop.test/");
    vi.spyOn(application.discovery, "refreshFromDocuments").mockImplementation(() => {
      throw new Error("refresh exploded with provider detail");
    });

    await application.jobRunner.runOne();

    expect(application.drafts.get(draft.id)).toMatchObject({
      status: "needs_help",
      helpReason: "documentation_unavailable",
      errorCategory: null,
    });
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)).toMatchObject({
      status: "failed",
      errorCategory: "crawl",
    });
    expect(JSON.stringify(application.drafts.get(draft.id))).not.toContain("provider detail");
  });

  it("finishes a retried crawl of a source that already holds the maximum number of documents", async () => {
    let reachable = false;
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => reachable
        ? htmlResponse(documentationPage)
        : new Response("<html>Проверяем браузер</html>", { status: 498, headers: { "content-type": "text/html" } }),
    });
    const draft = application.discovery.begin("https://docs.shop.test/");
    await application.jobRunner.runOne();
    expect(application.drafts.get(draft.id).status).toBe("needs_help");
    for (let index = 0; index < DOCUMENT_LIMITS.maxDocuments; index += 1) {
      application.documents.add({
        sourceId: draft.documentationSourceId,
        url: `https://docs.shop.test/attached-${index}`,
        kind: "text",
        provenance: "model_content",
        sha256: index.toString(16).padStart(64, "0"),
        byteSize: 10,
        discovery: emptyDiscoveryResult(),
        chunks: [],
      });
    }

    reachable = true;
    application.discovery.retry(draft.id);
    expect(application.drafts.get(draft.id).status).toBe("discovering");
    await application.jobRunner.runOne();

    expect(application.drafts.get(draft.id)).toMatchObject({
      status: "needs_help",
      helpReason: "documentation_unavailable",
    });
    expect(application.documents.list(draft.documentationSourceId)).toHaveLength(DOCUMENT_LIMITS.maxDocuments);
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)?.status).toBe("succeeded");
  });

  it("does not try to mark a draft that left discovering while a failing crawl was running", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        application!.drafts.markFailed(draft.id, "crawl");
        return new Response("blocked", { status: 498 });
      },
    });
    const draft = application.discovery.begin("https://docs.shop.test/");
    const markUnavailable = vi.spyOn(application.drafts, "markDocumentationUnavailable");

    await application.jobRunner.runOne();

    expect(markUnavailable).not.toHaveBeenCalled();
    expect(application.drafts.get(draft.id)).toMatchObject({ status: "failed", errorCategory: "crawl" });
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)?.status).toBe("failed");
  });

  it("does not refresh a draft that left discovering while the crawl was running", async () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        application!.drafts.markFailed(draft.id, "crawl");
        return htmlResponse(documentationPage);
      },
    });
    const draft = application.discovery.begin("https://docs.shop.test/");
    const refresh = vi.spyOn(application.discovery, "refreshFromDocuments");

    await application.jobRunner.runOne();

    expect(refresh).not.toHaveBeenCalled();
    expect(application.drafts.get(draft.id)).toMatchObject({ status: "failed", errorCategory: "crawl" });
    expect(application.documents.list(draft.documentationSourceId)).toHaveLength(1);
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)?.status).toBe("succeeded");
  });

  it("crawls a fan-out spec served under the crawl size limit without exhausting memory", async () => {
    // Scaled down from 3,000 root servers x 40,000 operations, which crashed the service inside the crawl.
    const hostile = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Fan-out" },
      servers: Array.from({ length: 1_500 }, (_, index) => ({ url: `https://a${index}.shop.test` })),
      paths: Object.fromEntries(Array.from({ length: 15_000 }, (_, index) => [`/a${index}`, { get: {} }])),
      components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Shop-Key" } } },
    });
    application = buildApplication({ ...config, maxResponseBytes: 1_048_576 }, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => new Response(hostile, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const draft = application.discovery.begin("https://docs.shop.test/openapi.json");

    const started = performance.now();
    await application.jobRunner.runOne();

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(application.drafts.get(draft.id).status).toBe("needs_review");
    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)?.status).toBe("succeeded");
  });

  it("gives up on a crawl that kept crashing the service and releases its draft", () => {
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async () => htmlResponse(documentationPage),
    });
    const draft = application.discovery.begin("https://docs.shop.test/");
    // Each claim without a finish is one process crash in the middle of the crawl.
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      application.jobs.claimNext();
      application.jobs.requeueInterrupted();
    }
    application.jobs.claimNext();

    application.jobRunner.start();
    application.jobRunner.stop();

    expect(application.jobs.latest("crawl_documentation", draft.documentationSourceId)).toMatchObject({
      status: "failed",
      errorCategory: "interrupted",
    });
    expect(application.drafts.get(draft.id)).toMatchObject({ status: "needs_help", helpReason: "documentation_unavailable" });
    expect(application.connections.getDocumentationSource(draft.documentationSourceId).status).toBe("failed");
  });
});
