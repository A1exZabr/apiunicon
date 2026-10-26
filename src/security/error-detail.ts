import { REDACTED } from "./redaction.js";

// The text of a failed call that a host may keep to fix a connector: what the service answered as an error, or the core's
// own refusal. It holds no key values, no control characters and no more than a screen line can show.

// Enough for a service's reason, such as "bid_type must be 'manual' for CPC campaigns", without keeping whole bodies.
export const MAX_ERROR_DETAIL = 500;

// How much of an error's text is read at all (see errorDetail).
const SOURCE_BOUND = 64 * 1024;
// A key value this long is found anywhere inside a text. A shorter one (a client number, a region) also occurs in
// ordinary text, so it is matched only as a whole value.
export const MIN_KEY_SUBSTRING = 8;

// Every run of control, format (direction marks among them) and line or paragraph separator characters. Each becomes one
// space, so the words on either side stay apart and nothing reorders or hides the text on a page.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

// Whether any string in the value, or any key of its objects, at any depth, holds one of the secrets: contains a long one,
// or is a short one. Iterative, so deeply nested arguments cannot exhaust the stack.
export function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const long = secrets.filter((secret) => secret.length >= MIN_KEY_SUBSTRING);
  const short = new Set(secrets.filter((secret) => secret.length > 0 && secret.length < MIN_KEY_SUBSTRING));
  if (long.length === 0 && short.size === 0) return false;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (short.has(current) || long.some((secret) => current.includes(secret))) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current !== null && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) pending.push(key, item);
    }
  }
  return false;
}

// Replaces the secrets in a text by the rule of containsSecret: a long one wherever it occurs, a short one only when it
// is the whole text. Longer secrets go first, so one that contains another is replaced whole, not around the shorter.
export function maskSecrets(text: string, secrets: readonly string[]): string {
  if (secrets.some((secret) => secret.length > 0 && secret.length < MIN_KEY_SUBSTRING && secret === text)) return REDACTED;
  const long = [...new Set(secrets.filter((secret) => secret.length >= MIN_KEY_SUBSTRING))]
    .sort((left, right) => right.length - left.length);
  return long.reduce((masked, secret) => masked.replaceAll(secret, REDACTED), text);
}

// The text as it may be shown: unprintable runs made one space, trimmed, and cut to MAX_ERROR_DETAIL characters, counted
// by code points so an emoji or any other pair is never split. null when nothing is left.
export function cleanErrorText(text: string): string | null {
  let cut = "";
  let length = 0;
  for (const character of text.replace(UNPRINTABLE, " ").trim()) {
    if (length === MAX_ERROR_DETAIL) break;
    cut += character;
    length += 1;
  }
  return cut === "" ? null : cut;
}

// The text of an error, with the secrets masked before it is cut, so a key at the edge cannot leave a prefix behind. An
// Error gives its message, a string itself, and any other value its JSON, where every string is masked and then the whole
// JSON again, for a long key used as a field name. null for nothing, a blank, or a value that throws while it is read: a
// getter, a toJSON, a cycle or a depth JSON cannot follow.
export function errorDetail(source: unknown, secrets: readonly string[]): string | null {
  try {
    if (source === null || source === undefined) return null;
    let text: unknown;
    if (source instanceof Error) text = source.message;
    else if (typeof source === "string") text = source;
    else {
      // Undefined for a function or a symbol, which then gives no text.
      text = JSON.stringify(source, (_key, value: unknown) =>
        typeof value === "string" ? maskSecrets(value, secrets) : value);
    }
    if (typeof text !== "string") return null;
    // A service may answer with a page of megabytes, and this runs on the answer path: only a generous head is kept before
    // masking. It is longer than the cut by the longest key, so a key that starts within the cut is still masked whole.
    const bound = SOURCE_BOUND + secrets.reduce((longest, secret) => Math.max(longest, secret.length), 0);
    const cleaned = cleanErrorText(maskSecrets(text.length > bound ? text.slice(0, bound) : text, secrets));
    // Once trimmed, the text may be a short key on its own, which only a whole-text match finds.
    return cleaned === null ? null : maskSecrets(cleaned, secrets);
  } catch {
    return null;
  }
}
