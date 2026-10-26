import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { HttpsOriginSchema } from "../adapters/schema.js";
import { InputError, NotFoundError } from "../domain/types.js";
import {
  CredentialCandidateSchema,
  type CredentialCandidate,
  type DiscoveryResult,
  DiscoveryResultSchema,
  emptyDiscoveryResult,
  ProvenanceSummarySchema,
  type ProvenanceSummary,
} from "./schema.js";

export type ConnectionDraftStatus =
  | "discovering"
  | "needs_review"
  | "needs_help"
  | "ready"
  | "failed"
  | "completed";

export type HelpReason = "documentation_unavailable" | "unsupported_auth";

export type ConnectionDraftRecord = {
  id: string;
  documentationSourceId: string;
  status: ConnectionDraftStatus;
  helpReason: HelpReason | null;
  serviceName: string | null;
  suggestedLabel: string | null;
  discovery: DiscoveryResult;
  selectedOrigins: string[] | null;
  selectedCredentials: CredentialCandidate[] | null;
  errorCategory: string | null;
  provenanceSummary: ProvenanceSummary | null;
  completedConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
};

type DraftRow = {
  id: string;
  documentation_source_id: string;
  status: ConnectionDraftStatus;
  help_reason: HelpReason | null;
  service_name: string | null;
  suggested_label: string | null;
  discovery_json: string;
  selected_origins_json: string | null;
  selected_credentials_json: string | null;
  error_category: string | null;
  provenance_summary_json: string | null;
  completed_connection_id: string | null;
  created_at: string;
  updated_at: string;
};

const SelectedOriginsSchema = z.array(HttpsOriginSchema).min(1).max(40);
const SelectedCredentialsSchema = z.array(CredentialCandidateSchema).min(1).max(20);
const CredentialNameSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/u);

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Stored ${label} is invalid JSON`);
  }
}

function candidateId(prefix: string, value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return `${prefix}-${normalized}`.slice(0, 80).padEnd(8, "0");
}

// Unsupported methods stop a draft only when no supported header credential was found. When the service
// also accepts such a credential, setup proceeds and the methods stay in the result for information.
function classify(result: DiscoveryResult): { status: ConnectionDraftStatus; helpReason: HelpReason | null } {
  if (result.credentials.length === 0 && result.unsupportedAuthMethods.length > 0) {
    return { status: "needs_help", helpReason: "unsupported_auth" };
  }
  if (result.origins.length > 0 && result.credentials.length > 0) return { status: "needs_review", helpReason: null };
  return { status: "needs_help", helpReason: "documentation_unavailable" };
}

function toRecord(row: DraftRow): ConnectionDraftRecord {
  return {
    id: row.id,
    documentationSourceId: row.documentation_source_id,
    status: row.status,
    helpReason: row.help_reason,
    serviceName: row.service_name,
    suggestedLabel: row.suggested_label,
    discovery: DiscoveryResultSchema.parse(parseJson(row.discovery_json, "draft discovery")),
    selectedOrigins: row.selected_origins_json === null
      ? null
      : SelectedOriginsSchema.parse(parseJson(row.selected_origins_json, "selected origins")),
    selectedCredentials: row.selected_credentials_json === null
      ? null
      : SelectedCredentialsSchema.parse(parseJson(row.selected_credentials_json, "selected credentials")),
    errorCategory: row.error_category,
    provenanceSummary: row.provenance_summary_json === null
      ? null
      : ProvenanceSummarySchema.parse(parseJson(row.provenance_summary_json, "provenance summary")),
    completedConnectionId: row.completed_connection_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ConnectionDraftRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: { documentationSourceId: string }): ConnectionDraftRecord {
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db.prepare(
      `insert into connection_drafts
       (id, documentation_source_id, status, discovery_json, created_at, updated_at)
       values (?, ?, 'discovering', ?, ?, ?)`,
    ).run(id, input.documentationSourceId, JSON.stringify(emptyDiscoveryResult()), timestamp, timestamp);
    return this.get(id);
  }

  get(id: string): ConnectionDraftRecord {
    const row = this.db.prepare("select * from connection_drafts where id = ?").get(id) as DraftRow | undefined;
    if (!row) throw new NotFoundError("Connection draft", id);
    return toRecord(row);
  }

  findByDocumentationSource(sourceId: string): ConnectionDraftRecord | null {
    const row = this.db.prepare("select * from connection_drafts where documentation_source_id = ?").get(sourceId) as
      | DraftRow
      | undefined;
    return row ? toRecord(row) : null;
  }

  recordDiscovery(id: string, result: DiscoveryResult): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "discovering") throw new Error("Draft must be discovering before recording discovery");
    const validated = DiscoveryResultSchema.parse(result);
    const { status, helpReason } = classify(validated);
    this.db.prepare(
      `update connection_drafts set status = ?, help_reason = ?, service_name = ?, suggested_label = ?,
       discovery_json = ?, selected_origins_json = null, selected_credentials_json = null,
       error_category = null, updated_at = ? where id = ?`,
    ).run(status, helpReason, validated.serviceName, validated.suggestedLabel, JSON.stringify(validated), this.now().toISOString(), id);
    return this.get(id);
  }

  refreshDiscovery(id: string, result: DiscoveryResult, summary: ProvenanceSummary): ConnectionDraftRecord {
    const current = this.get(id);
    if (!["discovering", "needs_help", "needs_review", "ready"].includes(current.status)) {
      throw new Error("Only an open draft can receive new documentation");
    }
    const validated = DiscoveryResultSchema.parse(result);
    const validatedSummary = ProvenanceSummarySchema.parse(summary);
    const { status, helpReason } = classify(validated);
    this.db.transaction(() => {
      // The copy a catalog draft made exists only to be bound when its keys are entered. Once other documentation
      // replaces the catalog as the draft's origin nothing would bind it, so it goes now and frees its short name
      // instead of staying tied to the documentation for good.
      if (current.provenanceSummary?.kind === "catalog" && validatedSummary.kind !== "catalog") {
        this.db.prepare(
          `delete from adapters where documentation_source_id = ? and catalog_entry_id is not null
           and not exists (select 1 from connections where adapter_id = adapters.id)`,
        ).run(current.documentationSourceId);
      }
      this.db.prepare(
        `update connection_drafts set status = ?, help_reason = ?, service_name = ?, suggested_label = ?,
         discovery_json = ?, provenance_summary_json = ?, selected_origins_json = null,
         selected_credentials_json = null, error_category = null, updated_at = ? where id = ?`,
      ).run(
        status,
        helpReason,
        validated.serviceName,
        validated.suggestedLabel,
        JSON.stringify(validated),
        JSON.stringify(validatedSummary),
        this.now().toISOString(),
        id,
      );
    })();
    return this.get(id);
  }

  markDocumentationUnavailable(id: string): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "discovering") throw new Error("Only a discovering draft can lose its documentation");
    this.db.prepare(
      `update connection_drafts set status = 'needs_help', help_reason = 'documentation_unavailable',
       error_category = null, updated_at = ? where id = ?`,
    ).run(this.now().toISOString(), id);
    return this.get(id);
  }

  // The chat setup that produced a connection; its key-entry link is reused to replace the connection's keys.
  findCompletedForConnection(connectionId: string): ConnectionDraftRecord | null {
    const row = this.db.prepare(
      `select * from connection_drafts where completed_connection_id = ? and status = 'completed'
       order by updated_at desc, rowid desc limit 1`,
    ).get(connectionId) as DraftRow | undefined;
    return row ? toRecord(row) : null;
  }

  // A draft stopped by unsupported authentication is finished for the chat flow, so it is not resumed.
  findOpenByRootUrl(rootUrl: string): ConnectionDraftRecord | null {
    const row = this.db.prepare(
      `select d.* from connection_drafts d
       join documentation_sources s on s.id = d.documentation_source_id
       where s.root_url = ? and d.status in ('discovering', 'needs_review', 'needs_help', 'ready')
       and (d.status != 'needs_help' or d.help_reason is not 'unsupported_auth')
       order by d.created_at desc, d.rowid desc limit 1`,
    ).get(rootUrl) as DraftRow | undefined;
    return row ? toRecord(row) : null;
  }

  select(id: string, input: { originIds: string[]; credentialIds: string[] }): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "needs_review") throw new Error("Draft must need review before selecting candidates");
    if (new Set(input.originIds).size !== input.originIds.length || new Set(input.credentialIds).size !== input.credentialIds.length) {
      throw new Error("Candidate IDs must be unique");
    }
    const originsById = new Map(current.discovery.origins.map((candidate) => [candidate.id, candidate]));
    const credentialsById = new Map(current.discovery.credentials.map((candidate) => [candidate.id, candidate]));
    const origins = input.originIds.map((candidateId) => {
      const candidate = originsById.get(candidateId);
      if (!candidate) throw new Error(`Unknown origin candidate: ${candidateId}`);
      return candidate.origin;
    });
    const credentials = input.credentialIds.map((candidateId) => {
      const candidate = credentialsById.get(candidateId);
      if (!candidate) throw new Error(`Unknown credential candidate: ${candidateId}`);
      return candidate;
    });
    this.storeSelection(id, origins, credentials, current.suggestedLabel);
    return this.get(id);
  }

  selectAdvanced(
    id: string,
    input: { origins: string[]; credentialNames: string[]; label?: string },
  ): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "needs_help" && current.status !== "needs_review") {
      throw new Error("Draft must need help or review before advanced selection");
    }
    const origins = SelectedOriginsSchema.parse(input.origins);
    const parsedNames = z.array(CredentialNameSchema).min(1).max(20).safeParse(input.credentialNames);
    if (!parsedNames.success) {
      throw new InputError("Enter 1 to 20 credential header names, each of letters, digits and hyphens only");
    }
    const names = parsedNames.data;
    if (new Set(origins).size !== origins.length || new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) {
      throw new InputError("Advanced selections must be unique");
    }
    const credentials = names.map((fieldName): CredentialCandidate => ({
      id: candidateId("credential", fieldName),
      fieldName,
      kind: "static_header",
      placement: "header",
      humanLabel: fieldName,
      confidence: "low",
      evidence: [{
        pageUrl: current.discovery.origins[0]?.evidence[0]?.pageUrl ??
          `https://${new URL(origins[0]!).hostname}/`,
        kind: "prose_label",
        excerpt: `${fieldName}: [value]`,
      }],
    }));
    this.storeSelection(id, origins, credentials, input.label ?? current.suggestedLabel);
    return this.get(id);
  }

  markFailed(id: string, category: string): ConnectionDraftRecord {
    this.get(id);
    if (!/^[a-z0-9_-]{1,80}$/u.test(category)) throw new Error("Invalid failure category");
    this.db.prepare(
      `update connection_drafts set status = 'failed', error_category = ?, updated_at = ? where id = ?`,
    ).run(category, this.now().toISOString(), id);
    return this.get(id);
  }

  resetForRetry(id: string): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "failed" && current.status !== "needs_help") {
      throw new Error("Only failed or unresolved drafts can be retried");
    }
    this.db.prepare(
      `update connection_drafts set status = 'discovering', service_name = null,
       suggested_label = null, discovery_json = ?, selected_origins_json = null,
       selected_credentials_json = null, error_category = null,
       help_reason = null, provenance_summary_json = null, updated_at = ? where id = ?`,
    ).run(JSON.stringify(emptyDiscoveryResult()), this.now().toISOString(), id);
    return this.get(id);
  }

  markCompleted(id: string, connectionId: string): ConnectionDraftRecord {
    const current = this.get(id);
    if (current.status !== "ready") throw new Error("Draft must be ready before completion");
    this.db.prepare(
      `update connection_drafts set status = 'completed', completed_connection_id = ?,
       updated_at = ? where id = ?`,
    ).run(connectionId, this.now().toISOString(), id);
    return this.get(id);
  }

  private storeSelection(
    id: string,
    origins: string[],
    credentials: CredentialCandidate[],
    label: string | null,
  ): void {
    const validatedOrigins = SelectedOriginsSchema.parse(origins);
    const validatedCredentials = SelectedCredentialsSchema.parse(credentials);
    const validatedLabel = label === null ? null : z.string().min(1).max(200).parse(label);
    this.db.prepare(
      `update connection_drafts set status = 'ready', suggested_label = ?,
       selected_origins_json = ?, selected_credentials_json = ?, error_category = null,
       updated_at = ? where id = ?`,
    ).run(
      validatedLabel,
      JSON.stringify(validatedOrigins),
      JSON.stringify(validatedCredentials),
      this.now().toISOString(),
      id,
    );
  }
}
