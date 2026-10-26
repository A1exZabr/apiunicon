import type Database from "better-sqlite3";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { effectiveRisk, type EffectiveRisk } from "../adapters/risk.js";
import type { AdapterOperation } from "../adapters/schema.js";
import { flushErasedData } from "../db/database.js";
import {
  MAX_CARD_TOKEN_INPUT, isCardToken, isLinkToken, newCardToken, newLinkToken, tokenHash,
} from "../security/one-time-token.js";

// How long the person has to decide after the assistant asks.
export const CHANGE_LINK_TTL_MS = 15 * 60_000;
// How long the service's answer to a change is kept after the change ended. The status stays in the journal.
export const CHANGE_RESULT_TTL_MS = 60 * 60_000;
// How long a change stays in the journal.
export const CHANGE_JOURNAL_MS = 365 * 86_400_000;
// A change still running this long after the request timeout is read as unknown: the process that ran it is gone.
export const CHANGE_RUNNING_GRACE_MS = 60_000;
// Wrong card tokens for one waiting change; the last of them stops it.
export const MAX_CARD_ATTEMPTS = 5;

// "expired" and a stuck "unknown" are never stored: reading derives them from the clock.
export type ChangeStatus = "pending" | "cancelled" | "expired" | "refused" | "running" | "succeeded" | "failed" | "unknown";
// card_attempts: too many wrong card tokens came for the change, and it was stopped.
export type ChangeReason =
  | "person" | "superseded" | "writes_off" | "plan" | "adapter_changed" | "limit" | "origin" | "card_attempts";
// How a change was let through: "person" waits for the person on its page, "card" was run by the person in the chat
// card, "none" ran at once because the person turned confirmation off. A deletion is always "person". Only "person"
// lets an operation run at once later with confirmation off: that standing permission is granted on the page alone.
export type ChangeConfirmation = "person" | "card" | "none";

export type ChangeRecord = {
  id: string;
  connectionId: string;
  connectionLabel: string;
  adapterId: string;
  adapterVersion: number;
  operationId: string;
  // The operation as the adapter described it when the assistant asked, so the person confirms what was asked.
  operation: AdapterOperation;
  risk: Exclude<EffectiveRisk, "read">;
  method: string;
  targetUrl: string;
  args: Record<string, unknown>;
  // The assistant's own words. Shown to the person as such, never as what will be sent.
  summary: string;
  requestedVia: string | null;
  confirmation: ChangeConfirmation;
  status: ChangeStatus;
  // 1 once the person passed the first of the two confirmations a destructive change needs.
  step: 0 | 1;
  reason: ChangeReason | null;
  httpStatus: number | null;
  errorCategory: string | null;
  // The service's sanitized answer, or { notice } when the usage gate stopped the change. Null an hour after the end.
  result: unknown | null;
  createdAt: string;
  expiresAt: string;
  // When the change left the waiting state: the person's decision, a refusal at the click, or the system cancelling it.
  decidedAt: string | null;
  // When a request that went out ended. Cancelled and refused-at-the-click changes have none.
  finishedAt: string | null;
};

export type NewChange = Pick<
  ChangeRecord,
  | "connectionId" | "connectionLabel" | "adapterId" | "adapterVersion" | "operationId" | "operation" | "risk" | "method"
  | "targetUrl" | "args" | "summary" | "requestedVia"
> & { confirmation?: "person" | "none" };

// What issue returns: the change, its link token and the chat card's token (null when no card shows the change).
export type IssuedChange<CardToken extends string | null> = { record: ChangeRecord; token: string; cardToken: CardToken };

// A token the chat card sent: valid for a change that waits for it, invalid otherwise, blocked when this wrong one was
// the last allowed and the change is now stopped.
export type CardCheck = { kind: "valid"; record: ChangeRecord } | { kind: "invalid" } | { kind: "blocked" };

// A refusal here is the host's or the switch's, found as the change was about to be sent: nothing was sent. The usage
// gate's own words, when it gave any, are kept as the notice.
export type ChangeOutcome =
  | { status: "succeeded" | "failed" | "unknown"; httpStatus: number | null; errorCategory: string | null; result: unknown | null }
  | { status: "refused"; reason: "limit" | "plan" | "writes_off"; notice?: string };

type ChangeRow = {
  id: string;
  token_hash: string;
  connection_id: string;
  connection_label: string;
  adapter_id: string;
  adapter_version: number;
  operation_id: string;
  operation_json: string;
  risk: ChangeRecord["risk"];
  method: string;
  target_url: string;
  args_json: string;
  summary: string;
  requested_via: string | null;
  confirmation: "person" | "none";
  card_token_hash: string | null;
  card_failures: number;
  via_card: 0 | 1;
  status: Exclude<ChangeStatus, "expired">;
  step: 0 | 1;
  reason: ChangeReason | null;
  http_status: number | null;
  error_category: string | null;
  result_json: string | null;
  result_expires_at: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  finished_at: string | null;
};

// What each way of letting a change through is in the stored columns. A card's confirmation is stored as the person's.
const LISTED: Record<ChangeConfirmation, string> = {
  person: "confirmation = 'person' and via_card = 0",
  card: "confirmation = 'person' and via_card = 1",
  none: "confirmation = 'none'",
};

// A deletion by the risk the caller gives, by what the stored operation is, or by the method that will be sent.
function deletes(change: Pick<ChangeRecord, "risk" | "operation" | "method">): boolean {
  return change.risk === "destructive" || effectiveRisk(change.operation) === "destructive" || change.method === "DELETE";
}

// Requests for the person to confirm a change to their data in a connected service. Only the hashes of the link token
// and of the chat card's token are stored. Every transition is one UPDATE that names the state it leaves, so of two
// concurrent decisions exactly one takes effect, and the answer is whether this call was the one. Every decision, by
// the link, the card or the system, revokes the card's token.
export class ChangeRequestRepository {
  private readonly now: () => Date;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly db: Database.Database,
    options: { now?: () => Date; requestTimeoutMs: number },
  ) {
    this.now = options.now ?? (() => new Date());
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  // Erases answers past their hour and journal entries older than a year on the way. A destructive change replaces the
  // connection's earlier waiting destructive one, so only the last link works, as with the link that deletes a
  // connection. Waiting writes are left alone. Returns the link token and the card's token once; neither can be read
  // back. A change without confirmation still gets both: the change service claims it with the link token at once,
  // which revokes the card's. A change asked for where no chat card shows it ({ card: false }) gets no card token at all:
  // none is made or stored, so nothing but its link can decide it.
  issue(change: NewChange): IssuedChange<string>;
  issue(change: NewChange, options: { card: boolean }): IssuedChange<string | null>;
  issue(change: NewChange, options: { card: boolean } = { card: true }): IssuedChange<string | null> {
    const confirmation = change.confirmation ?? "person";
    // Checked here too, so no caller can store a deletion that skips the person.
    if (confirmation === "none" && deletes(change)) {
      throw new Error("A deletion always needs the person's confirmation");
    }
    this.eraseExpiredResults();
    const created = this.now();
    const timestamp = created.toISOString();
    const id = randomUUID();
    const token = newLinkToken();
    const cardToken = options.card ? newCardToken() : null;
    const expiresAt = new Date(created.getTime() + CHANGE_LINK_TTL_MS).toISOString();
    const journalCutoff = new Date(created.getTime() - CHANGE_JOURNAL_MS).toISOString();
    const erasedJournal = this.db.transaction(() => {
      const erased = this.db.prepare("delete from change_requests where created_at < ?").run(journalCutoff).changes;
      if (change.risk === "destructive") {
        this.db.prepare(
          `update change_requests set status = 'cancelled', reason = 'superseded', decided_at = ?, card_token_hash = null
           where connection_id = ? and risk = 'destructive' and status = 'pending' and expires_at > ?`,
        ).run(timestamp, change.connectionId, timestamp);
      }
      this.db.prepare(
        `insert into change_requests
          (id, token_hash, connection_id, connection_label, adapter_id, adapter_version, operation_id, operation_json, risk,
           method, target_url, args_json, summary, requested_via, confirmation, status, step, created_at, expires_at,
           card_token_hash)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).run(
        id, tokenHash(token), change.connectionId, change.connectionLabel, change.adapterId, change.adapterVersion,
        change.operationId, JSON.stringify(change.operation), change.risk, change.method, change.targetUrl,
        JSON.stringify(change.args), change.summary, change.requestedVia, confirmation, timestamp, expiresAt,
        cardToken === null ? null : tokenHash(cardToken),
      );
      return erased > 0;
    })();
    if (erasedJournal) flushErasedData(this.db);
    return { record: this.toRecord(this.row(id)!, created), token, cardToken };
  }

  // The service's answer older than an hour is erased by this read, and the status stays.
  get(id: string): ChangeRecord | null {
    this.eraseExpiredResults();
    const row = this.row(id);
    return row ? this.toRecord(row, this.now()) : null;
  }

  // The change the link token belongs to, in any state. A token of the wrong shape or another change's matches nothing.
  byToken(id: string, token: string): ChangeRecord | null {
    if (!isLinkToken(token)) return null;
    this.eraseExpiredResults();
    const row = this.db.prepare("select * from change_requests where id = ? and token_hash = ?").get(id, tokenHash(token)) as
      | ChangeRow
      | undefined;
    return row ? this.toRecord(row, this.now()) : null;
  }

  // Changes that wait for the person and whose link still works.
  pendingCount(connectionId: string): number {
    const row = this.db.prepare(
      "select count(*) as n from change_requests where connection_id = ? and status = 'pending' and expires_at > ?",
    ).get(connectionId, this.now().toISOString()) as { n: number };
    return row.n;
  }

  // Every change requested for the connection in the last windowMs, in any state: waiting, replaced, cancelled, refused,
  // run or finished.
  issuedWithin(connectionId: string, windowMs: number): number {
    const since = new Date(this.now().getTime() - windowMs).toISOString();
    const row = this.db.prepare(
      "select count(*) as n from change_requests where connection_id = ? and created_at > ?",
    ).get(connectionId, since) as { n: number };
    return row.n;
  }

  // The first confirmation of a destructive change. A write has only one, so it never advances. The card's token is
  // revoked: it stands for step 0, and a deletion is decided on its page.
  advance(id: string, token: string): boolean {
    if (!isLinkToken(token)) return false;
    const result = this.db.prepare(
      `update change_requests set step = 1, card_token_hash = null
       where id = ? and token_hash = ? and status = 'pending' and expires_at > ? and risk = 'destructive' and step = 0`,
    ).run(id, tokenHash(token), this.now().toISOString());
    return result.changes === 1;
  }

  // Takes the right to send the request. Whoever gets true sends it; nobody else can. A destructive change can be
  // taken only at its second step, so a caller that forgets to advance it cannot delete in one click.
  claim(id: string, token: string, step: 0 | 1): boolean {
    if (!isLinkToken(token)) return false;
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(
      `update change_requests set status = 'running', decided_at = ?, card_token_hash = null
       where id = ? and token_hash = ? and status = 'pending' and expires_at > ? and step = ?
         and (risk = 'write' or step = 1)`,
    ).run(timestamp, id, tokenHash(token), timestamp, step);
    return result.changes === 1;
  }

  cancel(id: string, token: string): boolean {
    return this.leavePending(id, token, "cancelled", "person");
  }

  // The checks at the click did not let the change through. Nothing was sent. Cancelling has reasons of its own, and
  // only wrong card tokens stop a change for card_attempts.
  refuse(id: string, token: string, reason: Exclude<ChangeReason, "person" | "superseded" | "card_attempts">): boolean {
    return this.leavePending(id, token, "refused", reason);
  }

  // Checks a token the chat card sent, in constant time. A wrong one, of any shape, counts against a change that waits
  // with a live card token, and the MAX_CARD_ATTEMPTS-th stops it: refused, the card's token revoked, and the link no
  // longer decides anything either. A token for an unknown, decided or expired change, or one whose card token is
  // already gone, counts nothing, and neither does one over MAX_CARD_TOKEN_INPUT characters.
  verifyCard(id: string, cardToken: string): CardCheck {
    if (cardToken.length > MAX_CARD_TOKEN_INPUT) return { kind: "invalid" };
    const now = this.now();
    const timestamp = now.toISOString();
    const row = this.row(id);
    if (!row || row.status !== "pending" || row.expires_at <= timestamp || row.card_token_hash === null) {
      return { kind: "invalid" };
    }
    const given = Buffer.from(tokenHash(cardToken), "hex");
    const stored = Buffer.from(row.card_token_hash, "hex");
    if (given.length === stored.length && timingSafeEqual(given, stored)) return { kind: "valid", record: this.toRecord(row, now) };
    const blocked = this.db.transaction(() => {
      const counted = this.db.prepare(
        `update change_requests set card_failures = card_failures + 1
         where id = ? and status = 'pending' and expires_at > ? and card_token_hash is not null
         returning card_failures`,
      ).get(id, timestamp) as { card_failures: number } | undefined;
      if (counted === undefined || counted.card_failures < MAX_CARD_ATTEMPTS) return false;
      return this.db.prepare(
        `update change_requests set status = 'refused', reason = 'card_attempts', decided_at = ?, card_token_hash = null
         where id = ? and status = 'pending'`,
      ).run(timestamp, id).changes === 1;
    })();
    return blocked ? { kind: "blocked" } : { kind: "invalid" };
  }

  // The person cancelled in the chat card.
  cancelByCard(id: string, cardToken: string): boolean {
    return this.leavePendingByCard(id, cardToken, "cancelled", "person");
  }

  // The checks at the card's click did not let the change through. Nothing was sent.
  refuseByCard(id: string, cardToken: string, reason: Exclude<ChangeReason, "person" | "superseded" | "card_attempts">): boolean {
    return this.leavePendingByCard(id, cardToken, "refused", reason);
  }

  // Takes the right to send the request for the person's "Run" in the chat card, as claim does for the page's. Only a
  // write is ever taken this way: a deletion, by the stored risk, operation or method, is decided on its page alone.
  claimByCard(id: string, cardToken: string, step: 0 | 1): boolean {
    if (!isCardToken(cardToken)) return false;
    const row = this.row(id);
    // What is checked here never changes after the change is stored, so the UPDATE below cannot take anything else.
    if (!row || deletes({ risk: row.risk, operation: JSON.parse(row.operation_json) as AdapterOperation, method: row.method })) {
      return false;
    }
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(
      `update change_requests set status = 'running', decided_at = ?, card_token_hash = null, via_card = 1
       where id = ? and card_token_hash = ? and status = 'pending' and expires_at > ? and step = ? and risk = 'write'`,
    ).run(timestamp, id, tokenHash(cardToken), timestamp, step);
    return result.changes === 1;
  }

  // Records how the request ended, only for a change that is running; any other change is left as it is, so a
  // second call cannot rewrite the first outcome. The service's answer is kept an hour, then erased by a read.
  finish(id: string, outcome: ChangeOutcome): void {
    const ended = this.now();
    const timestamp = ended.toISOString();
    const answerExpiresAt = new Date(ended.getTime() + CHANGE_RESULT_TTL_MS).toISOString();
    if (outcome.status === "refused") {
      const notice = outcome.notice === undefined ? null : JSON.stringify({ notice: outcome.notice });
      this.db.prepare(
        `update change_requests
         set status = 'refused', reason = ?, http_status = null, error_category = null, result_json = ?,
             result_expires_at = ?, finished_at = ?
         where id = ? and status = 'running'`,
      ).run(outcome.reason, notice, notice === null ? null : answerExpiresAt, timestamp, id);
      return;
    }
    this.db.prepare(
      `update change_requests
       set status = ?, http_status = ?, error_category = ?, result_json = ?, result_expires_at = ?, finished_at = ?
       where id = ? and status = 'running'`,
    ).run(
      outcome.status, outcome.httpStatus, outcome.errorCategory,
      outcome.result === null || outcome.result === undefined ? null : JSON.stringify(outcome.result),
      answerExpiresAt, timestamp, id,
    );
  }

  // The person turned writes off for the connection: whatever still waits is cancelled. Returns how many.
  cancelPending(connectionId: string, reason: "writes_off"): number {
    const timestamp = this.now().toISOString();
    return this.db.prepare(
      `update change_requests set status = 'cancelled', reason = ?, decided_at = ?, card_token_hash = null
       where connection_id = ? and status = 'pending' and expires_at > ?`,
    ).run(reason, timestamp, connectionId, timestamp).changes;
  }

  // Newest first, of one connection, of one way of letting changes through, or both.
  list(options: { connectionId?: string; confirmation?: ChangeConfirmation; limit: number }): ChangeRecord[] {
    if (!Number.isInteger(options.limit)) throw new RangeError("The limit must be an integer");
    if (options.limit < 1) return [];
    this.eraseExpiredResults();
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (options.connectionId !== undefined) {
      conditions.push("connection_id = ?");
      values.push(options.connectionId);
    }
    if (options.confirmation !== undefined) {
      // A value from outside the type, at run time, lists nothing rather than reaching the SQL.
      if (!Object.hasOwn(LISTED, options.confirmation)) return [];
      conditions.push(LISTED[options.confirmation]);
    }
    const where = conditions.length === 0 ? "" : `where ${conditions.join(" and ")} `;
    const rows = this.db
      .prepare(`select * from change_requests ${where}order by created_at desc, rowid desc limit ?`)
      .all(...values, options.limit) as ChangeRow[];
    const now = this.now();
    return rows.map((row) => this.toRecord(row, now));
  }

  // The forms of an operation the person confirmed on its page for this connection and that succeeded, sent with this
  // method to this origin. Only these vouch for running the operation at once with confirmation off: a change that ran
  // without confirmation, failed or was cancelled shows nothing the person checked, and one run from the chat card
  // grants no standing permission, which is given on the page alone.
  confirmedForms(connectionId: string, operationId: string, method: string, origin: string): AdapterOperation[] {
    const prefix = `${origin}/`;
    const rows = this.db.prepare(
      `select distinct operation_json from change_requests
       where connection_id = ? and operation_id = ? and confirmation = 'person' and via_card = 0 and status = 'succeeded'
         and method = ? and substr(target_url, 1, ?) = ?`,
    ).all(connectionId, operationId, method, prefix.length, prefix) as Array<{ operation_json: string }>;
    return rows.map(({ operation_json }) => JSON.parse(operation_json) as AdapterOperation);
  }

  // The operations of the adapter that already ran and succeeded for this person, at this adapter version or later.
  succeededOperations(adapterId: string, minVersion: number): Set<string> {
    const rows = this.db.prepare(
      `select distinct operation_id from change_requests
       where adapter_id = ? and adapter_version >= ? and status = 'succeeded'`,
    ).all(adapterId, minVersion) as Array<{ operation_id: string }>;
    return new Set(rows.map(({ operation_id }) => operation_id));
  }

  private leavePending(id: string, token: string, status: "cancelled" | "refused", reason: ChangeReason): boolean {
    if (!isLinkToken(token)) return false;
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(
      `update change_requests set status = ?, reason = ?, decided_at = ?, card_token_hash = null
       where id = ? and token_hash = ? and status = 'pending' and expires_at > ?`,
    ).run(status, reason, timestamp, id, tokenHash(token), timestamp);
    return result.changes === 1;
  }

  private leavePendingByCard(id: string, cardToken: string, status: "cancelled" | "refused", reason: ChangeReason): boolean {
    if (!isCardToken(cardToken)) return false;
    const timestamp = this.now().toISOString();
    const result = this.db.prepare(
      `update change_requests set status = ?, reason = ?, decided_at = ?, card_token_hash = null
       where id = ? and card_token_hash = ? and status = 'pending' and expires_at > ?`,
    ).run(status, reason, timestamp, id, tokenHash(cardToken), timestamp);
    return result.changes === 1;
  }

  private row(id: string): ChangeRow | undefined {
    return this.db.prepare("select * from change_requests where id = ?").get(id) as ChangeRow | undefined;
  }

  // Erases the service's answers past their hour without anyone reading them. The change service runs it at startup.
  sweep(): void {
    this.eraseExpiredResults();
  }

  // The write lock is taken only when there is something to erase, because every read comes through here.
  private eraseExpiredResults(): void {
    const timestamp = this.now().toISOString();
    const due = this.db.prepare(
      "select 1 from change_requests where result_json is not null and result_expires_at <= ? limit 1",
    ).get(timestamp);
    if (due === undefined) return;
    this.db.prepare(
      "update change_requests set result_json = null where result_json is not null and result_expires_at <= ?",
    ).run(timestamp);
    flushErasedData(this.db);
  }

  private toRecord(row: ChangeRow, now: Date): ChangeRecord {
    const timestamp = now.toISOString();
    let status: ChangeStatus = row.status;
    if (row.status === "pending" && row.expires_at <= timestamp) {
      status = "expired";
    } else if (
      row.status === "running" &&
      Date.parse(row.decided_at ?? row.created_at) + this.requestTimeoutMs + CHANGE_RUNNING_GRACE_MS < now.getTime()
    ) {
      status = "unknown";
    }
    return {
      id: row.id,
      connectionId: row.connection_id,
      connectionLabel: row.connection_label,
      adapterId: row.adapter_id,
      adapterVersion: row.adapter_version,
      operationId: row.operation_id,
      operation: JSON.parse(row.operation_json) as AdapterOperation,
      risk: row.risk,
      method: row.method,
      targetUrl: row.target_url,
      args: JSON.parse(row.args_json) as Record<string, unknown>,
      summary: row.summary,
      requestedVia: row.requested_via,
      confirmation: row.via_card === 1 ? "card" : row.confirmation,
      status,
      step: row.step,
      reason: row.reason,
      httpStatus: row.http_status,
      errorCategory: row.error_category,
      result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      decidedAt: row.decided_at,
      finishedAt: row.finished_at,
    };
  }
}
