// What a hidden key value or sensitive field becomes: a reader sees that something was there, not what it was.
export const REDACTED = "[REDACTED]";
// What a value nested deeper than the redaction looks becomes: it was cut off, not hidden for what it holds.
export const TRUNCATED = "[TRUNCATED]";
const COMMON_SENSITIVE_KEY =
  /(?:api[-_ ]?key|authorization|token|secret|password|passwd|cookie)/iu;
// The cursor of the next or previous page of a list, such as nextPageToken, next_token, page_token, continuationToken,
// NextContinuationToken (S3) or skipToken (OData): a token by name, but one the assistant passes back for the rest of the
// list, not a credential. Written without separators and in lower case before it is compared.
const PAGE_CURSOR_KEY = /^(?:next|prev|previous|page|nextpage|prevpage|previouspage|startpage|pagination|continuation|nextcontinuation|continue|cursor|sync|skip)token$/u;

function sensitiveByName(key: string): boolean {
  return COMMON_SENSITIVE_KEY.test(key) && !PAGE_CURSOR_KEY.test(key.replace(/[^A-Za-z0-9]/gu, "").toLocaleLowerCase("en-US"));
}

export function redact(
  value: unknown,
  sensitiveNames: readonly string[],
  sensitiveValues: readonly string[],
): unknown {
  const configuredNames = new Set(sensitiveNames.map((name) => name.toLocaleLowerCase()));
  const secrets = sensitiveValues.filter((secret) => secret.length > 0);
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number, key?: string): unknown => {
    if (
      key !== undefined &&
      (configuredNames.has(key.toLocaleLowerCase()) || sensitiveByName(key))
    ) {
      return REDACTED;
    }
    if (depth > 20) return TRUNCATED;
    if (typeof current === "string") {
      return secrets.reduce(
        (sanitized, secret) => sanitized.replaceAll(secret, REDACTED),
        current,
      );
    }
    if (
      current === null ||
      typeof current === "number" ||
      typeof current === "boolean" ||
      current === undefined
    ) {
      return current;
    }
    if (typeof current !== "object") return String(current);
    if (seen.has(current)) return REDACTED;
    seen.add(current);

    if (Array.isArray(current)) {
      return current.map((item) => visit(item, depth + 1));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(current)) {
      sanitized[entryKey] = visit(entryValue, depth + 1, entryKey);
    }
    return sanitized;
  };

  return visit(value, 0);
}
