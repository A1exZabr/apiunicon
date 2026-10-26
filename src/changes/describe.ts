import type { ChangeRecord } from "./repository.js";

// One value a change sends, as the person reads it on the confirmation page and in the journal. block: an object, shown
// as JSON indented by two spaces.
export type ArgumentRow = { label: string; name: string; value: string; block: boolean };

// Characters written out as \uXXXX wherever text that APIUniCon did not write is shown: DEL and the C1 controls, which
// JSON leaves as they are; the C0 controls other than tab and line breaks, which JSON spells but plain text does not;
// format characters (direction overrides and isolates, zero-width marks, the BOM, tag characters); the line and
// paragraph separators; and lone surrogates, which would otherwise reach the page as U+FFFD.
const SPELLED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\u2028\u2029\p{Cs}]/gu;

// What makes a string look like ordinary text when it is not: a control or any character spelled out above, a space
// other than the plain one, the Hangul fillers that show as nothing, the combining grapheme joiner, a variation selector.
const NOT_PLAIN =
  /[\p{Cc}\p{Cf}\u2028\u2029\p{Cs}\u115f\u1160\u3164\uffa0\u034f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]|(?! )\p{Zs}/u;

// Writes each such character as its UTF-16 units, the way JSON escapes them, so JSON stays the same JSON.
export function spellOut(text: string): string {
  return text.replace(SPELLED, (character) =>
    Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, "0")}`)
      .join(""));
}

// A plain string as it is. A string that is empty, starts or ends with a space, or holds a character from NOT_PLAIN is
// shown quoted, as JSON writes it, with the characters from SPELLED written out. Numbers and booleans as JSON writes
// them, an object as indented JSON. Nothing is shortened.
function display(value: unknown): { value: string; block: boolean } {
  if (value !== null && typeof value === "object") return { value: spellOut(JSON.stringify(value, null, 2)), block: true };
  if (typeof value === "string") {
    const plain = value !== "" && !value.startsWith(" ") && !value.endsWith(" ") && !NOT_PLAIN.test(value);
    return { value: plain ? value : spellOut(JSON.stringify(value)), block: false };
  }
  return { value: JSON.stringify(value) ?? String(value), block: false };
}

// The change's arguments in the order the operation lists them, each labelled by the adapter's description or, without
// one, by its name. An argument the operation does not list is kept at the end: what is sent is never hidden.
export function describeArguments(record: Pick<ChangeRecord, "operation" | "args">): ArgumentRow[] {
  const rows: ArgumentRow[] = [];
  const listed = new Set<string>();
  const row = (name: string, label: string, value: unknown): ArgumentRow =>
    ({ label: spellOut(label), name: spellOut(name), ...display(value) });
  for (const [name, definition] of Object.entries(record.operation.input)) {
    if (!Object.hasOwn(record.args, name)) continue;
    listed.add(name);
    rows.push(row(name, definition.description ?? name, record.args[name]));
  }
  for (const [name, value] of Object.entries(record.args)) {
    if (!listed.has(name)) rows.push(row(name, name, value));
  }
  return rows;
}
