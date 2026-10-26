import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { NotFoundError } from "../domain/types.js";

export type JobKind = "crawl_documentation";
export type JobStatus = "queued" | "running" | "succeeded" | "failed";

// A job interrupted this many times most likely brings the process down itself (for example hostile
// documentation that exhausts memory), so it fails instead of being requeued into a crash loop.
export const MAX_JOB_ATTEMPTS = 3;

export type JobRecord = {
  id: string;
  kind: JobKind;
  subjectId: string;
  status: JobStatus;
  attempts: number;
  errorCategory: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type JobRow = {
  id: string;
  kind: JobKind;
  subject_id: string;
  status: JobStatus;
  attempts: number;
  error_category: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    subjectId: row.subject_id,
    status: row.status,
    attempts: row.attempts,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class JobRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  enqueue(kind: JobKind, subjectId: string): JobRecord {
    const active = this.db
      .prepare(
        `select * from jobs where kind = ? and subject_id = ?
         and status in ('queued', 'running') order by rowid desc limit 1`,
      )
      .get(kind, subjectId) as JobRow | undefined;
    if (active) return toRecord(active);
    const id = randomUUID();
    this.db
      .prepare(
        `insert into jobs (id, kind, subject_id, status, attempts, created_at)
         values (?, ?, ?, 'queued', 0, ?)`,
      )
      .run(id, kind, subjectId, this.now().toISOString());
    return this.get(id);
  }

  get(id: string): JobRecord {
    const row = this.db.prepare("select * from jobs where id = ?").get(id) as
      | JobRow
      | undefined;
    if (!row) throw new NotFoundError("Job", id);
    return toRecord(row);
  }

  latest(kind: JobKind, subjectId: string): JobRecord | null {
    const row = this.db
      .prepare(
        "select * from jobs where kind = ? and subject_id = ? order by rowid desc limit 1",
      )
      .get(kind, subjectId) as JobRow | undefined;
    return row ? toRecord(row) : null;
  }

  claimNext(): JobRecord | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare("select id from jobs where status = 'queued' order by rowid limit 1")
        .get() as { id: string } | undefined;
      if (!row) return null;
      const result = this.db
        .prepare(
          `update jobs set status = 'running', attempts = attempts + 1,
           started_at = ?, finished_at = null, error_category = null
           where id = ? and status = 'queued'`,
        )
        .run(this.now().toISOString(), row.id);
      return result.changes === 1 ? this.get(row.id) : null;
    })();
  }

  succeed(id: string): JobRecord {
    this.transition(id, "succeeded", null);
    return this.get(id);
  }

  fail(id: string, category: string): JobRecord {
    this.transition(id, "failed", category);
    return this.get(id);
  }

  // Fails the interrupted jobs that already used every attempt and returns them.
  failExhausted(): JobRecord[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare("select id from jobs where status = 'running' and attempts >= ? order by rowid")
        .all(MAX_JOB_ATTEMPTS) as Array<{ id: string }>;
      for (const { id } of rows) this.transition(id, "failed", "interrupted");
      return rows.map(({ id }) => this.get(id));
    })();
  }

  requeueInterrupted(): number {
    return this.db.transaction(() => {
      this.failExhausted();
      return this.db
        .prepare(
          `update jobs set status = 'queued', error_category = null,
           started_at = null, finished_at = null where status = 'running'`,
        )
        .run().changes;
    })();
  }

  private transition(id: string, status: "succeeded" | "failed", category: string | null): void {
    const result = this.db
      .prepare(
        `update jobs set status = ?, error_category = ?, finished_at = ?
         where id = ? and status = 'running'`,
      )
      .run(status, category, this.now().toISOString(), id);
    if (result.changes === 0) throw new Error(`Job ${id} is not running`);
  }
}
