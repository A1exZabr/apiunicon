import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterOperation } from "../../src/adapters/schema.js";
import {
  CHANGE_JOURNAL_MS,
  CHANGE_LINK_TTL_MS,
  CHANGE_RESULT_TTL_MS,
  CHANGE_RUNNING_GRACE_MS,
  ChangeRequestRepository,
  MAX_CARD_ATTEMPTS,
  type ChangeConfirmation,
  type NewChange,
} from "../../src/changes/repository.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { Vault } from "../../src/vault/vault.js";

const START = new Date("2026-10-24T10:00:00.000Z");
const REQUEST_TIMEOUT_MS = 1_000;

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

const setPrice: AdapterOperation = {
  id: "set_price",
  description: "Set the price of a card",
  risk: "write",
  method: "POST",
  path: "/prices",
  input: {
    nmId: { type: "integer", location: "body", required: true, description: "Article" },
    price: { type: "integer", location: "body", required: true, description: "Price" },
  },
  documentationRefs: [],
};
const deleteCard: AdapterOperation = {
  id: "delete_card",
  description: "Delete a card",
  risk: "destructive",
  method: "DELETE",
  path: "/cards/{nmId}",
  input: { nmId: { type: "integer", location: "path", required: true } },
  documentationRefs: [],
};

describe("change requests", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function setup() {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrateDatabase(db);
    let current = START;
    const now = () => new Date(current);
    const connections = new ConnectionRepository(db, now);
    const vault = new Vault(db, Buffer.alloc(32, 5), now);
    const changes = new ChangeRequestRepository(db, { now, requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const source = connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    let counter = 0;
    const connect = (label: string) => {
      counter += 1;
      vault.storeFields(`credentials-${counter}`, { "X-Shop-Key": `shop-secret-${counter}` });
      return connections.createConnection({
        label, documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: `credentials-${counter}`,
      });
    };
    const wait = (ms: number) => {
      current = new Date(current.getTime() + ms);
    };
    const request = (connectionId: string, overrides: Partial<NewChange> = {}): NewChange => ({
      connectionId, connectionLabel: "Shop", adapterId: "adapter-1", adapterVersion: 3, operationId: setPrice.id, operation: setPrice,
      risk: "write", method: "POST", targetUrl: "https://api.shop.test/prices", args: { nmId: 123456789, price: 349 },
      summary: "Set the price to 349", requestedVia: "Claude", ...overrides,
    });
    const destructive = (connectionId: string): NewChange =>
      request(connectionId, {
        operationId: deleteCard.id, operation: deleteCard, risk: "destructive", method: "DELETE",
        targetUrl: "https://api.shop.test/cards/123456789", args: { nmId: 123456789 }, summary: "Delete the card",
      });
    const rows = () => db.prepare("select * from change_requests order by rowid").all() as Array<Record<string, unknown>>;
    return { db, connections, changes, connect, wait, request, destructive, rows, now };
  }

  it("keeps only the hash of the link token and finds the change by its token only", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const first = changes.issue(request(id));
    const second = changes.issue(request(id, { summary: "Another change" }));

    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.record).toMatchObject({
      status: "pending", step: 0, reason: null, connectionId: id, connectionLabel: "Shop", adapterId: "adapter-1", adapterVersion: 3,
      operationId: "set_price", risk: "write", method: "POST", targetUrl: "https://api.shop.test/prices",
      args: { nmId: 123456789, price: 349 }, summary: "Set the price to 349", requestedVia: "Claude",
      httpStatus: null, errorCategory: null, result: null, decidedAt: null, finishedAt: null,
      createdAt: START.toISOString(), expiresAt: new Date(START.getTime() + CHANGE_LINK_TTL_MS).toISOString(),
    });
    expect(first.record.operation).toEqual(setPrice);

    const stored = rows();
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(first.token);
    expect(JSON.stringify(stored)).not.toContain(second.token);
    expect(stored[0]?.token_hash).toBe(createHash("sha256").update(first.token).digest("hex"));

    expect(changes.byToken(first.record.id, first.token)).toEqual(first.record);
    expect(changes.byToken(first.record.id, second.token)).toBeNull();
    expect(changes.byToken(second.record.id, first.token)).toBeNull();
    expect(changes.byToken("unknown-id", first.token)).toBeNull();
    expect(changes.byToken(first.record.id, "short")).toBeNull();
    expect(changes.byToken(first.record.id, `${first.token}x`)).toBeNull();
    expect(changes.byToken(first.record.id, "!".repeat(43))).toBeNull();
    expect(changes.byToken(first.record.id, "")).toBeNull();
    expect(changes.get(first.record.id)).toEqual(first.record);
    expect(changes.get("unknown-id")).toBeNull();
  });

  it("finds a change by its token in any state", () => {
    const { changes, connect, request, wait } = setup();
    const { id } = connect("Shop");
    const lapsed = changes.issue(request(id));
    wait(CHANGE_LINK_TTL_MS + 1);
    const done = changes.issue(request(id));
    const cancelled = changes.issue(request(id));
    expect(changes.claim(done.record.id, done.token, 0)).toBe(true);
    expect(changes.cancel(cancelled.record.id, cancelled.token)).toBe(true);

    expect(changes.byToken(done.record.id, done.token)?.status).toBe("running");
    expect(changes.byToken(cancelled.record.id, cancelled.token)?.status).toBe("cancelled");
    expect(changes.byToken(lapsed.record.id, lapsed.token)?.status).toBe("expired");
  });

  it("lets one of two claims through and none after the link expired", () => {
    const { changes, connect, request, wait } = setup();
    const { id } = connect("Shop");
    const raced = changes.issue(request(id));
    const early = changes.issue(request(id));
    const late = changes.issue(request(id));

    expect(changes.claim(raced.record.id, raced.token, 0)).toBe(true);
    expect(changes.claim(raced.record.id, raced.token, 0)).toBe(false);
    expect(changes.get(raced.record.id)).toMatchObject({ status: "running", decidedAt: START.toISOString() });
    expect(changes.claim(raced.record.id, `${raced.token.slice(1)}A`, 0)).toBe(false);

    wait(CHANGE_LINK_TTL_MS - 1);
    expect(changes.claim(early.record.id, early.token, 0)).toBe(true);
    wait(2);
    expect(changes.claim(late.record.id, late.token, 0)).toBe(false);
    expect(changes.get(late.record.id)).toMatchObject({ status: "expired", decidedAt: null });
    expect(changes.cancel(late.record.id, late.token)).toBe(false);
    expect(changes.refuse(late.record.id, late.token, "plan")).toBe(false);
    expect(changes.get(late.record.id)?.status).toBe("expired");
  });

  it("advances a destructive change one step and never a write", () => {
    const { changes, connect, request, destructive, wait } = setup();
    const { id } = connect("Shop");
    const other = connect("Other");
    const write = changes.issue(request(id));
    const lapsed = changes.issue(destructive(other.id));
    const deletion = changes.issue(destructive(id));

    expect(changes.advance(write.record.id, write.token)).toBe(false);
    expect(changes.get(write.record.id)).toMatchObject({ status: "pending", step: 0 });
    expect(changes.claim(write.record.id, write.token, 1)).toBe(false);

    expect(changes.claim(deletion.record.id, deletion.token, 1)).toBe(false);
    expect(changes.claim(deletion.record.id, deletion.token, 0)).toBe(false);
    expect(changes.advance(deletion.record.id, `${deletion.token.slice(1)}A`)).toBe(false);
    expect(changes.advance(deletion.record.id, deletion.token)).toBe(true);
    expect(changes.get(deletion.record.id)).toMatchObject({ status: "pending", step: 1, decidedAt: null });
    expect(changes.advance(deletion.record.id, deletion.token)).toBe(false);
    expect(changes.claim(deletion.record.id, deletion.token, 0)).toBe(false);
    expect(changes.get(deletion.record.id)?.status).toBe("pending");
    expect(changes.claim(deletion.record.id, deletion.token, 1)).toBe(true);
    expect(changes.get(deletion.record.id)).toMatchObject({ status: "running", step: 1 });

    wait(CHANGE_LINK_TTL_MS + 1);
    expect(changes.advance(lapsed.record.id, lapsed.token)).toBe(false);
    expect(changes.get(lapsed.record.id)).toMatchObject({ status: "expired", step: 0 });
  });

  it("replaces a pending destructive change of the connection with the newer one", () => {
    const { changes, connect, request, destructive, wait } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const write = changes.issue(request(shop.id));
    const lapsed = changes.issue(destructive(shop.id));
    wait(CHANGE_LINK_TTL_MS + 1);
    const older = changes.issue(destructive(shop.id));
    const otherDeletion = changes.issue(destructive(other.id));
    const running = changes.issue(destructive(shop.id));
    expect(changes.get(older.record.id)).toMatchObject({ status: "cancelled", reason: "superseded", decidedAt: new Date(START.getTime() + CHANGE_LINK_TTL_MS + 1).toISOString() });
    expect(changes.advance(running.record.id, running.token)).toBe(true);
    expect(changes.claim(running.record.id, running.token, 1)).toBe(true);

    const newer = changes.issue(destructive(shop.id));
    const newestWrite = changes.issue(request(shop.id));

    expect(changes.get(running.record.id)?.status).toBe("running");
    expect(changes.get(newer.record.id)).toMatchObject({ status: "pending", reason: null });
    expect(changes.get(write.record.id)?.status).toBe("expired");
    expect(changes.get(lapsed.record.id)?.status).toBe("expired");
    expect(changes.get(otherDeletion.record.id)).toMatchObject({ status: "pending", reason: null });
    expect(changes.get(newestWrite.record.id)?.status).toBe("pending");

    const again = changes.issue(destructive(shop.id));
    expect(changes.get(newer.record.id)).toMatchObject({ status: "cancelled", reason: "superseded" });
    expect(changes.get(newestWrite.record.id)?.status).toBe("pending");
    expect(changes.get(again.record.id)?.status).toBe("pending");
  });

  it("leaves the pending writes of the connection alone when a newer change is requested", () => {
    const { changes, connect, request, destructive } = setup();
    const { id } = connect("Shop");
    const firstWrite = changes.issue(request(id));
    const secondWrite = changes.issue(request(id));
    const deletion = changes.issue(destructive(id));
    changes.issue(request(id));

    expect(changes.get(firstWrite.record.id)?.status).toBe("pending");
    expect(changes.get(secondWrite.record.id)?.status).toBe("pending");
    expect(changes.get(deletion.record.id)?.status).toBe("pending");
    expect(changes.pendingCount(id)).toBe(4);
  });

  it("reads a stale running change as unknown", () => {
    const { changes, connect, request, wait } = setup();
    const { id } = connect("Shop");
    const stale = changes.issue(request(id));
    const fresh = changes.issue(request(id));
    expect(changes.claim(stale.record.id, stale.token, 0)).toBe(true);
    wait(1_000);
    expect(changes.claim(fresh.record.id, fresh.token, 0)).toBe(true);

    wait(REQUEST_TIMEOUT_MS + CHANGE_RUNNING_GRACE_MS - 1_000);
    expect(changes.get(stale.record.id)?.status).toBe("running");
    wait(1);
    expect(changes.get(stale.record.id)).toMatchObject({ status: "unknown", httpStatus: null, result: null });
    expect(changes.get(fresh.record.id)?.status).toBe("running");
    expect(changes.list({ connectionId: id, limit: 10 }).map((record) => record.status)).toEqual(["running", "unknown"]);
    expect(changes.byToken(stale.record.id, stale.token)?.status).toBe("unknown");

    // A process that was only slow still records how the request ended.
    changes.finish(stale.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: { ok: true } });
    expect(changes.get(stale.record.id)).toMatchObject({ status: "succeeded", httpStatus: 200 });
  });

  it("erases the service's answer an hour after the change ended and journal entries after a year", () => {
    const { changes, connect, request, destructive, wait, rows } = setup();
    const { id } = connect("Shop");
    const answered = changes.issue(request(id));
    const refused = changes.issue(request(id));
    expect(changes.claim(answered.record.id, answered.token, 0)).toBe(true);
    wait(5_000);
    changes.finish(answered.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: { ok: true, status: 200, data: { updated: 1 } } });
    expect(changes.claim(refused.record.id, refused.token, 0)).toBe(true);
    changes.finish(refused.record.id, { status: "refused", reason: "limit", notice: "The call limit is reached." });
    const endedAt = new Date(START.getTime() + 5_000);
    expect(changes.get(answered.record.id)).toMatchObject({
      status: "succeeded", httpStatus: 200, result: { ok: true, status: 200, data: { updated: 1 } }, finishedAt: endedAt.toISOString(),
    });
    expect(changes.get(refused.record.id)).toMatchObject({ status: "refused", reason: "limit", result: { notice: "The call limit is reached." } });
    expect(rows()[0]?.result_expires_at).toBe(new Date(endedAt.getTime() + CHANGE_RESULT_TTL_MS).toISOString());

    wait(CHANGE_RESULT_TTL_MS - 1);
    expect(changes.get(answered.record.id)?.result).toEqual({ ok: true, status: 200, data: { updated: 1 } });
    wait(1);
    expect(changes.get(answered.record.id)).toMatchObject({ status: "succeeded", httpStatus: 200, result: null });
    expect(changes.byToken(answered.record.id, answered.token)?.result).toBeNull();
    expect(changes.list({ limit: 10 }).map((record) => record.result)).toEqual([null, null]);
    expect(rows().map((row) => row.result_json)).toEqual([null, null]);

    const old = changes.issue(request(id, { summary: "Old change" }));
    const oldDeletion = changes.issue(destructive(id));
    wait(200 * 86_400_000);
    const young = changes.issue(request(id, { summary: "Young change" }));
    wait(CHANGE_JOURNAL_MS - 200 * 86_400_000 - 1);
    const almostYear = changes.issue(request(id, { summary: "Almost a year" }));
    expect(changes.get(old.record.id)).not.toBeNull();
    expect(changes.get(oldDeletion.record.id)).not.toBeNull();
    wait(2);
    const yearAndMore = changes.issue(request(id, { summary: "A year and a moment" }));

    expect(changes.get(old.record.id)).toBeNull();
    expect(changes.get(oldDeletion.record.id)).toBeNull();
    expect(changes.get(answered.record.id)).toBeNull();
    expect(changes.get(refused.record.id)).toBeNull();
    for (const kept of [young, almostYear, yearAndMore]) expect(changes.get(kept.record.id)).not.toBeNull();
    expect(rows().map((row) => row.summary)).toEqual(["Young change", "Almost a year", "A year and a moment"]);
  });

  it("erases the service's answer past its hour when a change is issued or swept, without anyone reading it", () => {
    const { changes, connect, request, wait, rows } = setup();
    const { id } = connect("Shop");
    const answer = { status: "succeeded" as const, httpStatus: 200, errorCategory: null, result: { ok: true, status: 200, data: { updated: 1 } } };
    const first = changes.issue(request(id));
    expect(changes.claim(first.record.id, first.token, 0)).toBe(true);
    changes.finish(first.record.id, answer);

    changes.sweep();
    expect(rows()[0]?.result_json).not.toBeNull();
    wait(CHANGE_RESULT_TTL_MS);
    changes.issue(request(id));
    expect(rows().map((row) => row.result_json)).toEqual([null, null]);

    const second = changes.issue(request(id));
    expect(changes.claim(second.record.id, second.token, 0)).toBe(true);
    changes.finish(second.record.id, answer);
    wait(CHANGE_RESULT_TTL_MS - 1);
    changes.sweep();
    expect(rows()[2]?.result_json).not.toBeNull();
    wait(1);
    changes.sweep();
    expect(rows()[2]?.result_json).toBeNull();
    expect(rows()[2]?.status).toBe("succeeded");
  });

  it("erases the changes of a connection with it", () => {
    const { db, connections, changes, connect, request, destructive, rows } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const kept = changes.issue(request(other.id));
    changes.issue(request(shop.id));
    changes.issue(destructive(shop.id));
    expect(rows()).toHaveLength(3);

    connections.delete(shop.id);

    expect(rows().map((row) => row.connection_id)).toEqual([other.id]);
    expect(changes.get(kept.record.id)).not.toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps writes off by default and stores the switch per connection", () => {
    const { connections, connect, wait } = setup();
    const shop = connect("Shop");
    const other = connect("Other");

    expect(shop.writesEnabled).toBe(false);
    expect(connections.getConnection(shop.id).writesEnabled).toBe(false);

    wait(1_000);
    const enabled = connections.setWritesEnabled(shop.id, true);
    expect(enabled.writesEnabled).toBe(true);
    expect(enabled.updatedAt).toBe(new Date(START.getTime() + 1_000).toISOString());
    expect(connections.getConnection(shop.id).writesEnabled).toBe(true);
    expect(connections.getConnection(other.id).writesEnabled).toBe(false);
    expect(connections.listConnections().map((connection) => connection.writesEnabled)).toEqual([true, false]);

    expect(connections.setWritesEnabled(shop.id, false).writesEnabled).toBe(false);
    expect(connections.listConnections().map((connection) => connection.writesEnabled)).toEqual([false, false]);
    expect(() => connections.setWritesEnabled("missing", true)).toThrow(/not found/u);
  });

  it("cancels once, for the person, and only while it waits", () => {
    const { changes, connect, request } = setup();
    const { id } = connect("Shop");
    const cancelled = changes.issue(request(id));
    const running = changes.issue(request(id));
    const foreign = changes.issue(request(id));
    expect(changes.claim(running.record.id, running.token, 0)).toBe(true);

    expect(changes.cancel(cancelled.record.id, foreign.token)).toBe(false);
    expect(changes.cancel(cancelled.record.id, "short")).toBe(false);
    expect(changes.cancel(cancelled.record.id, cancelled.token)).toBe(true);
    expect(changes.cancel(cancelled.record.id, cancelled.token)).toBe(false);
    expect(changes.claim(cancelled.record.id, cancelled.token, 0)).toBe(false);
    expect(changes.cancel(running.record.id, running.token)).toBe(false);
    expect(changes.get(cancelled.record.id)).toMatchObject({ status: "cancelled", reason: "person", decidedAt: START.toISOString() });
    expect(changes.get(running.record.id)?.status).toBe("running");
    expect(changes.get(foreign.record.id)?.status).toBe("pending");
  });

  it("refuses once with the reason, and only while it waits", () => {
    const { changes, connect, request } = setup();
    const { id } = connect("Shop");
    const refused = changes.issue(request(id));
    const claimed = changes.issue(request(id));
    expect(changes.claim(claimed.record.id, claimed.token, 0)).toBe(true);

    expect(changes.refuse(refused.record.id, claimed.token, "plan")).toBe(false);
    expect(changes.refuse(refused.record.id, refused.token, "adapter_changed")).toBe(true);
    expect(changes.refuse(refused.record.id, refused.token, "plan")).toBe(false);
    expect(changes.claim(refused.record.id, refused.token, 0)).toBe(false);
    expect(changes.refuse(claimed.record.id, claimed.token, "plan")).toBe(false);
    expect(changes.get(refused.record.id)).toMatchObject({ status: "refused", reason: "adapter_changed", decidedAt: START.toISOString() });
    expect(changes.get(claimed.record.id)).toMatchObject({ status: "running", reason: null });
  });

  it("records how a running change ended, once, and only from running", () => {
    const { changes, connect, request, wait } = setup();
    const { id } = connect("Shop");
    const failed = changes.issue(request(id));
    const timedOut = changes.issue(request(id));
    const waiting = changes.issue(request(id));
    const answered = changes.issue(request(id));
    for (const change of [failed, timedOut, answered]) expect(changes.claim(change.record.id, change.token, 0)).toBe(true);

    changes.finish(waiting.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: { ok: true } });
    expect(changes.get(waiting.record.id)).toMatchObject({ status: "pending", httpStatus: null, result: null, finishedAt: null });

    wait(2_000);
    changes.finish(failed.record.id, { status: "failed", httpStatus: 422, errorCategory: "http_error", result: { ok: false, status: 422, error: "Bad price" } });
    changes.finish(timedOut.record.id, { status: "unknown", httpStatus: null, errorCategory: "timeout", result: null });
    changes.finish(answered.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: { ok: true } });
    changes.finish(answered.record.id, { status: "failed", httpStatus: 500, errorCategory: "http_error", result: null });
    const ended = new Date(START.getTime() + 2_000).toISOString();

    expect(changes.get(failed.record.id)).toMatchObject({
      status: "failed", httpStatus: 422, errorCategory: "http_error", result: { ok: false, status: 422, error: "Bad price" }, finishedAt: ended,
    });
    expect(changes.get(timedOut.record.id)).toMatchObject({ status: "unknown", httpStatus: null, errorCategory: "timeout", result: null, finishedAt: ended });
    expect(changes.get(answered.record.id)).toMatchObject({ status: "succeeded", httpStatus: 200, errorCategory: null, result: { ok: true } });
  });

  it("leaves expired and running changes alone when writes are turned off", () => {
    const { changes, connect, request, destructive, wait } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const lapsedWrite = changes.issue(request(shop.id));
    const lapsedDeletion = changes.issue(destructive(shop.id));
    const running = changes.issue(request(shop.id));
    expect(changes.claim(running.record.id, running.token, 0)).toBe(true);
    wait(CHANGE_LINK_TTL_MS + 1);
    const fresh = changes.issue(request(shop.id));
    const freshOther = changes.issue(request(other.id));

    expect(changes.cancelPending(shop.id, "writes_off")).toBe(1);

    expect(changes.get(fresh.record.id)).toMatchObject({ status: "cancelled", reason: "writes_off" });
    expect(changes.get(freshOther.record.id)?.status).toBe("pending");
    for (const change of [lapsedWrite, lapsedDeletion]) expect(changes.get(change.record.id)?.status).toBe("expired");
    expect(changes.cancelPending(shop.id, "writes_off")).toBe(0);
  });

  it("cancels every change that is still waiting when writes are turned off", () => {
    const { changes, connect, request, destructive } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const write = changes.issue(request(shop.id));
    const deletion = changes.issue(destructive(shop.id));
    const foreign = changes.issue(request(other.id));

    expect(changes.cancelPending(shop.id, "writes_off")).toBe(2);

    expect(changes.get(write.record.id)).toMatchObject({ status: "cancelled", reason: "writes_off" });
    expect(changes.get(deletion.record.id)).toMatchObject({ status: "cancelled", reason: "writes_off" });
    expect(changes.get(foreign.record.id)?.status).toBe("pending");
  });

  it("counts the waiting changes of a connection that have not expired", () => {
    const { changes, connect, request, wait } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const cancelled = changes.issue(request(shop.id));
    const claimed = changes.issue(request(shop.id));
    changes.issue(request(shop.id));
    changes.issue(request(other.id));
    changes.cancel(cancelled.record.id, cancelled.token);
    changes.claim(claimed.record.id, claimed.token, 0);

    expect(changes.pendingCount(shop.id)).toBe(1);
    expect(changes.pendingCount(other.id)).toBe(1);
    expect(changes.pendingCount("missing")).toBe(0);
    wait(CHANGE_LINK_TTL_MS);
    expect(changes.pendingCount(shop.id)).toBe(0);
  });

  it("lists the newest changes first, for one connection or all, up to the limit", () => {
    const { changes, connect, request, wait } = setup();
    const shop = connect("Shop");
    const other = connect("Other");
    const first = changes.issue(request(shop.id, { summary: "first" }));
    const second = changes.issue(request(other.id, { summary: "second" }));
    wait(1_000);
    const third = changes.issue(request(shop.id, { summary: "third" }));
    const fourth = changes.issue(request(shop.id, { summary: "fourth" }));

    expect(changes.list({ limit: 10 }).map((record) => record.summary)).toEqual(["fourth", "third", "second", "first"]);
    expect(changes.list({ connectionId: shop.id, limit: 10 }).map((record) => record.id)).toEqual([fourth.record.id, third.record.id, first.record.id]);
    expect(changes.list({ limit: 2 }).map((record) => record.id)).toEqual([fourth.record.id, third.record.id]);
    expect(changes.list({ connectionId: other.id, limit: 10 }).map((record) => record.id)).toEqual([second.record.id]);
    expect(changes.list({ connectionId: "missing", limit: 10 })).toEqual([]);
    expect(changes.list({ limit: 0 })).toEqual([]);
  });

  it("records how a change is let through, the person's by default, and lists only one kind on request", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const other = connect("Other");
    const confirmed = changes.issue(request(id));
    const unconfirmed = changes.issue(request(id, { confirmation: "none" }));
    const later = changes.issue(request(id, { confirmation: "none", summary: "later" }));
    const elsewhere = changes.issue(request(other.id, { confirmation: "person" }));

    expect([confirmed.record.confirmation, unconfirmed.record.confirmation, elsewhere.record.confirmation]).toEqual(["person", "none", "person"]);
    expect(rows().map((row) => row.confirmation)).toEqual(["person", "none", "none", "person"]);
    expect(changes.get(unconfirmed.record.id)?.confirmation).toBe("none");
    expect(changes.list({ limit: 10, confirmation: "none" }).map((record) => record.id)).toEqual([later.record.id, unconfirmed.record.id]);
    expect(changes.list({ limit: 1, confirmation: "none" }).map((record) => record.id)).toEqual([later.record.id]);
    expect(changes.list({ limit: 10, confirmation: "person" }).map((record) => record.id)).toEqual([elsewhere.record.id, confirmed.record.id]);
    expect(changes.list({ limit: 10, connectionId: id, confirmation: "person" }).map((record) => record.id)).toEqual([confirmed.record.id]);
    expect(changes.list({ limit: 10, connectionId: other.id, confirmation: "none" })).toEqual([]);
  });

  it("refuses to store a deletion as one that needs no confirmation", () => {
    const { changes, connect, destructive, rows } = setup();
    const { id } = connect("Shop");
    const waiting = changes.issue(destructive(id));

    expect(() => changes.issue({ ...destructive(id), confirmation: "none" })).toThrow("A deletion always needs the person's confirmation");
    expect(rows()).toHaveLength(1);
    // Refused before anything was written: the deletion that waits is not replaced by the refused one.
    expect(changes.get(waiting.record.id)?.status).toBe("pending");
    expect(changes.issue({ ...destructive(id), confirmation: "person" }).record.confirmation).toBe("person");
  });

  it("refuses a deletion without confirmation also when only its operation or its method says it deletes", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const archive: AdapterOperation = { ...setPrice, id: "archive_card", risk: "destructive", path: "/cards/archive" };
    const relabelled: AdapterOperation = { ...deleteCard, risk: "write" };
    const disguised: Array<[string, Partial<NewChange>]> = [
      // The caller says write, the stored operation is labelled destructive.
      ["operation labelled destructive", { operationId: archive.id, operation: archive, risk: "write", targetUrl: "https://api.shop.test/cards/archive" }],
      // The caller says write, the stored operation is a DELETE labelled write.
      ["DELETE labelled write", { operationId: relabelled.id, operation: relabelled, risk: "write", method: "DELETE", targetUrl: "https://api.shop.test/cards/1" }],
      // The caller says write and the operation is a POST write, but the method to send is DELETE.
      ["DELETE method", { risk: "write", method: "DELETE" }],
    ];
    for (const [name, overrides] of disguised) {
      expect(() => changes.issue(request(id, { ...overrides, confirmation: "none" })), name).toThrow("A deletion always needs the person's confirmation");
    }
    expect(rows()).toEqual([]);
    // With the person's confirmation each is stored, and a plain write still goes without it.
    for (const [, overrides] of disguised) expect(changes.issue(request(id, overrides)).record.confirmation).toBe("person");
    expect(changes.issue(request(id, { confirmation: "none" })).record.confirmation).toBe("none");
  });

  it("names the operations of an adapter that already ran successfully from the given version on", () => {
    const { changes, connect, request, destructive } = setup();
    const { id } = connect("Shop");
    const outcomes: Array<[NewChange, "succeeded" | "failed" | "unknown" | "pending"]> = [
      [request(id, { operationId: "set_price", adapterVersion: 3 }), "succeeded"],
      [request(id, { operationId: "set_stock", adapterVersion: 3 }), "failed"],
      [request(id, { operationId: "set_title", adapterVersion: 2 }), "succeeded"],
      [request(id, { operationId: "set_note", adapterVersion: 4 }), "unknown"],
      [request(id, { operationId: "set_tag", adapterVersion: 4 }), "pending"],
      [request(id, { operationId: "set_other", adapterVersion: 3, adapterId: "adapter-2" }), "succeeded"],
      [{ ...destructive(id), adapterVersion: 5 }, "succeeded"],
    ];
    for (const [change, status] of outcomes) {
      const { record, token } = changes.issue(change);
      if (status === "pending") continue;
      if (record.risk === "destructive") expect(changes.advance(record.id, token)).toBe(true);
      expect(changes.claim(record.id, token, record.risk === "destructive" ? 1 : 0)).toBe(true);
      changes.finish(record.id, { status, httpStatus: status === "succeeded" ? 200 : null, errorCategory: null, result: null });
    }

    expect(changes.succeededOperations("adapter-1", 3)).toEqual(new Set(["set_price", "delete_card"]));
    expect(changes.succeededOperations("adapter-1", 1)).toEqual(new Set(["set_price", "set_title", "delete_card"]));
    expect(changes.succeededOperations("adapter-1", 6)).toEqual(new Set());
    expect(changes.succeededOperations("adapter-2", 3)).toEqual(new Set(["set_other"]));
    expect(changes.succeededOperations("adapter-3", 1)).toEqual(new Set());
  });

  it("issues a 128-bit card token with the link token and stores only its hash", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const { token, cardToken } = changes.issue(request(id));

    expect(cardToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(Buffer.from(cardToken, "base64url").length).toBe(16);
    expect(cardToken).not.toBe(token);
    expect(rows()[0]).toMatchObject({ card_token_hash: sha256hex(cardToken), card_failures: 0, via_card: 0 });
    expect(JSON.stringify(rows())).not.toContain(cardToken);
  });

  it("lets the card token run a write once and records the confirmation as card", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const { record, cardToken } = changes.issue(request(id));

    expect(changes.verifyCard(record.id, cardToken)).toEqual({ kind: "valid", record });
    // A write has no second step, from the card as on the page.
    expect(changes.claimByCard(record.id, cardToken, 1)).toBe(false);
    expect(changes.claimByCard(record.id, cardToken, 0)).toBe(true);
    expect(changes.claimByCard(record.id, cardToken, 0)).toBe(false);
    expect(changes.get(record.id)).toMatchObject({ status: "running", confirmation: "card", decidedAt: START.toISOString() });
    // Stored as the person's, so the trust rule reads it as theirs.
    expect(rows()[0]).toMatchObject({ card_token_hash: null, via_card: 1, confirmation: "person", card_failures: 0 });
    expect(changes.verifyCard(record.id, cardToken)).toEqual({ kind: "invalid" });
  });

  it("keeps the link token and the card token apart", () => {
    const { changes, connect, request } = setup();
    const { id } = connect("Shop");
    const { record, token, cardToken } = changes.issue(request(id));

    expect(changes.claim(record.id, cardToken, 0)).toBe(false);
    expect(changes.claimByCard(record.id, token, 0)).toBe(false);
    expect(changes.cancel(record.id, cardToken)).toBe(false);
    expect(changes.cancelByCard(record.id, token)).toBe(false);
    expect(changes.refuseByCard(record.id, token, "plan")).toBe(false);
    expect(changes.byToken(record.id, cardToken)).toBeNull();
    expect(changes.get(record.id)?.status).toBe("pending");
  });

  it("never claims a deletion by card, but cancels it", () => {
    const { changes, connect, request, destructive } = setup();
    const { id } = connect("Shop");
    const other = connect("Other");
    const { record, cardToken } = changes.issue(destructive(id));
    // Stored by a caller as a write, but sent as DELETE.
    const disguised = changes.issue(request(other.id, { method: "DELETE" }));

    expect(changes.claimByCard(record.id, cardToken, 0)).toBe(false);
    expect(changes.claimByCard(record.id, cardToken, 1)).toBe(false);
    expect(changes.get(record.id)).toMatchObject({ status: "pending", step: 0 });
    expect(changes.claimByCard(disguised.record.id, disguised.cardToken, 0)).toBe(false);
    expect(changes.get(disguised.record.id)?.status).toBe("pending");

    expect(changes.cancelByCard(record.id, cardToken)).toBe(true);
    expect(changes.cancelByCard(record.id, cardToken)).toBe(false);
    expect(changes.get(record.id)).toMatchObject({ status: "cancelled", reason: "person", decidedAt: START.toISOString() });
  });

  it("revokes the card token whenever the page or the system decides", () => {
    const { changes, connect, request, destructive, rows } = setup();
    const shop = connect("Shop");
    const deleting = connect("Deleting");
    const switchedOff = connect("Switched off");
    const replacing = connect("Replacing");
    const cancelled = changes.issue(request(shop.id));
    const refused = changes.issue(request(shop.id));
    const claimed = changes.issue(request(shop.id));
    const advanced = changes.issue(destructive(deleting.id));
    const offWrite = changes.issue(request(switchedOff.id));
    const replaced = changes.issue(destructive(replacing.id));

    expect(changes.cancel(cancelled.record.id, cancelled.token)).toBe(true);
    expect(changes.refuse(refused.record.id, refused.token, "plan")).toBe(true);
    expect(changes.claim(claimed.record.id, claimed.token, 0)).toBe(true);
    expect(changes.advance(advanced.record.id, advanced.token)).toBe(true);
    expect(changes.cancelPending(switchedOff.id, "writes_off")).toBe(1);
    const newer = changes.issue(destructive(replacing.id));

    const decided = { cancelled, refused, claimed, advanced, offWrite, replaced };
    for (const [name, change] of Object.entries(decided)) {
      const row = rows().find((stored) => stored.id === change.record.id);
      expect(row?.card_token_hash, name).toBeNull();
      expect(changes.verifyCard(change.record.id, change.cardToken), name).toEqual({ kind: "invalid" });
      expect(changes.cancelByCard(change.record.id, change.cardToken), name).toBe(false);
    }
    // The deletion the page moved to its final step still waits for the page, not for the card.
    expect(changes.get(advanced.record.id)).toMatchObject({ status: "pending", step: 1 });
    expect(changes.verifyCard(newer.record.id, newer.cardToken).kind).toBe("valid");
    expect(rows().map((row) => row.card_failures)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses a card token once the link expired", () => {
    const { changes, connect, request, wait, rows } = setup();
    const { id } = connect("Shop");
    const { record, cardToken } = changes.issue(request(id));

    wait(CHANGE_LINK_TTL_MS);
    expect(changes.verifyCard(record.id, cardToken)).toEqual({ kind: "invalid" });
    expect(changes.verifyCard(record.id, "wrong")).toEqual({ kind: "invalid" });
    expect(changes.claimByCard(record.id, cardToken, 0)).toBe(false);
    expect(changes.cancelByCard(record.id, cardToken)).toBe(false);
    expect(changes.refuseByCard(record.id, cardToken, "plan")).toBe(false);
    expect(changes.get(record.id)?.status).toBe("expired");
    expect(rows()[0]?.card_failures).toBe(0);
  });

  it("counts wrong card tokens and stops the change at the fifth", () => {
    const { changes, connect, request } = setup();
    const { id: connectionId } = connect("Shop");

    const { record, cardToken } = changes.issue(request(connectionId));
    for (const wrong of ["x", "A".repeat(22), "B".repeat(22), "C".repeat(22)]) {
      expect(changes.verifyCard(record.id, wrong)).toEqual({ kind: "invalid" });
    }
    expect(changes.get(record.id)?.status).toBe("pending");
    expect(changes.verifyCard(record.id, cardToken).kind).toBe("valid");
    const second = changes.issue(request(connectionId));
    for (let i = 1; i < MAX_CARD_ATTEMPTS; i += 1) changes.verifyCard(second.record.id, "wrong");
    expect(changes.verifyCard(second.record.id, "wrong")).toEqual({ kind: "blocked" });
    expect(changes.get(second.record.id)).toMatchObject({ status: "refused", reason: "card_attempts" });
    expect(changes.get(second.record.id)?.decidedAt).not.toBeNull();
    expect(changes.verifyCard(second.record.id, second.cardToken)).toEqual({ kind: "invalid" });
    expect(changes.claim(second.record.id, second.token, 0)).toBe(false);
    expect(changes.cancel(second.record.id, second.token)).toBe(false);
    expect(changes.get(second.record.id)).toMatchObject({ status: "refused", reason: "card_attempts" });
  });

  it("does not count tries for an unknown or decided change", () => {
    const { changes, connect, request, destructive, rows } = setup();
    const { id } = connect("Shop");
    const other = connect("Other");
    expect(changes.verifyCard("00000000-0000-4000-8000-000000000000", "x")).toEqual({ kind: "invalid" });
    const cancelled = changes.issue(request(id));
    expect(changes.cancel(cancelled.record.id, cancelled.token)).toBe(true);
    // Waiting for its final step on the page, with no card token left.
    const advanced = changes.issue(destructive(other.id));
    expect(changes.advance(advanced.record.id, advanced.token)).toBe(true);

    for (let i = 0; i <= MAX_CARD_ATTEMPTS; i += 1) {
      expect(changes.verifyCard(cancelled.record.id, "wrong")).toEqual({ kind: "invalid" });
      expect(changes.verifyCard(advanced.record.id, "wrong")).toEqual({ kind: "invalid" });
    }
    expect(rows().map((row) => row.card_failures)).toEqual([0, 0]);
    expect(changes.get(cancelled.record.id)).toMatchObject({ status: "cancelled", reason: "person" });
    expect(changes.get(advanced.record.id)).toMatchObject({ status: "pending", step: 1 });
  });

  it("lists card confirmations apart and never counts them for trust", () => {
    const { changes, connect, request } = setup();
    const { id: connectionId } = connect("Shop");
    const byCard = changes.issue(request(connectionId));
    const byPage = changes.issue(request(connectionId));
    const unconfirmed = changes.issue(request(connectionId, { confirmation: "none" }));

    expect(changes.claimByCard(byCard.record.id, byCard.cardToken, 0)).toBe(true);
    changes.finish(byCard.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: null });

    expect(changes.get(byCard.record.id)).toMatchObject({ status: "succeeded", confirmation: "card" });
    expect(changes.list({ confirmation: "card", limit: 10 }).map((record) => record.id)).toEqual([byCard.record.id]);
    expect(changes.list({ connectionId, confirmation: "card", limit: 10 }).map((record) => record.id)).toEqual([byCard.record.id]);
    expect(changes.list({ confirmation: "person", limit: 10 }).map((record) => record.id)).toEqual([byPage.record.id]);
    expect(changes.list({ confirmation: "none", limit: 10 }).map((record) => record.id)).toEqual([unconfirmed.record.id]);
    // Only a confirmation on the page lets the operation run at once later.
    expect(changes.confirmedForms(connectionId, "set_price", "POST", "https://api.shop.test")).toEqual([]);
    expect(changes.claim(byPage.record.id, byPage.token, 0)).toBe(true);
    changes.finish(byPage.record.id, { status: "succeeded", httpStatus: 200, errorCategory: null, result: null });
    expect(changes.confirmedForms(connectionId, "set_price", "POST", "https://api.shop.test")).toEqual([setPrice]);
  });

  it("lists nothing for a way of letting changes through it does not know", () => {
    const { changes, connect, request } = setup();
    const { id: connectionId } = connect("Shop");
    changes.issue(request(connectionId));

    for (const unknown of ["bogus", "constructor", "toString", "__proto__", "person' or 1=1 --"]) {
      expect(changes.list({ confirmation: unknown as ChangeConfirmation, limit: 10 }), unknown).toEqual([]);
      expect(changes.list({ connectionId, confirmation: unknown as ChangeConfirmation, limit: 10 }), unknown).toEqual([]);
    }
    expect(changes.list({ confirmation: "person", limit: 10 })).toHaveLength(1);
  });

  it("refuses an overlong card token before hashing it, and counts no try", () => {
    const { changes, connect, request, rows } = setup();
    const { id } = connect("Shop");
    const { record, cardToken } = changes.issue(request(id));

    expect(changes.verifyCard(record.id, "A".repeat(65))).toEqual({ kind: "invalid" });
    expect(changes.verifyCard(record.id, "x".repeat(1_000_000))).toEqual({ kind: "invalid" });
    expect(rows()[0]?.card_failures).toBe(0);
    // Up to 64 characters a wrong token of any shape is a try.
    expect(changes.verifyCard(record.id, "A".repeat(64))).toEqual({ kind: "invalid" });
    expect(rows()[0]?.card_failures).toBe(1);
    expect(changes.verifyCard(record.id, cardToken).kind).toBe("valid");
  });
});
