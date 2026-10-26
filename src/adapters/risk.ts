import type { AdapterOperation } from "./schema.js";

export type EffectiveRisk = "read" | "write" | "destructive";

// Where the method is unambiguous it decides, so a mislabelled operation (a model's mistake, or a hint in someone
// else's documentation) cannot send a DELETE, PUT or PATCH without the person's confirmation. POST keeps its label:
// GraphQL APIs, and the search and report endpoints of many others, read through POST. Such a read runs only once the person approved it
// (readsThroughPost).
export function effectiveRisk(operation: Pick<AdapterOperation, "risk" | "method">): EffectiveRisk {
  if (operation.method === "DELETE") return "destructive";
  if (operation.risk === "read" && (operation.method === "PUT" || operation.method === "PATCH")) return "write";
  return operation.risk;
}

// A read sent with a method other than GET, which leaves only POST. Nothing about the method says the request only
// reads: its label alone does, and the label is the assistant's word or a catalog author's. So call_adapter and
// test_adapter_operation run such a read only once the person approved it as a read for the connection, in its current
// form, or it came so from the moderated catalog.
export function readsThroughPost(operation: Pick<AdapterOperation, "risk" | "method">): boolean {
  return operation.method !== "GET" && effectiveRisk(operation) === "read";
}
