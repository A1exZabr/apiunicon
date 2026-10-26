import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { canonicalJson } from "../adapters/canonical.js";
import type { AdapterRecord } from "../adapters/repository.js";
import { readsThroughPost } from "../adapters/risk.js";
import { AdapterDslSchema, type AdapterDsl, type AdapterOperation } from "../adapters/schema.js";

// Who let an operation run as a read: the person on the approval page, or the shared catalog's moderation for an
// operation of a catalog copy exactly as the entry published it.
export type ReadApprovalSource = "person" | "catalog";

// The form a read is approved in: the operation as the adapter describes it (method, path, inputs, label and
// description) and the host it is sent to, in the canonical JSON the trust rule of changes compares. Any edit of the
// operation makes another form, which needs approving again. Only its SHA-256 is stored.
export function readForm(dsl: Pick<AdapterDsl, "baseOrigins">, operation: AdapterOperation): string {
  const origin = operation.origin ?? dsl.baseOrigins[0] ?? null;
  return createHash("sha256").update(canonicalJson({ origin, operation })).digest("hex");
}

// The reads sent with POST that a catalog copy brings approved by the catalog's moderation: those of a copy still at
// version 1, whose operations are the entry's as published. Every edit of an adapter raises its version, and the
// original forms of a copy edited since are not kept, so none of its reads come approved.
export function catalogApprovedForms(adapter: Pick<AdapterRecord, "catalogEntryId" | "version" | "dsl">): string[] {
  if (adapter.catalogEntryId === null || adapter.version !== 1) return [];
  return adapter.dsl.operations.filter(readsThroughPost).map((operation) => readForm(adapter.dsl, operation));
}

// Approvals of reads sent with POST, each for one connection and one form. An approval for one connection never
// applies to another, and one for a form never to an edited operation.
export class ReadApprovalRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Whether this operation, as the adapter describes it now, is approved as a read for the connection.
  approves(connectionId: string, dsl: Pick<AdapterDsl, "baseOrigins">, operation: AdapterOperation): boolean {
    return this.db.prepare("select 1 from read_approvals where connection_id = ? and form_hash = ?")
      .get(connectionId, readForm(dsl, operation)) !== undefined;
  }

  // The forms approved for the connection, by anyone.
  approvedForms(connectionId: string): Set<string> {
    const rows = this.db.prepare("select form_hash from read_approvals where connection_id = ?").all(connectionId) as Array<{
      form_hash: string;
    }>;
    return new Set(rows.map(({ form_hash }) => form_hash));
  }

  // A form approved already keeps its first approval and its source.
  record(connectionId: string, forms: readonly string[], source: ReadApprovalSource): void {
    const insert = this.db.prepare(
      `insert into read_approvals (connection_id, form_hash, source, approved_at) values (?, ?, ?, ?)
       on conflict (connection_id, form_hash) do nothing`,
    );
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      for (const form of forms) insert.run(connectionId, form, source, timestamp);
    })();
  }
}

// Part of the migration that creates read_approvals, run once with it: a connection already bound to an unmodified
// catalog copy gets the catalog's approval of its reads, as a connection made from a copy gets it now. A copy whose
// stored adapter cannot be read gets none, and the person approves its reads.
export function approveExistingCatalogCopies(db: Database.Database, now: Date): void {
  const rows = db.prepare(
    `select c.id as connection_id, a.dsl_json, a.catalog_entry_id, a.version from connections c
     join adapters a on a.id = c.adapter_id
     where a.catalog_entry_id is not null and a.version = 1`,
  ).all() as Array<{ connection_id: string; dsl_json: string; catalog_entry_id: string; version: number }>;
  const repository = new ReadApprovalRepository(db, () => now);
  for (const row of rows) {
    let forms: string[];
    try {
      const dsl = AdapterDslSchema.parse(JSON.parse(row.dsl_json));
      forms = catalogApprovedForms({ catalogEntryId: row.catalog_entry_id, version: row.version, dsl });
    } catch {
      continue;
    }
    repository.record(row.connection_id, forms, "catalog");
  }
}
