import { describe, expect, it } from "vitest";

import { OUTCOME_KEYS, outcomeKeyOf, type OutcomeKey } from "../../src/changes/outcome.js";
import type { ChangeReason, ChangeRecord, ChangeStatus } from "../../src/changes/repository.js";

type Facts = Pick<ChangeRecord, "status" | "reason" | "httpStatus" | "errorCategory">;

function facts(status: ChangeStatus, patch: Partial<Facts> = {}): Facts {
  return { status, reason: null, httpStatus: null, errorCategory: null, ...patch };
}

describe("how a change ended", () => {
  const cases: Array<[string, Facts, OutcomeKey]> = [
    ["a change waiting for the person", facts("pending"), "waiting"],
    ["a link that ran out", facts("expired"), "expired"],
    ["a request on its way", facts("running"), "running"],
    ["a 2xx answer", facts("succeeded", { httpStatus: 200 }), "done"],
    ["a success without a recorded status", facts("succeeded"), "done"],
    ["an error answer", facts("failed", { httpStatus: 500, errorCategory: "http" }), "service_error"],
    ["a request that never reached the service", facts("failed", { errorCategory: "dns" }), "not_sent"],
    ["a timeout", facts("unknown", { errorCategory: "timeout" }), "no_answer"],
    ["a run whose process went away", facts("unknown"), "no_answer"],
    ["a request sent whose result could not be confirmed", facts("unknown", { errorCategory: "policy" }), "not_confirmed"],
    ["a response cut at the byte limit", facts("unknown", { errorCategory: "response_limit" }), "not_confirmed"],
    ["a change the person cancelled", facts("cancelled", { reason: "person" }), "cancelled_by_person"],
    ["a cancelled change without a reason", facts("cancelled"), "cancelled_by_person"],
    ["a change a newer request replaced", facts("cancelled", { reason: "superseded" }), "replaced"],
    ["a change cancelled by the switch", facts("cancelled", { reason: "writes_off" }), "cancelled_writes_off"],
    ["a refusal for the plan", facts("refused", { reason: "plan" }), "refused_plan"],
    ["a refusal by the switch", facts("refused", { reason: "writes_off" }), "refused_writes_off"],
    ["a refusal for a changed adapter", facts("refused", { reason: "adapter_changed" }), "refused_adapter_changed"],
    ["a refusal for the call limit", facts("refused", { reason: "limit" }), "refused_limit"],
    ["a refusal for an address no longer approved", facts("refused", { reason: "origin" }), "refused_origin"],
    ["a refusal without a reason", facts("refused"), "refused_other"],
    ["a refusal with a reason only a cancellation has", facts("refused", { reason: "person" }), "refused_other"],
    ["a refusal marked replaced", facts("refused", { reason: "superseded" }), "refused_other"],
  ];

  it.each(cases)("reads %s", (_name, record, key) => {
    expect(outcomeKeyOf(record)).toBe(key);
  });

  it("covers every outcome key", () => {
    expect(new Set(cases.map(([, , key]) => key))).toEqual(new Set(OUTCOME_KEYS));
    expect(new Set(OUTCOME_KEYS).size).toBe(OUTCOME_KEYS.length);
  });

  it("answers every status and every reason, whatever the other facts", () => {
    const statuses: ChangeStatus[] = ["pending", "cancelled", "expired", "refused", "running", "succeeded", "failed", "unknown"];
    const reasons: Array<ChangeReason | null> = [null, "person", "superseded", "writes_off", "plan", "adapter_changed", "limit", "origin"];
    for (const status of statuses) {
      for (const reason of reasons) {
        for (const httpStatus of [null, 200, 500]) {
          for (const errorCategory of [null, "timeout", "dns"]) {
            expect(OUTCOME_KEYS).toContain(outcomeKeyOf({ status, reason, httpStatus, errorCategory }));
          }
        }
      }
    }
  });

  it("ignores facts that do not belong to the status", () => {
    // Only the status decides between these; a stray status code or reason must not turn one into another.
    expect(outcomeKeyOf(facts("pending", { reason: "plan", httpStatus: 500, errorCategory: "timeout" }))).toBe("waiting");
    expect(outcomeKeyOf(facts("succeeded", { reason: "plan", errorCategory: "timeout" }))).toBe("done");
    expect(outcomeKeyOf(facts("running", { httpStatus: 200 }))).toBe("running");
    expect(outcomeKeyOf(facts("failed", { httpStatus: 404, errorCategory: "timeout" }))).toBe("service_error");
  });
});
