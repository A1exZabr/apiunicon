import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { AdapterDslSchema, type AdapterDsl } from "./schema.js";
import { sameRegistrableDomain } from "../discovery/domain.js";
import { NotFoundError } from "../domain/types.js";

export type AdapterStatus = "draft" | "working" | "failed";
export type AdapterVisibility = "private" | "reusable";

export type AdapterRecord = {
  id: string;
  slug: string;
  displayName: string;
  documentationSourceId: string;
  visibility: AdapterVisibility;
  status: AdapterStatus;
  version: number;
  dsl: AdapterDsl;
  documentationFingerprint: string | null;
  // Set on a copy of a shared catalog entry: which entry and which of its versions it was copied from.
  catalogEntryId: string | null;
  catalogVersion: number | null;
  createdAt: string;
  updatedAt: string;
};

type AdapterRow = {
  id: string;
  slug: string;
  display_name: string;
  documentation_source_id: string;
  visibility: AdapterVisibility;
  status: AdapterStatus;
  version: number;
  dsl_json: string;
  documentation_fingerprint: string | null;
  catalog_entry_id: string | null;
  catalog_version: number | null;
  created_at: string;
  updated_at: string;
};

export class VersionConflictError extends Error {
  constructor(id: string, expectedVersion: number) {
    super(`Adapter version conflict for ${id}; expected version ${expectedVersion}`);
    this.name = "VersionConflictError";
  }
}

// Only an adapter that works may be made reusable.
export class AdapterNotWorkingError extends Error {
  constructor() {
    super("Only a working adapter can be marked reusable");
    this.name = "AdapterNotWorkingError";
  }
}

function toRecord(row: AdapterRow): AdapterRecord {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    documentationSourceId: row.documentation_source_id,
    visibility: row.visibility,
    status: row.status,
    version: row.version,
    dsl: AdapterDslSchema.parse(JSON.parse(row.dsl_json)),
    documentationFingerprint: row.documentation_fingerprint,
    catalogEntryId: row.catalog_entry_id,
    catalogVersion: row.catalog_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AdapterRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: {
    slug: string;
    displayName: string;
    documentationSourceId: string;
    dsl: AdapterDsl;
    documentationFingerprint?: string;
  }): AdapterRecord {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const dsl = AdapterDslSchema.parse(input.dsl);
    this.db
      .prepare(
        `insert into adapters
          (id, slug, display_name, documentation_source_id, visibility, status, version,
           dsl_json, documentation_fingerprint, created_at, updated_at)
         values (?, ?, ?, ?, 'private', 'draft', 1, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.slug,
        input.displayName,
        input.documentationSourceId,
        JSON.stringify(dsl),
        input.documentationFingerprint ?? null,
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  // A shared catalog entry copied for one connection: private like any adapter built here, already working because the
  // catalog publishes only checked operations, and at version 1. Changing data stays off on the new connection until the
  // person turns it on. The slug gets a number when this database uses it.
  // Only ConnectionDiscoveryService.startFromCatalog calls it, after validateCatalogEntry: the DSL schema here is not
  // the whole check, which also needs the documentation link.
  createCatalogCopy(input: {
    slug: string;
    displayName: string;
    documentationSourceId: string;
    dsl: AdapterDsl;
    catalogEntryId: string;
    catalogVersion: number;
  }): AdapterRecord {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const dsl = AdapterDslSchema.parse(input.dsl);
    this.db
      .prepare(
        `insert into adapters
          (id, slug, display_name, documentation_source_id, visibility, status, version,
           dsl_json, documentation_fingerprint, catalog_entry_id, catalog_version, created_at, updated_at)
         values (?, ?, ?, ?, 'private', 'working', 1, ?, null, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.unusedSlug(input.slug),
        input.displayName,
        input.documentationSourceId,
        JSON.stringify(dsl),
        input.catalogEntryId,
        input.catalogVersion,
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  // The copy a catalog draft made for its documentation source.
  findCatalogCopy(documentationSourceId: string, catalogEntryId: string): AdapterRecord | null {
    const row = this.db.prepare(
      `select * from adapters where documentation_source_id = ? and catalog_entry_id = ?
       order by created_at desc, rowid desc limit 1`,
    ).get(documentationSourceId, catalogEntryId) as AdapterRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(id: string): AdapterRecord {
    const row = this.db.prepare("select * from adapters where id = ?").get(id) as
      | AdapterRow
      | undefined;
    if (!row) throw new NotFoundError("Adapter", id);
    return toRecord(row);
  }

  search(query: string): AdapterRecord[] {
    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const rows = this.db
      .prepare(
        `select * from adapters
         where slug like ? escape '\\' or display_name like ? escape '\\'
         order by case visibility when 'reusable' then 0 else 1 end, updated_at desc`,
      )
      .all(pattern, pattern) as AdapterRow[];
    return rows.map(toRecord);
  }

  findReusableMatch(input: { origins: string[]; credentialNames: string[] }): AdapterRecord | null {
    const expectedOrigins = [...input.origins].sort();
    const expectedCredentials = [...input.credentialNames].sort();
    const rows = this.db.prepare(
      `select * from adapters where status = 'working' and visibility = 'reusable'
       order by updated_at desc, rowid desc`,
    ).all() as AdapterRow[];
    for (const row of rows) {
      const adapter = toRecord(row);
      const origins = [...adapter.dsl.baseOrigins].sort();
      const credentials = adapter.dsl.credentialBindings.map(({ fieldName }) => fieldName).sort();
      if (
        origins.length === expectedOrigins.length &&
        credentials.length === expectedCredentials.length &&
        origins.every((origin, index) => origin === expectedOrigins[index]) &&
        credentials.every((fieldName, index) => fieldName === expectedCredentials[index])
      ) {
        return adapter;
      }
    }
    return null;
  }

  findReusableForDocumentation(linkUrl: string): AdapterRecord | null {
    const rows = this.db.prepare(
      `select a.*, s.root_url as source_root_url from adapters a
       join documentation_sources s on s.id = a.documentation_source_id
       where a.status = 'working' and a.visibility = 'reusable'
       order by a.updated_at desc, a.rowid desc`,
    ).all() as Array<AdapterRow & { source_root_url: string }>;
    const row = rows.find((candidate) => sameRegistrableDomain(candidate.source_root_url, linkUrl));
    return row ? toRecord(row) : null;
  }

  // A private draft copy of an adapter with an edited DSL, for one connection, when the adapter itself must stay as it was
  // reviewed: a reusable adapter, or one other connections share. It starts at version 1 under the next free slug and
  // carries nothing of the catalog, so the catalog's approval does not reach what changed. What was learned about the
  // original (its knowledge events) is copied with it; the original keeps its own, as well as its tests and audits.
  createEditedCopy(original: AdapterRecord, input: { documentationSourceId: string; dsl: AdapterDsl }): AdapterRecord {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    const dsl = AdapterDslSchema.parse(input.dsl);
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into adapters
            (id, slug, display_name, documentation_source_id, visibility, status, version,
             dsl_json, documentation_fingerprint, created_at, updated_at)
           values (?, ?, ?, ?, 'private', 'draft', 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          this.unusedSlug(original.slug),
          original.displayName,
          input.documentationSourceId,
          JSON.stringify(dsl),
          original.documentationFingerprint,
          timestamp,
          timestamp,
        );
      const learnings = this.db.prepare(
        `select operation_id, kind, finding_json, evidence_json, created_at from knowledge_events
         where adapter_id = ? order by created_at, rowid`,
      ).all(original.id) as Array<{ operation_id: string | null; kind: string; finding_json: string; evidence_json: string; created_at: string }>;
      const learn = this.db.prepare(
        `insert into knowledge_events (id, adapter_id, operation_id, kind, finding_json, evidence_json, created_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of learnings) {
        learn.run(randomUUID(), id, row.operation_id, row.kind, row.finding_json, row.evidence_json, row.created_at);
      }
    })();
    return this.get(id);
  }

  // A new definition in place, at the next version and a draft until a test passes. leaveCatalog is for a copy of a
  // catalog entry edited for its one connection: it stops being a copy of the entry, so nothing of the entry's is read
  // from it again. The approvals of reads its connection holds stay, each for its form, so only what changed waits.
  patch(id: string, expectedVersion: number, dslInput: AdapterDsl, options: { leaveCatalog?: boolean } = {}): AdapterRecord {
    const dsl = AdapterDslSchema.parse(dslInput);
    const catalog = options.leaveCatalog === true ? ", catalog_entry_id = null, catalog_version = null" : "";
    const result = this.db
      .prepare(
        `update adapters
         set dsl_json = ?, version = version + 1, status = 'draft', updated_at = ?${catalog}
         where id = ? and version = ?`,
      )
      .run(JSON.stringify(dsl), this.now().toISOString(), id, expectedVersion);
    if (result.changes === 0) this.raiseMutationFailure(id, expectedVersion);
    return this.get(id);
  }

  markWorking(id: string, expectedVersion: number): AdapterRecord {
    return this.transition(id, expectedVersion, "status = 'working'");
  }

  markReusable(id: string, expectedVersion: number): AdapterRecord {
    const current = this.get(id);
    if (current.status !== "working") throw new AdapterNotWorkingError();
    return this.transition(id, expectedVersion, "visibility = 'reusable'");
  }

  private transition(id: string, expectedVersion: number, assignment: string): AdapterRecord {
    const result = this.db
      .prepare(
        `update adapters set ${assignment}, version = version + 1, updated_at = ?
         where id = ? and version = ?`,
      )
      .run(this.now().toISOString(), id, expectedVersion);
    if (result.changes === 0) this.raiseMutationFailure(id, expectedVersion);
    return this.get(id);
  }

  private unusedSlug(base: string): string {
    const taken = (slug: string) => this.db.prepare("select 1 from adapters where slug = ?").get(slug) !== undefined;
    if (!taken(base)) return base;
    let suffix = 2;
    while (taken(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  private raiseMutationFailure(id: string, expectedVersion: number): never {
    const exists = this.db.prepare("select 1 from adapters where id = ?").get(id);
    if (!exists) throw new NotFoundError("Adapter", id);
    throw new VersionConflictError(id, expectedVersion);
  }
}
