import type Database from "better-sqlite3";

import type { AdapterRecord } from "./repository.js";

const EXCLUDED_EVIDENCE_KEY =
  /(?:account|customer|response.?body|request.?history|conversation|connection.?label|private.?url|credential|secret|token|password|cookie|authorization)/iu;

function sanitizeEvidence(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[excluded]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeEvidence(entry, depth + 1));
  if (!value || typeof value !== "object") return String(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (EXCLUDED_EVIDENCE_KEY.test(key)) continue;
    sanitized[key] = sanitizeEvidence(entry, depth + 1);
  }
  return sanitized;
}

export type ContributionPreview = {
  schemaVersion: 1;
  adapter: Pick<AdapterRecord, "slug" | "displayName" | "version" | "dsl" | "documentationFingerprint">;
  knowledgeEvents: Array<{
    operationId: string | null;
    kind: string;
    finding: unknown;
    evidence: unknown;
  }>;
  testOutcomes: Array<{
    operationId: string;
    adapterVersion: number;
    outcome: "success" | "failure";
    httpStatus: number | null;
    errorCategory: string | null;
  }>;
};

export function contributionPreview(db: Database.Database, adapter: AdapterRecord): ContributionPreview {
  const knowledgeRows = db.prepare(
    `select operation_id, kind, finding_json, evidence_json
     from knowledge_events where adapter_id = ? order by created_at, rowid`,
  ).all(adapter.id) as Array<{
    operation_id: string | null;
    kind: string;
    finding_json: string;
    evidence_json: string;
  }>;
  const testRows = db.prepare(
    `select operation_id, adapter_version, outcome, http_status, error_category
     from adapter_test_outcomes where adapter_id = ? order by created_at, rowid`,
  ).all(adapter.id) as Array<{
    operation_id: string;
    adapter_version: number;
    outcome: "success" | "failure";
    http_status: number | null;
    error_category: string | null;
  }>;
  return {
    schemaVersion: 1,
    adapter: {
      slug: adapter.slug,
      displayName: adapter.displayName,
      version: adapter.version,
      dsl: adapter.dsl,
      documentationFingerprint: adapter.documentationFingerprint,
    },
    knowledgeEvents: knowledgeRows.map((row) => ({
      operationId: row.operation_id,
      kind: row.kind,
      finding: sanitizeEvidence(JSON.parse(row.finding_json)),
      evidence: sanitizeEvidence(JSON.parse(row.evidence_json)),
    })),
    testOutcomes: testRows.map((row) => ({
      operationId: row.operation_id,
      adapterVersion: row.adapter_version,
      outcome: row.outcome,
      httpStatus: row.http_status,
      errorCategory: row.error_category,
    })),
  };
}
