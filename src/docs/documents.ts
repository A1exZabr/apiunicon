import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { DiscoveryResultSchema, type DiscoveryResult } from "../discovery/schema.js";
import { NotFoundError } from "../domain/types.js";
import type { DocumentationChunkInput } from "./repository.js";

export type DocumentKind = "html" | "openapi" | "postman" | "text";
export type DocumentProvenance = "official" | "third_party" | "model_content";

export type DocumentRecord = {
  id: string;
  sourceId: string;
  url: string;
  kind: DocumentKind;
  provenance: DocumentProvenance;
  sha256: string;
  byteSize: number;
  discovery: DiscoveryResult;
  fetchedAt: string;
};

export type DocumentInput = Omit<DocumentRecord, "id" | "fetchedAt"> & {
  chunks: readonly DocumentationChunkInput[];
};

// Documents the crawl stores itself stop at maxCrawlDocuments, so the AI always has room left for the
// documents it finds when the crawl could not.
export const DOCUMENT_LIMITS = { maxDocuments: 30, maxCrawlDocuments: 20, maxTotalBytes: 25 * 1024 * 1024 } as const;

export class DocumentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentLimitError";
  }
}

type DocumentRow = {
  id: string;
  source_id: string;
  url: string;
  kind: DocumentKind;
  provenance: DocumentProvenance;
  sha256: string;
  byte_size: number;
  discovery_json: string;
  fetched_at: string;
};

function toRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    url: row.url,
    kind: row.kind,
    provenance: row.provenance,
    sha256: row.sha256,
    byteSize: row.byte_size,
    discovery: DiscoveryResultSchema.parse(JSON.parse(row.discovery_json)),
    fetchedAt: row.fetched_at,
  };
}

export class DocumentRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  add(
    input: DocumentInput,
    maxDocuments: number = DOCUMENT_LIMITS.maxDocuments,
  ): { document: DocumentRecord; duplicate: boolean } {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("select * from documentation_documents where source_id = ? and sha256 = ?")
        .get(input.sourceId, input.sha256) as DocumentRow | undefined;
      if (existing) return { document: toRecord(existing), duplicate: true };
      const totals = this.db
        .prepare("select count(*) as count, coalesce(sum(byte_size), 0) as bytes from documentation_documents where source_id = ?")
        .get(input.sourceId) as { count: number; bytes: number };
      if (totals.count >= maxDocuments) {
        throw new DocumentLimitError(`At most ${maxDocuments} documents per connection`);
      }
      if (totals.bytes + input.byteSize > DOCUMENT_LIMITS.maxTotalBytes) {
        throw new DocumentLimitError(
          `Documentation for one connection may not exceed ${DOCUMENT_LIMITS.maxTotalBytes / 1024 / 1024} MB`,
        );
      }
      const id = randomUUID();
      const fetchedAt = this.now().toISOString();
      this.db.prepare(
        `insert into documentation_documents
          (id, source_id, url, kind, provenance, sha256, byte_size, discovery_json, fetched_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.sourceId,
        input.url,
        input.kind,
        input.provenance,
        input.sha256,
        input.byteSize,
        JSON.stringify(DiscoveryResultSchema.parse(input.discovery)),
        fetchedAt,
      );
      const insertChunk = this.db.prepare(
        `insert or ignore into documentation_chunks
          (id, source_id, page_url, heading, body, content_hash, document_id)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare(
        "insert into documentation_chunks_fts (chunk_id, source_id, heading, body) values (?, ?, ?, ?)",
      );
      for (const chunk of input.chunks) {
        const inserted = insertChunk.run(
          chunk.id, input.sourceId, chunk.pageUrl, chunk.heading, chunk.body, chunk.contentHash, id,
        );
        if (inserted.changes === 1) insertFts.run(chunk.id, input.sourceId, chunk.heading, chunk.body);
      }
      this.db.prepare(
        "update documentation_sources set status = 'ready', error_category = null, updated_at = ? where id = ?",
      ).run(fetchedAt, input.sourceId);
      return { document: this.get(id), duplicate: false };
    })();
  }

  get(id: string): DocumentRecord {
    const row = this.db.prepare("select * from documentation_documents where id = ?").get(id) as DocumentRow | undefined;
    if (!row) throw new NotFoundError("Documentation document", id);
    return toRecord(row);
  }

  list(sourceId: string): DocumentRecord[] {
    return (this.db
      .prepare("select * from documentation_documents where source_id = ? order by fetched_at, rowid")
      .all(sourceId) as DocumentRow[]).map(toRecord);
  }
}
