import { describe, expect, it } from "vitest";

import { stageFor } from "../../src/discovery/stage.js";

describe("stageFor", () => {
  it("maps every draft state to a setup stage", () => {
    expect(stageFor({ status: "discovering", helpReason: null })).toBe("discovering");
    expect(stageFor({ status: "needs_help", helpReason: "documentation_unavailable" })).toBe("needs_documentation");
    expect(stageFor({ status: "needs_help", helpReason: null })).toBe("needs_documentation");
    expect(stageFor({ status: "needs_help", helpReason: "unsupported_auth" })).toBe("failed");
    expect(stageFor({ status: "needs_review", helpReason: null })).toBe("waiting_for_keys");
    expect(stageFor({ status: "ready", helpReason: null })).toBe("waiting_for_keys");
    expect(stageFor({ status: "completed", helpReason: null })).toBe("completed");
    expect(stageFor({ status: "failed", helpReason: null })).toBe("failed");
  });
});
