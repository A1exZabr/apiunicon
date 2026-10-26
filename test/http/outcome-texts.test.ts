import { describe, expect, it } from "vitest";

import { OUTCOME_KEYS, outcomeKeyOf, type OutcomeKey } from "../../src/changes/outcome.js";
import type { ChangeRecord } from "../../src/changes/repository.js";
import { outcomeOf } from "../../src/http/change-page.js";
import { changeOutcome } from "../../src/http/server.js";

type Facts = Pick<ChangeRecord, "status" | "reason" | "httpStatus" | "errorCategory">;
type PageText = { status: number; title: string; text: string; vars?: Record<string, string | number> };

// One record for each way a change can stand, with what the confirmation page and the journal say of it. Keyed by
// OutcomeKey, so a key that is added has to be added here too.
const SAMPLES: Record<OutcomeKey, { record: Facts; page: PageText; journal: string }> = {
  waiting: {
    record: { status: "pending", reason: null, httpStatus: null, errorCategory: null },
    page: { status: 403, title: "link.expired.title", text: "link.expired.text" },
    journal: "Waiting for you",
  },
  expired: {
    record: { status: "expired", reason: null, httpStatus: null, errorCategory: null },
    page: { status: 403, title: "link.expired.title", text: "link.expired.text" },
    journal: "Expired, nothing changed",
  },
  running: {
    record: { status: "running", reason: null, httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.running.title", text: "change.running.text" },
    journal: "Running",
  },
  done: {
    record: { status: "succeeded", reason: null, httpStatus: 201, errorCategory: null },
    page: { status: 200, title: "change.done.title", text: "change.done.text", vars: { status: 201 } },
    journal: "Done, the service answered 201",
  },
  service_error: {
    record: { status: "failed", reason: null, httpStatus: 422, errorCategory: null },
    page: { status: 200, title: "change.failed.title", text: "change.failed.text", vars: { status: 422 } },
    journal: "The service answered 422, most likely nothing changed",
  },
  not_sent: {
    record: { status: "failed", reason: null, httpStatus: null, errorCategory: "dns" },
    page: { status: 200, title: "change.refused.title", text: "change.notSent.text" },
    journal: "Not sent, nothing changed",
  },
  no_answer: {
    record: { status: "unknown", reason: null, httpStatus: null, errorCategory: "timeout" },
    page: { status: 200, title: "change.unknown.title", text: "change.unknown.text" },
    journal: "No answer in time, the change may have been made",
  },
  not_confirmed: {
    record: { status: "unknown", reason: null, httpStatus: null, errorCategory: "policy" },
    page: { status: 200, title: "change.unconfirmed.title", text: "change.unconfirmed.text" },
    journal: "Sent, result not confirmed",
  },
  cancelled_by_person: {
    record: { status: "cancelled", reason: "person", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.cancelled.title", text: "change.cancelled.text" },
    journal: "Cancelled by you",
  },
  replaced: {
    record: { status: "cancelled", reason: "superseded", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.cancelled.title", text: "change.cancelled.text" },
    journal: "Replaced by a newer request",
  },
  cancelled_writes_off: {
    record: { status: "cancelled", reason: "writes_off", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.cancelled.title", text: "change.refused.writes_off" },
    journal: "Cancelled: changing data was turned off",
  },
  refused_plan: {
    record: { status: "refused", reason: "plan", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.refused.plan" },
    journal: "Not done: changing data is not available",
  },
  refused_writes_off: {
    record: { status: "refused", reason: "writes_off", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.refused.writes_off" },
    journal: "Not done: changing data was turned off",
  },
  refused_adapter_changed: {
    record: { status: "refused", reason: "adapter_changed", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.refused.adapter_changed" },
    journal: "Not done: the connection changed after the request",
  },
  refused_limit: {
    record: { status: "refused", reason: "limit", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.refused.limit" },
    journal: "Not done: the call limit was reached",
  },
  refused_origin: {
    record: { status: "refused", reason: "origin", httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.refused.origin" },
    journal: "Not done: the address is no longer allowed",
  },
  refused_other: {
    record: { status: "refused", reason: null, httpStatus: null, errorCategory: null },
    page: { status: 200, title: "change.refused.title", text: "change.cancelled.text" },
    journal: "Not done",
  },
};

describe("what the confirmation page and the journal say of a change", () => {
  it.each(OUTCOME_KEYS)("says the same of %s on both, from the one reading of the record", (key) => {
    const { record, page, journal } = SAMPLES[key];
    const full = record as ChangeRecord;

    expect(outcomeKeyOf(record)).toBe(key);
    expect(outcomeOf(full)).toEqual(page);
    expect(changeOutcome(full)).toBe(journal);
  });

  it("shows a success that carries no status without one", () => {
    const record = { ...SAMPLES.done.record, httpStatus: null } as ChangeRecord;

    expect(changeOutcome(record)).toBe("Done");
    expect(outcomeOf(record).vars).toEqual({ status: "" });
  });
});
