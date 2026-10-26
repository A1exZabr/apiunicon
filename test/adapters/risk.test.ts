import { describe, expect, it } from "vitest";

import { effectiveRisk } from "../../src/adapters/risk.js";

describe("effective operation risk", () => {
  it("counts DELETE as destructive and PUT or PATCH labelled read as write, and keeps POST read", () => {
    expect(effectiveRisk({ risk: "write", method: "DELETE" })).toBe("destructive");
    expect(effectiveRisk({ risk: "read", method: "DELETE" })).toBe("destructive");
    expect(effectiveRisk({ risk: "read", method: "PUT" })).toBe("write");
    expect(effectiveRisk({ risk: "read", method: "PATCH" })).toBe("write");
    expect(effectiveRisk({ risk: "read", method: "POST" })).toBe("read");
    expect(effectiveRisk({ risk: "destructive", method: "POST" })).toBe("destructive");
    expect(effectiveRisk({ risk: "read", method: "GET" })).toBe("read");
  });
});
