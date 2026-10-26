import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { DiscoveryCollector } from "../../src/discovery/collector.js";
import { crawlDocumentation, splitIntoChunks } from "../../src/docs/crawler.js";
import { DocsRepository } from "../../src/docs/repository.js";

describe("documentation crawler", () => {
  let db: Database.Database;
  let connections: ConnectionRepository;
  let docs: DocsRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    connections = new ConnectionRepository(db);
    docs = new DocsRepository(db);
  });

  afterEach(() => db.close());

  it("indexes unique same-origin pages and makes endpoint text searchable", async () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    const pages = new Map([
      [
        "https://docs.example.test/index.html",
        `<html><body><h1>Seller API</h1>
         <a href="/auth.html">Authentication</a>
         <a href="/postings.html">Postings</a>
         <a href="https://external.example.test/trap">External</a></body></html>`,
      ],
      [
        "https://docs.example.test/auth.html",
        `<html><body><h1>Authentication</h1><p>Use Client-Id and Api-Key headers.</p>
         <a href="/postings.html">Postings duplicate link</a></body></html>`,
      ],
      [
        "https://docs.example.test/postings.html",
        `<html><body><h1>FBS postings list</h1>
         <p>POST /v3/posting/fbs/list returns current postings.</p></body></html>`,
      ],
    ]);
    const fetched: string[] = [];
    const observed: string[] = [];

    const result = await crawlDocumentation(source, {
      maxPages: 10,
      fetchPage: async (url) => {
        fetched.push(url);
        const body = pages.get(url);
        if (body === undefined) throw new Error(`Unexpected URL: ${url}`);
        return { url, contentType: "text/html", body };
      },
      repository: docs,
      observePage: (page) => observed.push(page.url),
    });

    expect(result.pageCount).toBe(3);
    expect(fetched).toEqual([
      "https://docs.example.test/index.html",
      "https://docs.example.test/auth.html",
      "https://docs.example.test/postings.html",
    ]);
    expect(fetched).not.toContain("https://external.example.test/trap");
    expect(observed).toEqual(fetched);
    expect(observed).not.toContain("https://external.example.test/trap");

    const matches = docs.search(source.id, "posting fbs list", 5);
    expect(matches[0]).toMatchObject({
      pageUrl: "https://docs.example.test/postings.html",
    });
    expect(matches[0]?.body).toContain("/v3/posting/fbs/list");
    expect(connections.getDocumentationSource(source.id).status).toBe("ready");
  });

  it("validates a fetched page's final origin before exposing it to the observer", async () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/",
      allowedOrigin: "https://docs.example.test",
    });
    const observed: string[] = [];

    await expect(crawlDocumentation(source, {
      maxPages: 1,
      fetchPage: async () => ({
        url: "https://api.example.test/escaped",
        contentType: "text/plain",
        body: "curl https://api.example.test/private",
      }),
      repository: docs,
      observePage: (page) => observed.push(page.url),
    })).rejects.toThrow("escaped the approved origin");

    expect(observed).toEqual([]);
  });

  it("reports the total byte size of the fetched pages", async () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/",
      allowedOrigin: "https://docs.example.test",
    });
    const root = `<html><body><h1>Руководство</h1><a href="/next">Next</a></body></html>`;
    const next = `<html><body><h1>Next</h1><p>Body</p></body></html>`;

    const result = await crawlDocumentation(source, {
      maxPages: 5,
      fetchPage: async (url) => ({
        url,
        contentType: "text/html",
        body: url === "https://docs.example.test/" ? root : next,
      }),
      repository: docs,
    });

    expect(result.pageCount).toBe(2);
    expect(result.byteSize).toBe(Buffer.byteLength(root) + Buffer.byteLength(next));
    expect(result.byteSize).toBeGreaterThan(root.length + next.length);
  });

  it("fails when the root page cannot be fetched", async () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/",
      allowedOrigin: "https://docs.example.test",
    });

    await expect(crawlDocumentation(source, {
      maxPages: 5,
      fetchPage: async () => { throw new Error("HTTP 498"); },
      repository: docs,
    })).rejects.toThrow("HTTP 498");

    expect(connections.getDocumentationSource(source.id)).toMatchObject({ status: "failed", errorCategory: "crawl" });
  });

  it("skips a linked page that cannot be fetched and keeps crawling the rest", async () => {
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/",
      allowedOrigin: "https://docs.example.test",
    });
    const fetched: string[] = [];
    const observed: string[] = [];

    const result = await crawlDocumentation(source, {
      maxPages: 5,
      fetchPage: async (url) => {
        fetched.push(url);
        if (url === "https://docs.example.test/gone") throw new Error("HTTP 404");
        const body = url === "https://docs.example.test/"
          ? `<html><body><h1>Docs</h1><a href="/gone">Gone</a><a href="/ok">Ok</a></body></html>`
          : `<html><body><h1>Ok</h1><p>GET /orders</p></body></html>`;
        return { url, contentType: "text/html", body };
      },
      repository: docs,
      observePage: (page) => observed.push(page.url),
    });

    expect(fetched).toEqual([
      "https://docs.example.test/",
      "https://docs.example.test/gone",
      "https://docs.example.test/ok",
    ]);
    expect(observed).toEqual(["https://docs.example.test/", "https://docs.example.test/ok"]);
    expect(result.pageCount).toBe(2);
    expect(connections.getDocumentationSource(source.id).status).toBe("ready");
  });
});

describe("HTML text extraction", () => {
  const extract = (body: string) =>
    splitIntoChunks({ url: "https://docs.shop.test/guide", contentType: "text/html", body }).chunks
      .map(({ heading, body: text }) => ({ heading, body: text }));

  it("keeps the text, heading, and hidden-element rules for ordinary HTML", () => {
    expect(extract(`<!doctype html><html><head><title>Shop &amp; Co</title><style>body { color: red; }</style><script type="module">const a = "<h1>fake</h1>";</script></head><body><nav><a href="/x">Home</a></nav><H2 class="t">Orders <em>API</em> &amp; more</H2><p>Use a &lt;token&gt; with curl &quot;-H&quot; when 1 < 2 and 3 > 2.</p><noscript>Enable JS</noscript><SCRIPT>track()</SCRIPT><h1>Second</h1><pre>GET /orders</pre>&nbsp;&#39;done&#39;</body></html>`))
      .toEqual([{ heading: "fake", body: "Shop & Co Home Orders API & more Use a <token> with curl \"-H\" when 1 2. Second GET /orders 'done'" }]);
    expect(extract("<html><body><p>No heading here, just <b>bold</b> text &amp; a stray <> pair and an unclosed <script> tag</p></body></html>"))
      .toEqual([{ heading: "/guide", body: "No heading here, just bold text & a stray <> pair and an unclosed tag" }]);
    expect(extract("<html><body><h3>Unclosed heading<p>text</p><style>a{}</style></body></html>"))
      .toEqual([{ heading: "/guide", body: "Unclosed heading text" }]);
  });

  it.each([
    ["unclosed <", "<".repeat(1_000_000)],
    ["repeated <script", "<script ".repeat(125_000)],
    ["repeated <h1", "<h1 ".repeat(250_000)],
    ["repeated <script> without a closing tag", "<script>".repeat(125_000)],
    ["repeated <h1> without a closing tag", "<h1>".repeat(250_000)],
  ])("processes about 1 MB of %s in well under a second", (_, hostile) => {
    const body = `<html><body><h1>x</h1><p>${"a".repeat(300)}</p>${hostile}`;
    const started = performance.now();
    splitIntoChunks({ url: "https://docs.shop.test/p", contentType: "text/html", body });
    new DiscoveryCollector().observe({ url: "https://docs.shop.test/p", contentType: "text/html", body: hostile });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
