import { describe, expect, it } from "vitest";

import { MAX_ERROR_DETAIL, errorDetail, maskSecrets } from "../../src/security/error-detail.js";
import { REDACTED } from "../../src/security/redaction.js";

describe("the text of an error", () => {
  const LONG = "sk-12345678";

  it("reads only a bounded head of a huge error, and still masks a key that starts within the cut", () => {
    const key = "k".repeat(40) + "SECRET";
    const huge = `${"x".repeat(480)}${key}${"y".repeat(5_000_000)}`;
    const started = Date.now();
    const detail = errorDetail(huge, [key]);
    expect(Date.now() - started).toBeLessThan(500);
    // Cut to MAX_ERROR_DETAIL characters after the key became the mask.
    expect(detail).toBe(`${"x".repeat(480)}${REDACTED}${"y".repeat(MAX_ERROR_DETAIL - 480 - REDACTED.length)}`);
    expect(detail).not.toContain("kkkk");
  });

  it("masks a long key anywhere and a short key only as the whole text", () => {
    expect(errorDetail(`token ${LONG} rejected`, [LONG])).toBe("token [REDACTED] rejected");
    expect(errorDetail("eu", ["eu"])).toBe("[REDACTED]");
    expect(errorDetail("region eu", ["eu"])).toBe("region eu");
  });

  it("masks the longer of two keys first, so a key inside another one goes whole", () => {
    expect(maskSecrets(`a ${LONG}-and-more b ${LONG}`, [LONG, `${LONG}-and-more`])).toBe("a [REDACTED] b [REDACTED]");
  });

  it("masks key values inside a JSON answer", () => {
    expect(errorDetail({ error: `bad key ${LONG}`, region: "eu", [LONG]: 1 }, [LONG, "eu"]))
      .toBe('{"error":"bad key [REDACTED]","region":"[REDACTED]","[REDACTED]":1}');
  });

  it("turns control and direction characters into one space and cuts to 500 characters on a character boundary", () => {
    expect(errorDetail("a\u0000\nb\u202Ec", [])).toBe("a b c");
    expect(errorDetail("😀".repeat(600), [])).toBe("😀".repeat(500));
  });

  it("masks before it cuts, so a key at the edge leaves no prefix", () => {
    const text = errorDetail(`${"x".repeat(495)}${LONG}`, [LONG])!;
    expect(Array.from(text)).toHaveLength(500);
    expect(text).not.toContain("sk-1");
  });

  it("masks a short key that is the whole text once the spaces around it are trimmed", () => {
    expect(errorDetail(" eu\n", ["eu"])).toBe("[REDACTED]");
  });

  it("takes an Error's message and gives null for nothing, blanks and what cannot be read", () => {
    expect(errorDetail(new Error("boom"), [])).toBe("boom");
    for (const value of [null, undefined, " \u0000 "]) expect(errorDetail(value, [])).toBeNull();
    expect(errorDetail({ toJSON() { throw new Error("x"); } }, [])).toBeNull();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(errorDetail(circular, [])).toBeNull();
    const unreadable = new Error("x");
    Object.defineProperty(unreadable, "message", { get() { throw new Error("getter"); } });
    expect(errorDetail(unreadable, [])).toBeNull();
  });
});
