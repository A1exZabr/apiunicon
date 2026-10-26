import type { ChangeRecord } from "./repository.js";

// How a change stands once the person (or the system) has dealt with it, as one key. The confirmation page and the
// journal each give every key their own words, in a Record keyed by it, so a key added here cannot be left without
// words on either, and the two pages read a record the same way. The cloud's pages use it too.
export const OUTCOME_KEYS = [
  "waiting",
  "expired",
  "running",
  // The service answered 2xx.
  "done",
  // The service answered with an error status: most likely nothing changed.
  "service_error",
  // The request never reached the service: certainly nothing changed.
  "not_sent",
  // No answer in time, or the run's process went away: the change may have been made.
  "no_answer",
  // The request went out and the service may have answered, but the result could not be confirmed.
  "not_confirmed",
  "cancelled_by_person",
  "replaced",
  "cancelled_writes_off",
  "refused_plan",
  "refused_writes_off",
  "refused_adapter_changed",
  "refused_limit",
  "refused_origin",
  // Refused with no reason, or with a reason that only a cancellation has.
  "refused_other",
] as const;

export type OutcomeKey = (typeof OUTCOME_KEYS)[number];

// Only the status decides between the groups; the other facts refine inside one. "failed" is only where the request
// certainly did not take effect, "unknown" where it may have.
export function outcomeKeyOf(record: Pick<ChangeRecord, "status" | "reason" | "httpStatus" | "errorCategory">): OutcomeKey {
  switch (record.status) {
    case "pending":
      return "waiting";
    case "expired":
      return "expired";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      // No status: the request never reached the service.
      return record.httpStatus === null ? "not_sent" : "service_error";
    case "unknown":
      // A timeout, or a run whose process went away: no answer came. Otherwise the service may well have answered.
      return record.errorCategory === "timeout" || record.errorCategory === null ? "no_answer" : "not_confirmed";
    case "cancelled":
      if (record.reason === "writes_off") return "cancelled_writes_off";
      return record.reason === "superseded" ? "replaced" : "cancelled_by_person";
    case "refused":
      switch (record.reason) {
        case "plan":
          return "refused_plan";
        case "writes_off":
          return "refused_writes_off";
        case "adapter_changed":
          return "refused_adapter_changed";
        case "limit":
          return "refused_limit";
        case "origin":
          return "refused_origin";
        default:
          return "refused_other";
      }
  }
}
