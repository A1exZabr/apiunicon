import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConnectionRepository, type DocumentationSourceRecord } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { emptyDiscoveryResult } from "../../src/discovery/schema.js";
import { DOCUMENT_LIMITS, DocumentLimitError, DocumentRepository } from "../../src/docs/documents.js";
import { DocsRepository } from "../../src/docs/repository.js";

describe("DocumentRepository", () => {
  let db: Database.Database;
  let source: DocumentationSourceRecord;
  let documents: DocumentRepository;
  let docs: DocsRepository;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    source = new ConnectionRepository(db).createDocumentationSource({
      rootUrl: "https://docs.shop.test/api",
      allowedOrigin: "https://docs.shop.test",
    });
    documents = new DocumentRepository(db);
    docs = new DocsRepository(db);
  });

  afterEach(() => db.close());

  const input = (sha256: string, byteSize = 10) => ({
    sourceId: source.id,
    url: "https://docs.shop.test/openapi.yaml",
    kind: "openapi" as const,
    provenance: "official" as const,
    sha256,
    byteSize,
    discovery: emptyDiscoveryResult(),
    chunks: [{ id: crypto.randomUUID(), pageUrl: "https://docs.shop.test/openapi.yaml", heading: "GET /orders", body: "GET /orders lists orders", contentHash: sha256 }],
  });

  it("stores a document with searchable chunks and marks the source ready", () => {
    const { document, duplicate } = documents.add(input("a".repeat(64)));
    expect(duplicate).toBe(false);
    expect(documents.list(source.id)).toEqual([document]);
    expect(docs.search(source.id, "orders", 5)[0]?.heading).toBe("GET /orders");
    expect(new ConnectionRepository(db).getDocumentationSource(source.id).status).toBe("ready");
  });

  it("returns the existing document for identical content", () => {
    const first = documents.add(input("b".repeat(64))).document;
    expect(documents.add(input("b".repeat(64)))).toEqual({ document: first, duplicate: true });
  });

  it("enforces the per-connection count and size limits", () => {
    expect(() => documents.add(input("c".repeat(64), DOCUMENT_LIMITS.maxTotalBytes + 1))).toThrow(DocumentLimitError);
    for (let index = 0; index < DOCUMENT_LIMITS.maxDocuments; index += 1) {
      documents.add(input(index.toString(16).padStart(64, "0")));
    }
    expect(() => documents.add(input("d".repeat(64)))).toThrow(DocumentLimitError);
  });

  it("keeps document chunks when a crawl replaces its own chunks", () => {
    documents.add(input("e".repeat(64)));
    docs.replaceSourceChunks(source.id, [], "f".repeat(64));
    expect(docs.search(source.id, "orders", 5)).toHaveLength(1);
  });

  it("lets a crawl repeat a document chunk without a constraint error or a second search hit", () => {
    const { document } = documents.add(input("1".repeat(64)));
    const repeated = { id: crypto.randomUUID(), pageUrl: "https://docs.shop.test/api", heading: "GET /orders", body: "GET /orders lists orders", contentHash: "1".repeat(64) };
    expect(() => docs.replaceSourceChunks(source.id, [repeated], "2".repeat(64))).not.toThrow();
    const found = docs.search(source.id, "orders", 5);
    expect(found).toHaveLength(1);
    expect(found[0]?.id).not.toBe(repeated.id);
    expect(documents.get(document.id)).toEqual(document);
  });
});
