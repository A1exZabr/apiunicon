import { describe, expect, it } from "vitest";

import { MESSAGE_KEYS, formatMinutes, translate } from "../../src/i18n/messages.js";

describe("page messages", () => {
  it("has every message in both languages with the same placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    for (const key of MESSAGE_KEYS) {
      const en = translate("en", key);
      const ru = translate("ru", key);
      expect(en.length, key).toBeGreaterThan(0);
      expect(ru.length, key).toBeGreaterThan(0);
      expect(placeholders(ru), key).toEqual(placeholders(en));
    }
  });

  it("says the key is erased from this computer in the same words everywhere it is erased", () => {
    for (const key of ["catalog.signedOut.text", "catalog.signedOut.offline", "catalog.signedOut.refused"] as const) {
      expect(translate("ru", key), key).toContain("с этого компьютера");
    }
    expect(translate("ru", "catalog.signedOut.refused")).toBe("Ключ каталога стёрт с этого компьютера. Облако отказалось его отозвать, поэтому там он истечёт сам.");
  });

  it("fills placeholders and leaves a missing value visible", () => {
    expect(translate("ru", "replace.heading", { label: "Wildberries" })).toBe("Замена ключей: Wildberries");
    expect(translate("en", "replace.heading")).toBe("Replace keys: {label}");
  });

  it("fills only values given directly, so a name inherited from a prototype stays visible", () => {
    // Every object inherits names such as constructor; only own values count.
    const inherited = Object.create({ label: "from the prototype" }) as Record<string, string>;
    expect(translate("en", "replace.heading", inherited)).toBe("Replace keys: {label}");
  });

  it("inserts a value literally, even one that looks like a replacement pattern or a placeholder", () => {
    expect(translate("en", "replace.heading", { label: "a$&b$1$$" })).toBe("Replace keys: a$&b$1$$");
    expect(translate("en", "replace.heading", { label: "{label}" })).toBe("Replace keys: {label}");
  });

  it("says a number of minutes in the form its number needs", () => {
    const say = (locale: "en" | "ru", minutes: number) => formatMinutes(locale, minutes * 60_000);
    expect([1, 2, 5, 15, 21].map((minutes) => say("en", minutes)))
      .toEqual(["1 minute", "2 minutes", "5 minutes", "15 minutes", "21 minutes"]);
    expect([1, 2, 4, 5, 11, 15, 21, 22, 25, 30].map((minutes) => say("ru", minutes))).toEqual([
      "1 минуту", "2 минуты", "4 минуты", "5 минут", "11 минут", "15 минут", "21 минуту", "22 минуты", "25 минут", "30 минут",
    ]);
  });

  it("substitutes numbers", () => {
    expect(translate("en", "provenance.registry", { slug: "wb-orders", version: 3 }))
      .toBe("Reusing a proven adapter: wb-orders v3. No documentation was needed.");
  });
});
