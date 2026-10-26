import type { ConnectionDraftRecord } from "./repository.js";

export type SetupStage = "discovering" | "needs_documentation" | "waiting_for_keys" | "completed" | "failed";

export function stageFor(draft: Pick<ConnectionDraftRecord, "status" | "helpReason">): SetupStage {
  switch (draft.status) {
    case "discovering":
      return "discovering";
    case "needs_help":
      return draft.helpReason === "unsupported_auth" ? "failed" : "needs_documentation";
    case "needs_review":
    case "ready":
      return "waiting_for_keys";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}
