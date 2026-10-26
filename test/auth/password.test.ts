import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "../../src/auth/password.js";

describe("administrator passwords", () => {
  it("accepts the matching password and rejects a different password", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong horse battery staple", stored)).toBe(false);
  });

  it("uses a fresh salt for the same password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });
});
