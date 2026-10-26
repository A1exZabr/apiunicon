import { describe, expect, it } from "vitest";

import { describeArguments, spellOut } from "../../src/changes/describe.js";
import type { AdapterOperation } from "../../src/adapters/schema.js";

const operation: AdapterOperation = {
  id: "set_price",
  description: "Set the price of a card",
  risk: "write",
  method: "POST",
  path: "/cards/{nmId}/price",
  input: {
    nmId: { type: "integer", location: "path", required: true, description: "Артикул" },
    price: { type: "number", location: "body", required: true, description: "Цена, ₽" },
    note: { type: "string", location: "body", required: false },
    sale: { type: "boolean", location: "query", required: false },
    card: { type: "object", location: "body", required: false, description: "Карточка" },
  },
  documentationRefs: [],
};

// Built from code points, so this file holds no character it tests.
const char = (...codes: number[]) => String.fromCodePoint(...codes);
const BACKSLASH = String.fromCharCode(92);
// How a UTF-16 unit is written out: backslash, u, four hex digits.
const spelled = (...units: number[]) => units.map((unit) => `${BACKSLASH}u${unit.toString(16).padStart(4, "0")}`).join("");
const noteOf = (note: string) => describeArguments({ operation, args: { note } })[0]?.value;
const cardOf = (card: Record<string, unknown>) => describeArguments({ operation, args: { card } })[0]?.value;

describe("describing a change's arguments", () => {
  it("lists the given arguments in the operation's order, labelled by the adapter's description or by name", () => {
    const rows = describeArguments({ operation, args: { price: 349.5, note: "до пятницы", nmId: 123456789, sale: false } });

    expect(rows).toEqual([
      { label: "Артикул", name: "nmId", value: "123456789", block: false },
      { label: "Цена, ₽", name: "price", value: "349.5", block: false },
      { label: "note", name: "note", value: "до пятницы", block: false },
      { label: "sale", name: "sale", value: "false", block: false },
    ]);
  });

  it("shows an object as JSON indented by two spaces, in full", () => {
    const card = { title: "x".repeat(5_000), sizes: [{ size: "M", price: 349 }] };

    expect(describeArguments({ operation, args: { nmId: 1, price: 2, card } })[2]).toEqual({
      label: "Карточка", name: "card", value: JSON.stringify(card, null, 2), block: true,
    });
  });

  it("keeps an argument the operation does not name, rather than hiding something that would be sent", () => {
    expect(describeArguments({ operation, args: { nmId: 1, extra: "x" } })).toEqual([
      { label: "Артикул", name: "nmId", value: "1", block: false },
      { label: "extra", name: "extra", value: "x", block: false },
    ]);
  });

  it("writes out direction marks and zero-width characters, in a text and inside an object", () => {
    const note = `349${char(0x202e)}1${char(0x200b)}`;
    expect(noteOf(note)).toBe(`"349${spelled(0x202e)}1${spelled(0x200b)}"`);
    expect(JSON.parse(noteOf(note) ?? "")).toBe(note);
    const sku = `A${char(0x2066)}B${char(0xe0041)}`;
    expect(cardOf({ sku })).toBe(`{\n  "sku": "A${spelled(0x2066)}B${spelled(0xdb40, 0xdc41)}"\n}`);
    expect(JSON.parse(cardOf({ sku }) ?? "")).toEqual({ sku });
  });

  it("writes out DEL and the C1 controls, which JSON leaves as they are, and spells the C0 ones as JSON does", () => {
    const note = `a${char(0x7f)}b${char(0x85)}c${char(0x9f)}d\n`;
    expect(noteOf(note)).toBe(`"a${spelled(0x7f)}b${spelled(0x85)}c${spelled(0x9f)}d${BACKSLASH}n"`);
    expect(cardOf({ note })).toBe(`{\n  "note": "a${spelled(0x7f)}b${spelled(0x85)}c${spelled(0x9f)}d${BACKSLASH}n"\n}`);
    expect(JSON.parse(noteOf(note) ?? "")).toBe(note);
  });

  it("writes out the line and paragraph separators", () => {
    const note = `a${char(0x2028)}b${char(0x2029)}`;
    expect(noteOf(note)).toBe(`"a${spelled(0x2028)}b${spelled(0x2029)}"`);
    expect(cardOf({ note })).toBe(`{\n  "note": "a${spelled(0x2028)}b${spelled(0x2029)}"\n}`);
  });

  it("writes out a lone surrogate instead of letting it turn into a replacement character", () => {
    const note = `a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdfff)}`;
    expect(noteOf(note)).toBe(`"a${spelled(0xd800)}b${spelled(0xdfff)}"`);
    expect(cardOf({ note })).toBe(`{\n  "note": "a${spelled(0xd800)}b${spelled(0xdfff)}"\n}`);
    // A pair is one ordinary character and stays as it is.
    expect(noteOf("цена 😀")).toBe("цена 😀");
  });

  it("quotes a text with a space other than the plain one", () => {
    for (const space of [0xa0, 0x1680, 0x2000, 0x2007, 0x200a, 0x202f, 0x205f, 0x3000]) {
      const note = `349${char(space)}000`;
      expect(noteOf(note), space.toString(16)).toBe(JSON.stringify(note));
    }
    expect(noteOf("349 000 руб.")).toBe("349 000 руб.");
  });

  it("quotes a text with a Hangul filler, which shows as nothing", () => {
    for (const filler of [0x3164, 0x115f, 0x1160, 0xffa0]) {
      const note = `A${char(filler)}`;
      expect(noteOf(note), filler.toString(16)).toBe(JSON.stringify(note));
    }
  });

  it("quotes a text with the combining grapheme joiner or a variation selector", () => {
    for (const mark of [0x034f, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef]) {
      const note = `A${char(mark)}`;
      expect(noteOf(note), mark.toString(16)).toBe(JSON.stringify(note));
    }
  });

  it("quotes a text that starts or ends with a space, and an empty one", () => {
    expect(noteOf(" 349")).toBe("\" 349\"");
    expect(noteOf("349 ")).toBe("\"349 \"");
    expect(noteOf("")).toBe("\"\"");
    expect(noteOf("a b")).toBe("a b");
  });

  it("writes out the same characters in labels and names", () => {
    const labelled: AdapterOperation = {
      ...operation,
      input: { [`sku${char(0x202e)}`]: { type: "string", location: "body", required: true, description: `Артикул${char(0x2067)}` } },
    };

    expect(describeArguments({ operation: labelled, args: { [`sku${char(0x202e)}`]: "A" } })).toEqual([
      { label: `Артикул${spelled(0x2067)}`, name: `sku${spelled(0x202e)}`, value: "A", block: false },
    ]);
    expect(spellOut(`a${char(0x07)}b\tc\nd${char(0xd800)}`)).toBe(`a${spelled(0x07)}b\tc\nd${spelled(0xd800)}`);
  });
});
