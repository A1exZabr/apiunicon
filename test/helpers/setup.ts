import type { SetupState, StartConnectionResult } from "../../src/mcp/onboarding.js";

// start_connection may stop at a catalog stage, which has no draft yet; without a catalog it always returns a draft.
export function draftSetup(result: StartConnectionResult): SetupState {
  if (!("draftId" in result)) throw new Error(`Expected a draft, got stage ${result.stage}`);
  return result;
}
