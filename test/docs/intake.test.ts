import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectionRepository, type DocumentationSourceRecord } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { DOCUMENT_LIMITS, DocumentRepository } from "../../src/docs/documents.js";
import { DocumentationIntake } from "../../src/docs/intake.js";
import { DocsRepository } from "../../src/docs/repository.js";
import type { FetchImplementation } from "../../src/security/network-policy.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";
import { watchWorkers } from "../helpers/workers.js";

type Route = { status: number; type: string; body: string };

function routes(table: Record<string, Route>): FetchImplementation {
  return async (input) => {
    const route = table[input.toString()];
    if (!route) return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(route.body, { status: route.status, headers: { "content-type": route.type } });
  };
}

const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";
const SPEC_URL = "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml?region=ru";

describe("DocumentationIntake", () => {
  let db: Database.Database;
  let source: DocumentationSourceRecord;
  let documents: DocumentRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    source = new ConnectionRepository(db).createDocumentationSource({ rootUrl: LINK, allowedOrigin: "https://dev.wildberries.ru" });
    documents = new DocumentRepository(db);
  });

  afterEach(() => db.close());

  function intake(table: Record<string, Route>, maxDocumentBytes = 5_242_880): DocumentationIntake {
    return new DocumentationIntake({
      documents,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: routes(table),
      timeoutMs: 1_000,
      maxDocumentBytes,
    });
  }

  it("attaches an official YAML spec with searchable operation chunks", async () => {
    const results = await intake({ [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML } }).attachUrls(source, [SPEC_URL]);
    expect(results).toEqual([expect.objectContaining({ url: SPEC_URL, outcome: "attached", kind: "openapi", provenance: "official" })]);
    expect(new DocsRepository(db).search(source.id, "orders new", 5)[0]?.heading).toContain("GET /api/v3/orders/new");
    expect(documents.list(source.id)[0]?.discovery.credentials[0]?.fieldName).toBe("Authorization");
  });

  it("labels files from other domains as third-party", async () => {
    const copy = "https://raw.githubusercontent.com/someone/wb-sdk/main/specs/03-orders-fbs.yaml";
    const [result] = await intake({ [copy]: { status: 200, type: "text/plain", body: WB_STYLE_YAML } }).attachUrls(source, [copy]);
    expect(result).toMatchObject({ outcome: "attached", provenance: "third_party" });
  });

  it("labels a file from another customer's site on a shared documentation host as third-party", async () => {
    const shared = new ConnectionRepository(db).createDocumentationSource({
      rootUrl: "https://acme.readme.io/reference", allowedOrigin: "https://acme.readme.io",
    });
    const own = "https://acme.readme.io/openapi/orders.yaml";
    const other = "https://evil.readme.io/openapi/orders.yaml";
    const results = await intake({
      [own]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
      [other]: { status: 200, type: "text/yaml", body: `${WB_STYLE_YAML}\n# a copy\n` },
    }).attachUrls(shared, [own, other]);
    expect(results.map(({ url, provenance }) => [url, provenance])).toEqual([[own, "official"], [other, "third_party"]]);
  });

  it("reports blocked pages, challenge pages, oversized files, and duplicates", async () => {
    const challenge = "https://dev.wildberries.ru/challenge";
    const service = intake({
      [LINK]: { status: 498, type: "text/html", body: "<html>Проверяем браузер</html>" },
      [challenge]: { status: 200, type: "text/html", body: "<html><body>Checking your browser</body></html>" },
      [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
    }, 512);
    const results = await service.attachUrls(source, [LINK, challenge, SPEC_URL]);
    expect(results.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["blocked", "http_498"],
      ["blocked", "empty_or_challenge_page"],
      ["rejected", "too_large"],
    ]);
    const roomy = intake({ [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML } });
    await roomy.attachUrls(source, [SPEC_URL]);
    expect((await roomy.attachUrls(source, [SPEC_URL]))[0]?.outcome).toBe("duplicate");
  });

  it("follows spec links found in an attached HTML page", async () => {
    const page = "https://dev.wildberries.ru/docs/openapi/orders-fbs";
    const html = `<html><body><h1>Orders</h1><p>${"Документация по заказам. ".repeat(20)}</p><redoc spec-url="/api/swagger/yaml/ru/03-orders-fbs.yaml?region=ru"></redoc></body></html>`;
    const results = await intake({
      [page]: { status: 200, type: "text/html", body: html },
      [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
    }).attachUrls(source, [page]);
    expect(results.map(({ url, kind }) => [url, kind])).toEqual([[page, "html"], [SPEC_URL, "openapi"]]);
  });

  it("stores a linked file only when it is a machine-readable spec", async () => {
    const page = "https://dev.wildberries.ru/docs/openapi/orders-fbs";
    const linkedPage = "https://dev.wildberries.ru/api/swagger/yaml/ru/guide.yaml";
    const linkedText = "https://dev.wildberries.ru/files/notes.json";
    const html = `<html><body><h1>Orders</h1><p>${"Документация по заказам. ".repeat(20)}</p><redoc spec-url="/api/swagger/yaml/ru/guide.yaml"></redoc><a href="/files/notes.json">Notes</a></body></html>`;
    const results = await intake({
      [page]: { status: 200, type: "text/html", body: html },
      [linkedPage]: { status: 200, type: "text/html", body: `<html><body><h1>Guide</h1><p>${"Описание. ".repeat(40)}</p></body></html>` },
      [linkedText]: { status: 200, type: "application/json", body: JSON.stringify({ notes: "Plain notes. ".repeat(40) }) },
    }).attachUrls(source, [page]);
    expect(results.map(({ url, outcome, reason }) => [url, outcome, reason])).toEqual([
      [page, "attached", undefined],
      [linkedPage, "rejected", "not_a_specification"],
      [linkedText, "rejected", "not_a_specification"],
    ]);
    expect(documents.list(source.id).map(({ url }) => url)).toEqual([page]);
  });

  it("parses an attached YAML document once, whether or not it turns out to be a spec", async () => {
    const hostile = "https://dev.wildberries.ru/files/hostile.yaml";
    const outdated = "https://dev.wildberries.ru/files/outdated.yaml";
    const aliases = Array.from({ length: 150 }, () => "*base").join(", ");
    const service = intake({
      [hostile]: { status: 200, type: "text/yaml", body: `openapi: 3.0.0\nbase: &base x\nitems: [${aliases}]\n` },
      [outdated]: { status: 200, type: "text/yaml", body: "openapi: 2.0\ninfo: {title: Outdated}\npaths: {}\n" },
    });
    const workers = watchWorkers();
    try {
      expect(await service.attachUrls(source, [hostile])).toEqual([expect.objectContaining({ outcome: "attached", kind: "text" })]);
      expect(workers.started).toHaveLength(1);
      expect(await service.attachUrls(source, [outdated])).toEqual([expect.objectContaining({ outcome: "attached", kind: "text" })]);
      expect(workers.started).toHaveLength(2);
    } finally {
      workers.stop();
    }
  });

  it("lets crawl spec links fill only part of the document budget", async () => {
    const specs: Record<string, Route> = {};
    for (let index = 0; index < 30; index += 1) {
      const url = `https://dev.wildberries.ru/api/swagger/yaml/ru/${index}.yaml`;
      specs[url] = { status: 200, type: "text/yaml", body: WB_STYLE_YAML.replace("Заказы FBS", `Раздел ${index}`) };
    }
    const results = await intake(specs).attachCrawlSpecLinks(source, Object.keys(specs));
    expect(results.filter(({ outcome }) => outcome === "attached")).toHaveLength(DOCUMENT_LIMITS.maxCrawlDocuments);
    expect(results.at(-1)).toMatchObject({ outcome: "rejected", reason: "limit_reached" });
    const [assistant] = await intake({ [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML } }).attachUrls(source, [SPEC_URL]);
    expect(assistant).toMatchObject({ outcome: "attached" });
  });

  it("assembles AI-supplied text from parts in any order", async () => {
    const service = intake({});
    const third = Math.ceil(WB_STYLE_YAML.length / 3);
    const parts = [0, 1, 2].map((index) => WB_STYLE_YAML.slice(index * third, (index + 1) * third));
    const sourceUrl = "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml";
    expect(await service.attachContentPart(source, "draft-1", { sourceUrl, mediaType: "openapi-yaml", partIndex: 2, partCount: 3, text: parts[2]! }))
      .toEqual({ complete: false, received: 1, expected: 3 });
    await service.attachContentPart(source, "draft-1", { sourceUrl, mediaType: "openapi-yaml", partIndex: 0, partCount: 3, text: parts[0]! });
    const done = await service.attachContentPart(source, "draft-1", { sourceUrl, mediaType: "openapi-yaml", partIndex: 1, partCount: 3, text: parts[1]! });
    expect(done).toMatchObject({ complete: true, result: { outcome: "attached", kind: "openapi", provenance: "model_content" } });
  });

  it("rejects malformed parts", async () => {
    const service = intake({});
    const base = { sourceUrl: "https://dev.wildberries.ru/x", mediaType: "text" as const, partIndex: 0, partCount: 1 };
    await expect(service.attachContentPart(source, "d", { ...base, sourceUrl: "http://dev.wildberries.ru/x", text: "a" })).rejects.toThrow();
    await expect(service.attachContentPart(source, "d", { ...base, partIndex: 1, text: "a" })).rejects.toThrow();
    await expect(service.attachContentPart(source, "d", { ...base, text: "a".repeat(100_001) })).rejects.toThrow();
  });

  it("rejects over-long or unparsable URLs without losing the rest of the batch", async () => {
    const tooLong = `https://dev.wildberries.ru/x?q=${"a".repeat(2_100)}`;
    const results = await intake({
      [tooLong]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
      [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
    }).attachUrls(source, [tooLong, SPEC_URL]);
    expect(results.map(({ outcome, reason }) => [outcome, reason])).toEqual([
      ["rejected", "invalid_url"],
      ["attached", undefined],
    ]);
    expect(results[0]?.url.length).toBeLessThanOrEqual(2_000);
  });

  it("stores a spec whose title is longer than a destination label", async () => {
    const longTitle = "https://dev.wildberries.ru/api/swagger/yaml/ru/long.yaml";
    const results = await intake({
      [longTitle]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML.replace("Заказы FBS", "Заказы ".repeat(30)) },
      [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
    }).attachUrls(source, [longTitle, SPEC_URL]);
    expect(results.map(({ outcome }) => outcome)).toEqual(["attached", "attached"]);
  });

  it("rejects a document that cannot be stored without losing the rest of the batch", async () => {
    const broken = "https://dev.wildberries.ru/api/swagger/yaml/ru/broken.yaml";
    const add = documents.add.bind(documents);
    vi.spyOn(documents, "add").mockImplementation((input, maxDocuments) => {
      if (input.url === broken) throw new Error("unexpected storage failure");
      return add(input, maxDocuments);
    });
    const results = await intake({
      [broken]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML.replace("Заказы FBS", "Сломанный") },
      [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
    }).attachUrls(source, [broken, SPEC_URL]);
    expect(results.map(({ url, outcome, reason }) => [url, outcome, reason])).toEqual([
      [broken, "rejected", "invalid_document"],
      [SPEC_URL, "attached", undefined],
    ]);
    expect(JSON.stringify(results)).not.toContain("unexpected storage failure");
  });

  it("rejects a part whose source URL the discovery schema would refuse", async () => {
    const service = intake({});
    const base = { mediaType: "openapi-yaml" as const, partIndex: 0, partCount: 1, text: WB_STYLE_YAML };
    await expect(service.attachContentPart(source, "d", { ...base, sourceUrl: `https://dev.wildberries.ru/${"a".repeat(2_000)}` })).rejects.toThrow(/sourceUrl/u);
    await expect(service.attachContentPart(source, "d", { ...base, sourceUrl: "https://:::" })).rejects.toThrow(/sourceUrl/u);
  });

  it("reports the stored document for a duplicate and never upgrades its provenance", async () => {
    const service = intake({ [SPEC_URL]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML } });
    const sourceUrl = "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml";
    const first = await service.attachContentPart(source, "draft-1", { sourceUrl, mediaType: "openapi-yaml", partIndex: 0, partCount: 1, text: WB_STYLE_YAML });
    expect(first).toMatchObject({ complete: true, result: { outcome: "attached", provenance: "model_content" } });
    const storedId = first.complete ? first.result.documentId : undefined;

    const [duplicate] = await service.attachUrls(source, [SPEC_URL]);

    expect(duplicate).toEqual({ url: sourceUrl, outcome: "duplicate", documentId: storedId, kind: "openapi", provenance: "model_content" });
    expect(documents.list(source.id).map(({ id, url, provenance }) => [id, url, provenance])).toEqual([[storedId, sourceUrl, "model_content"]]);
  });

  describe("URLs that carry credentials", () => {
    const SECRET = "s3cr3t-token-value";
    const WITH_PASSWORD = `https://reader:${SECRET}@dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml`;
    const WITH_USERNAME_ONLY = `https://${SECRET}@dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml`;

    function expectNothingStored(...visible: unknown[]): void {
      expect(documents.list(source.id)).toEqual([]);
      expect(findKeyFragment(db, SECRET)).toEqual([]);
      expect(JSON.stringify(visible)).not.toContain(SECRET);
    }

    it("rejects them before any fetch when passed directly", async () => {
      let fetched = 0;
      const service = new DocumentationIntake({
        documents,
        resolver: async () => ["8.8.8.8"],
        fetchImpl: async () => {
          fetched += 1;
          return new Response(WB_STYLE_YAML, { status: 200, headers: { "content-type": "text/yaml" } });
        },
        timeoutMs: 1_000,
        maxDocumentBytes: 5_242_880,
      });
      const results = await service.attachUrls(source, [WITH_PASSWORD, WITH_USERNAME_ONLY]);
      expect(results.map(({ outcome, reason }) => [outcome, reason])).toEqual([
        ["rejected", "invalid_url"],
        ["rejected", "invalid_url"],
      ]);
      expect(fetched).toBe(0);
      expectNothingStored(results);
    });

    it("rejects a credentialed spec link found in an attached HTML page but keeps the page", async () => {
      const page = "https://dev.wildberries.ru/docs/openapi/orders-fbs";
      const html = `<html><body><h1>Orders</h1><p>${"Документация по заказам. ".repeat(20)}</p><redoc spec-url="${WITH_PASSWORD}"></redoc></body></html>`;
      const results = await intake({
        [page]: { status: 200, type: "text/html", body: html },
        [WITH_PASSWORD]: { status: 200, type: "text/yaml", body: WB_STYLE_YAML },
      }).attachUrls(source, [page]);
      expect(results.map(({ outcome, kind, reason }) => [outcome, kind, reason])).toEqual([
        ["attached", "html", undefined],
        ["rejected", undefined, "invalid_url"],
      ]);
      expect(documents.list(source.id).map(({ url }) => url)).toEqual([page]);
      expect(findKeyFragment(db, SECRET)).toEqual([]);
      expect(JSON.stringify(results)).not.toContain(SECRET);
    });

    it("rejects them as the source URL of AI-supplied text", async () => {
      const service = intake({});
      for (const sourceUrl of [WITH_PASSWORD, WITH_USERNAME_ONLY]) {
        const attempt = () =>
          service.attachContentPart(source, "d", { sourceUrl, mediaType: "openapi-yaml", partIndex: 0, partCount: 1, text: WB_STYLE_YAML });
        await expect(attempt()).rejects.toThrow(/sourceUrl/u);
        const error = await attempt().catch((caught: unknown) => caught);
        expect((error as Error).message).not.toContain(SECRET);
      }
      expectNothingStored();
    });
  });
});
