import type Database from "better-sqlite3";

import { NotFoundError } from "../domain/types.js";

export type DocumentationChunkInput = {
  id: string;
  pageUrl: string;
  heading: string;
  body: string;
  contentHash: string;
};

export type DocumentationSearchResult = {
  id: string;
  sourceId: string;
  pageUrl: string;
  heading: string;
  body: string;
};

export class DocsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  replaceSourceChunks(
    sourceId: string,
    chunks: readonly DocumentationChunkInput[],
    contentFingerprint: string,
  ): void {
    this.db.transaction(() => {
      const oldIds = this.db
        .prepare("select id from documentation_chunks where source_id = ? and document_id is null")
        .all(sourceId) as Array<{ id: string }>;
      const deleteFts = this.db.prepare(
        "delete from documentation_chunks_fts where chunk_id = ?",
      );
      for (const { id } of oldIds) deleteFts.run(id);
      this.db.prepare("delete from documentation_chunks where source_id = ? and document_id is null").run(sourceId);

      const insertChunk = this.db.prepare(
        `insert or ignore into documentation_chunks
          (id, source_id, page_url, heading, body, content_hash)
         values (?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.db.prepare(
        `insert into documentation_chunks_fts (chunk_id, source_id, heading, body)
         values (?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        const inserted = insertChunk.run(
          chunk.id,
          sourceId,
          chunk.pageUrl,
          chunk.heading,
          chunk.body,
          chunk.contentHash,
        );
        if (inserted.changes === 1) insertFts.run(chunk.id, sourceId, chunk.heading, chunk.body);
      }
      this.db
        .prepare(
          `update documentation_sources
           set status = 'ready', content_fingerprint = ?, error_category = null, updated_at = ?
           where id = ?`,
        )
        .run(contentFingerprint, this.now().toISOString(), sourceId);
    })();
  }

  markCrawling(sourceId: string): void {
    this.setStatus(sourceId, "crawling", null);
  }

  markFailed(sourceId: string, category: string): void {
    this.setStatus(sourceId, "failed", category);
  }

  search(sourceId: string, query: string, limit: number): DocumentationSearchResult[] {
    const terms = query
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 20)
      .map((term) => `"${term.replaceAll('"', '""')}"*`);
    if (terms.length === 0) return [];
    return this.db
      .prepare(
        `select c.id, c.source_id as sourceId, c.page_url as pageUrl, c.heading, c.body
         from documentation_chunks_fts f
         join documentation_chunks c on c.id = f.chunk_id
         where documentation_chunks_fts match ? and f.source_id = ?
         order by bm25(documentation_chunks_fts)
         limit ?`,
      )
      .all(terms.join(" AND "), sourceId, limit) as DocumentationSearchResult[];
  }

  readChunk(id: string): DocumentationSearchResult {
    const row = this.db
      .prepare(
        `select id, source_id as sourceId, page_url as pageUrl, heading, body
         from documentation_chunks where id = ?`,
      )
      .get(id) as DocumentationSearchResult | undefined;
    if (!row) throw new NotFoundError("Documentation chunk", id);
    return row;
  }

  readChunkForSource(sourceId: string, id: string): DocumentationSearchResult {
    const row = this.readChunk(id);
    if (row.sourceId !== sourceId) throw new NotFoundError("Documentation chunk", id);
    return row;
  }

  private setStatus(sourceId: string, status: string, errorCategory: string | null): void {
    const result = this.db
      .prepare(
        `update documentation_sources set status = ?, error_category = ?, updated_at = ?
         where id = ?`,
      )
      .run(status, errorCategory, this.now().toISOString(), sourceId);
    if (result.changes === 0) throw new NotFoundError("Documentation source", sourceId);
  }
}
