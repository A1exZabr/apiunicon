import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// Why an audited call failed. dns: the service's name could not be looked up. network: it was, but the request failed on
// the way: the connection was refused or reset, or the TLS handshake failed.
export type ErrorCategory =
  | "validation"
  | "policy"
  | "dns"
  | "network"
  | "timeout"
  | "upstream_http"
  | "response_limit"
  | "internal";

export type ExecutionAudit = {
  id: string;
  connectionId: string;
  adapterId: string;
  adapterVersion: number;
  operationId: string;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  outcome: "success" | "failure";
  errorCategory: ErrorCategory | null;
};

type AuditRow = {
  id: string;
  connection_id: string;
  adapter_id: string;
  adapter_version: number;
  operation_id: string;
  started_at: string;
  duration_ms: number;
  http_status: number | null;
  outcome: "success" | "failure";
  error_category: ErrorCategory | null;
};

function toRecord(row: AuditRow): ExecutionAudit {
  return {
    id: row.id,
    connectionId: row.connection_id,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    operationId: row.operation_id,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    httpStatus: row.http_status,
    outcome: row.outcome,
    errorCategory: row.error_category,
  };
}

export class AuditRepository {
  constructor(private readonly db: Database.Database) {}

  record(input: Omit<ExecutionAudit, "id">): ExecutionAudit {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into execution_audits
          (id, connection_id, adapter_id, adapter_version, operation_id, started_at,
           duration_ms, http_status, outcome, error_category)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectionId,
        input.adapterId,
        input.adapterVersion,
        input.operationId,
        input.startedAt,
        input.durationMs,
        input.httpStatus,
        input.outcome,
        input.errorCategory,
      );
    return { id, ...input };
  }

  recent(connectionId: string, limit: number): ExecutionAudit[] {
    const rows = this.db
      .prepare(
        `select * from execution_audits where connection_id = ?
         order by started_at desc, rowid desc limit ?`,
      )
      .all(connectionId, limit) as AuditRow[];
    return rows.map(toRecord);
  }
}
