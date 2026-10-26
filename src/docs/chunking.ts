import { createHash, randomUUID } from "node:crypto";

import type { DocumentationChunkInput } from "./repository.js";
import type { ParsedSpec, SpecOperation } from "./spec.js";

const MAX_CHUNK_CHARS = 8_000;
const MAX_SECTION_CHARS = 3_000;
// Leaves room for a part prefix and a body in every part, even for a long path or a long part count.
const MIN_MAX_CHARS = 200;
// Total chunk text per document. Operations past it are not chunked.
const MAX_DOCUMENT_CHARS = 5_000_000;
const MAX_OVERVIEW_SERVERS = 100;

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function partPrefix(shown: string, part: number, parts: number): string {
  return `${shown} (part ${part}/${parts})\n`;
}

// Values JSON.stringify leaves out of objects and writes as null in arrays.
function isUnserializable(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

// Writes JSON like JSON.stringify, but stops once `limit` characters are written, so a huge value costs no
// more than the part that is kept. Long strings are cut before they are escaped for the same reason.
function boundedJson(value: unknown, limit: number): string {
  const parts: string[] = [];
  let length = 0;
  const write = (text: string): boolean => {
    parts.push(text);
    length += text.length;
    return length <= limit;
  };
  const visit = (current: unknown): boolean => {
    if (typeof current === "string") return write(JSON.stringify(current.slice(0, limit - length + 1)));
    if (typeof current === "number") return write(Number.isFinite(current) ? String(current) : "null");
    if (typeof current === "boolean") return write(String(current));
    if (current === null || typeof current !== "object") return write("null");
    if (Array.isArray(current)) {
      if (!write("[")) return false;
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0 && !write(",")) return false;
        const item: unknown = current[index];
        if (!(isUnserializable(item) ? write("null") : visit(item))) return false;
      }
      return write("]");
    }
    if (!write("{")) return false;
    let first = true;
    for (const key of Object.keys(current)) {
      const item: unknown = (current as Record<string, unknown>)[key];
      if (isUnserializable(item)) continue;
      if (!write(`${first ? "" : ","}${JSON.stringify(key.slice(0, limit - length + 1))}:`)) return false;
      first = false;
      if (!visit(item)) return false;
    }
    return write("}");
  };
  if (isUnserializable(value)) return "null";
  visit(value);
  return parts.join("");
}

function compact(value: unknown): string {
  const json = boundedJson(value, MAX_SECTION_CHARS);
  return json.length > MAX_SECTION_CHARS ? `${json.slice(0, MAX_SECTION_CHARS)}…[truncated]` : json;
}

// Returns at most maxChars characters, and stops describing parameters and responses once that many are written.
export function describeOperation(operation: SpecOperation, maxChars = Number.POSITIVE_INFINITY): string {
  const lines: string[] = [];
  let length = 0;
  const add = (line: string): void => {
    length += (lines.length > 0 ? 1 : 0) + line.length;
    lines.push(line);
  };
  const full = (): boolean => length > maxChars;
  add(`${operation.method} ${operation.path}`);
  if (operation.operationId) add(`Operation ID: ${operation.operationId}`);
  if (operation.summary) add(`Summary: ${oneLine(operation.summary)}`);
  if (operation.servers.length > 0) {
    const servers = operation.servers.map(({ url, description }) =>
      description ? `${url} (${oneLine(description)})` : url);
    add(`Servers: ${servers.join(", ")}`);
  }
  if (operation.description) add(`Description: ${oneLine(operation.description)}`);
  if (operation.parameters.length > 0) {
    add("Parameters:");
    for (const value of operation.parameters) {
      if (full()) break;
      const parameter: Record<string, unknown> = value !== null && typeof value === "object"
        ? value as Record<string, unknown>
        : {};
      const required = parameter.required === true ? ", required" : "";
      const description = typeof parameter.description === "string" ? oneLine(parameter.description) : "";
      const name = String(parameter.name ?? "?");
      const location = String(parameter.in ?? "?");
      const detail = description ? `: ${description}` : "";
      const schema = compact(parameter.schema ?? parameter.type ?? null);
      add(`- ${name} (${location}${required})${detail} schema=${schema}`);
    }
  }
  if (operation.requestBody !== null && operation.requestBody !== undefined && !full()) {
    add(`Request body: ${compact(operation.requestBody)}`);
  }
  const statuses = Object.keys(operation.responses);
  if (statuses.length > 0 && !full()) {
    add("Responses:");
    for (const status of statuses) {
      if (full()) break;
      add(`- ${status}: ${compact(operation.responses[status])}`);
    }
  }
  const text = lines.join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function chunk(pageUrl: string, heading: string, body: string): DocumentationChunkInput {
  return {
    id: randomUUID(),
    pageUrl,
    heading: heading.slice(0, 200),
    body,
    contentHash: createHash("sha256").update(`${heading}\n${body}`).digest("hex"),
  };
}

export function chunkSpec(
  spec: ParsedSpec,
  documentUrl: string,
  maxChars = MAX_CHUNK_CHARS,
): DocumentationChunkInput[] {
  if (!Number.isInteger(maxChars) || maxChars < MIN_MAX_CHARS) {
    throw new RangeError(`maxChars must be an integer of at least ${MIN_MAX_CHARS}, got ${maxChars}`);
  }
  const authentication = spec.securitySchemes
    .map((scheme) => [scheme.type, scheme.in, scheme.name, scheme.scheme].filter(Boolean).join(" "))
    .join("; ");
  const overview = [
    spec.title ? `API: ${spec.title}` : "API overview",
    `Format: ${spec.format}`,
    `Servers: ${spec.servers.slice(0, MAX_OVERVIEW_SERVERS).map(({ url }) => url).join(", ") || "none declared"}`,
    `Authentication: ${authentication || "none declared"}`,
    `Operations: ${spec.operations.length}${spec.truncated ? " (the document declares more, which are not indexed)" : ""}`,
  ].join("\n");
  const chunks = [chunk(documentUrl, `${spec.title ?? "API"} overview`, overview.slice(0, maxChars))];
  // The document is untrusted, so its chunks share one text budget. Operations past it are not chunked.
  let used = chunks[0]!.body.length;
  const add = (heading: string, body: string): boolean => {
    if (used + body.length > MAX_DOCUMENT_CHARS) return false;
    used += body.length;
    chunks.push(chunk(documentUrl, heading, body));
    return true;
  };
  for (const operation of spec.operations) {
    if (used >= MAX_DOCUMENT_CHARS) break;
    const heading = `${operation.method} ${operation.path}${
      operation.summary ? ` — ${oneLine(operation.summary)}` : ""
    }`;
    const body = describeOperation(operation, MAX_DOCUMENT_CHARS - used);
    if (body.length <= maxChars) {
      if (!add(heading, body)) break;
      continue;
    }
    // The method and path come from the untrusted spec and can be longer than a whole part, so the
    // prefix of each part shows at most a quarter of the budget. Each part carries the prefix, so the
    // body's own first line (the full method and path) is dropped.
    const header = `${operation.method} ${operation.path}`;
    const shown = truncate(header, Math.floor(maxChars / 4));
    const rest = body.slice(header.length + 1);
    // A part count never exceeds the body length, so the widest prefix that count can produce
    // bounds every part's prefix, and the body size is what remains of maxChars.
    const size = maxChars - partPrefix(shown, body.length, body.length).length;
    const parts = Math.max(1, Math.ceil(rest.length / size));
    for (let index = 0; index < parts; index += 1) {
      const prefix = partPrefix(shown, index + 1, parts);
      if (!add(heading, `${prefix}${rest.slice(index * size, (index + 1) * size)}`)) return chunks;
    }
  }
  return chunks;
}
