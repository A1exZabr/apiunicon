import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

export type SpecServer = { url: string; description: string | null; pointer: string };
export type SpecSchemeType = "apiKey" | "http" | "oauth2" | "openIdConnect" | "basic" | "other";
export type SpecSecurityScheme = {
  pointer: string;
  type: SpecSchemeType;
  in: string | null;
  name: string | null;
  scheme: string | null;
};
export type SpecOperation = {
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  parameters: unknown[];
  requestBody: unknown;
  responses: Record<string, unknown>;
  servers: SpecServer[];
};
export type ParsedSpec = {
  format: "openapi3" | "swagger2" | "postman";
  title: string | null;
  servers: SpecServer[];
  securitySchemes: SpecSecurityScheme[];
  operations: SpecOperation[];
  // True when the document declares more operations than are read.
  truncated: boolean;
};

type JsonObject = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const MAX_REF_DEPTH = 4;
const MAX_INLINED_UNITS = 100_000;
const CHARS_PER_UNIT = 64;
// The document is untrusted, so the number of servers, operations, parameters, and responses read from it is bounded.
const MAX_SERVERS = 100;
const MAX_OPERATIONS = 2_000;
const MAX_PARAMETERS_PER_OPERATION = 200;
const MAX_RESPONSES_PER_OPERATION = 50;
const MAX_NESTING = 256;
const YAML_SNIFF_CHARS = 4_000;
// The YAML parser needs hundreds of times more memory than its input for some documents, so untrusted YAML is
// parsed in a worker with its own heap and time limits, and larger documents are not parsed at all.
const MAX_YAML_BYTES = 2 * 1024 * 1024;
const YAML_OLD_GENERATION_MB = 256;
const YAML_YOUNG_GENERATION_MB = 32;
const YAML_PARSE_TIMEOUT_MS = 3_000;
// The service waits for the worker, so YAML that a worker could not parse is remembered by its hash and limits,
// and the same bytes cost one wait however often they are attached or linked.
const MAX_FAILED_YAML = 256;
const failedYaml = new Set<string>();
// Resolved here, so the worker does not depend on its working directory.
const YAML_MODULE_PATH = createRequire(import.meta.url).resolve("yaml");
// CommonJS run in the worker. It only turns YAML into plain values; cloning them back keeps aliased nodes shared.
// The flag is raised after the message is queued, so the waiting thread finds the message when it wakes.
const YAML_WORKER_SOURCE = `"use strict";
const { workerData } = require("node:worker_threads");
const { flag, input, port, yamlPath } = workerData;
let value = null;
try {
  // Tags in untrusted YAML must not write process warnings.
  value = require(yamlPath).parse(input, { maxAliasCount: 100, logLevel: "silent" });
} catch {}
try {
  port.postMessage(value);
} catch {
  port.postMessage(null);
}
Atomics.store(flag, 0, 1);
Atomics.notify(flag, 0);
`;
const SCHEME_TYPES = new Map<string, SpecSchemeType>([
  ["apikey", "apiKey"],
  ["http", "http"],
  ["oauth2", "oauth2"],
  ["openidconnect", "openIdConnect"],
  ["basic", "basic"],
]);

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export type YamlParseLimits = {
  maxBytes?: number;
  maxOldGenerationSizeMb?: number;
  timeoutMs?: number;
};

function rememberFailedYaml(key: string): void {
  if (failedYaml.size >= MAX_FAILED_YAML) {
    const oldest = failedYaml.values().next().value;
    if (oldest !== undefined) failedYaml.delete(oldest);
  }
  failedYaml.add(key);
}

// Returns the YAML as plain values, or null when it is too large, invalid, or the worker runs out of memory or
// time. The caller stays synchronous: it blocks on a shared flag until the worker raises it or the time is up.
// A worker that exceeds its heap limit is stopped by Node and never raises the flag, so it ends as a timeout.
export function parseYamlIsolated(input: string, limits: YamlParseLimits = {}): unknown {
  if (Buffer.byteLength(input, "utf8") > (limits.maxBytes ?? MAX_YAML_BYTES)) return null;
  const maxOldGenerationSizeMb = limits.maxOldGenerationSizeMb ?? YAML_OLD_GENERATION_MB;
  const timeoutMs = limits.timeoutMs ?? YAML_PARSE_TIMEOUT_MS;
  const key = `${maxOldGenerationSizeMb}:${timeoutMs}:${createHash("sha256").update(input).digest("hex")}`;
  if (failedYaml.has(key)) return null;
  const flag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const { port1, port2 } = new MessageChannel();
  let worker: Worker | null = null;
  try {
    worker = new Worker(YAML_WORKER_SOURCE, {
      eval: true,
      // The worker needs none of the parent's flags or loaders, such as the TypeScript loader in development.
      execArgv: [],
      workerData: { flag, input, port: port2, yamlPath: YAML_MODULE_PATH },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: YAML_YOUNG_GENERATION_MB },
    });
    // Running out of memory is reported as an error event, which must not reach the process.
    worker.on("error", () => {});
    const finished = Atomics.wait(flag, 0, 0, timeoutMs) !== "timed-out";
    const value: unknown = finished ? receiveMessageOnPort(port1)?.message ?? null : null;
    if (value === null) rememberFailedYaml(key);
    return value;
  } catch {
    return null;
  } finally {
    port1.close();
    port2.close();
    void worker?.terminate();
  }
}

function readDocument(input: string): unknown {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!/^(?:openapi|swagger)\s*:/mu.test(input.slice(0, YAML_SNIFF_CHARS))) return null;
  return parseYamlIsolated(input);
}

// Recursive YAML aliases form cycles, and very deep nesting overflows the stack
// when the resolver walks the document. Both are rejected before traversal.
// A value that YAML aliases share is walked again only where it is reached deeper than before, so reusing an
// anchor does not repeat the walk. `checked` holds the deepest depth at which each value passed.
function isTraversable(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  checked = new Map<object, number>(),
): boolean {
  if (value === null || typeof value !== "object") return true;
  if (ancestors.has(value) || depth > MAX_NESTING) return false;
  if ((checked.get(value) ?? -1) >= depth) return true;
  ancestors.add(value);
  const traversable = Object.values(value).every((child) => isTraversable(child, ancestors, depth + 1, checked));
  ancestors.delete(value);
  if (traversable) checked.set(value, depth);
  return traversable;
}

function loadDocument(input: string): unknown {
  const document = readDocument(input);
  return isTraversable(document) ? document : null;
}

function pointerValue(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      current = current[Number(key)];
      continue;
    }
    const container = asObject(current);
    if (!container) return undefined;
    current = Object.hasOwn(container, key) ? container[key] : undefined;
  }
  return current;
}

type ResolveBudget = { remaining: number };

function textUnits(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_UNIT));
}

// One unit per value, and one more per 64 characters of each string and key, so that neither many small
// values nor one huge string can be inlined thousands of times.
function inlineCost(value: unknown): number {
  if (typeof value === "string") return textUnits(value);
  const object = asObject(value);
  if (!object) return 1;
  let cost = 1;
  for (const key of Object.keys(object)) cost += textUnits(key);
  return cost;
}

// Charges every value it produces, the document's own included: a YAML anchor puts one value in many places,
// and copying it for each of them would multiply the document. Once the budget is spent, values are kept as they
// are instead of being copied, and further $ref occurrences stay as { $ref } objects, like the depth cut-off.
export function resolveRefs(
  value: unknown,
  root: unknown,
  depth = 0,
  budget: ResolveBudget = { remaining: MAX_INLINED_UNITS },
): unknown {
  const object = asObject(value);
  if (budget.remaining <= 0) return typeof object?.$ref === "string" ? { $ref: object.$ref } : value;
  budget.remaining -= inlineCost(value);
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, root, depth, budget));
  if (!object) return value;
  if (typeof object.$ref === "string") {
    const target = depth < MAX_REF_DEPTH && budget.remaining > 0
      ? pointerValue(root, object.$ref)
      : undefined;
    if (target === undefined) return { $ref: object.$ref };
    return resolveRefs(target, root, depth + 1, budget);
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, resolveRefs(item, root, depth, budget)]),
  );
}

function readServers(value: unknown, pointer: string): SpecServer[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SERVERS).flatMap((item, index) => {
    const server = asObject(item);
    const url = asText(server?.url);
    return url ? [{ url, description: asText(server?.description), pointer: `${pointer}/${index}` }] : [];
  });
}

// The document's servers, each kept once in the order first declared, up to MAX_SERVERS.
class ServerList {
  private readonly servers = new Map<string, SpecServer>();

  add(servers: readonly SpecServer[]): void {
    for (const server of servers) {
      if (this.servers.size >= MAX_SERVERS) return;
      if (!this.servers.has(server.url)) this.servers.set(server.url, server);
    }
  }

  list(): SpecServer[] {
    return [...this.servers.values()];
  }
}

function readScheme(value: unknown, pointer: string): SpecSecurityScheme {
  const scheme = asObject(value) ?? {};
  return {
    pointer,
    type: SCHEME_TYPES.get(String(scheme.type ?? "").toLocaleLowerCase("en-US")) ?? "other",
    in: asText(scheme.in),
    name: asText(scheme.name),
    scheme: asText(scheme.scheme),
  };
}

// The first status codes of a responses map. A YAML anchor can give many operations one huge map, so each map is
// cut once, reading only its first keys.
function firstResponses(value: unknown, cuts: Map<object, JsonObject>): JsonObject {
  const responses = asObject(value);
  if (!responses) return {};
  const known = cuts.get(responses);
  if (known) return known;
  const kept: [string, unknown][] = [];
  for (const status in responses) {
    if (kept.length >= MAX_RESPONSES_PER_OPERATION) break;
    if (Object.hasOwn(responses, status)) kept.push([status, responses[status]]);
  }
  const cut = Object.fromEntries(kept);
  cuts.set(responses, cut);
  return cut;
}

// Operations list only the servers declared on their own path or operation. Root servers apply to every
// operation, so they are kept once on the document instead of being copied into each operation.
function readOperations(
  root: JsonObject,
  serverList: ServerList,
  format: "openapi3" | "swagger2",
): { operations: SpecOperation[]; truncated: boolean } {
  const operations: SpecOperation[] = [];
  // One budget per document: a per-operation budget still scales with the number of operations.
  const budget: ResolveBudget = { remaining: MAX_INLINED_UNITS };
  const responseCuts = new Map<object, JsonObject>();
  for (const [path, pathValue] of Object.entries(asObject(root.paths) ?? {})) {
    const pathItem = asObject(pathValue);
    if (!pathItem) continue;
    const base = `/paths/${escapePointer(path)}`;
    const pathServers = format === "openapi3" ? readServers(pathItem.servers, `${base}/servers`) : [];
    serverList.add(pathServers);
    // Resolved once and shared by the path's operations instead of being copied for each method.
    const shared = Array.isArray(pathItem.parameters)
      ? resolveRefs(pathItem.parameters.slice(0, MAX_PARAMETERS_PER_OPERATION), root, 0, budget) as unknown[]
      : [];
    for (const method of METHODS) {
      const operation = asObject(pathItem[method]);
      if (!operation) continue;
      if (operations.length >= MAX_OPERATIONS) return { operations, truncated: true };
      const own = Array.isArray(operation.parameters)
        ? operation.parameters.slice(0, MAX_PARAMETERS_PER_OPERATION - shared.length)
        : [];
      const parameters = own.length === 0 ? shared : [...shared, ...resolveRefs(own, root, 0, budget) as unknown[]];
      const operationServers = format === "openapi3"
        ? readServers(operation.servers, `${base}/${method}/servers`)
        : [];
      serverList.add(operationServers);
      const isBody = (parameter: unknown): boolean => asObject(parameter)?.in === "body";
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: asText(operation.operationId),
        summary: asText(operation.summary),
        description: asText(operation.description),
        parameters: format === "swagger2" ? parameters.filter((parameter) => !isBody(parameter)) : parameters,
        requestBody: format === "swagger2"
          ? parameters.find(isBody) ?? null
          : resolveRefs(operation.requestBody ?? null, root, 0, budget),
        responses: asObject(resolveRefs(firstResponses(operation.responses, responseCuts), root, 0, budget)) ?? {},
        servers: operationServers.length > 0 ? operationServers : pathServers,
      });
    }
  }
  return { operations, truncated: false };
}

function parseOpenApi3(root: JsonObject): ParsedSpec {
  const serverList = new ServerList();
  serverList.add(readServers(root.servers, "/servers"));
  const { operations, truncated } = readOperations(root, serverList, "openapi3");
  const schemes = asObject(asObject(root.components)?.securitySchemes) ?? {};
  return {
    format: "openapi3",
    title: asText(asObject(root.info)?.title),
    servers: serverList.list(),
    securitySchemes: Object.entries(schemes).map(([name, value]) =>
      readScheme(value, `/components/securitySchemes/${escapePointer(name)}`)),
    operations,
    truncated,
  };
}

function parseSwagger2(root: JsonObject): ParsedSpec {
  const host = asText(root.host);
  const basePath = asText(root.basePath) ?? "";
  const schemes = Array.isArray(root.schemes)
    ? root.schemes.filter((value): value is string => typeof value === "string")
    : [];
  const scheme = schemes.length === 0 || schemes.includes("https") ? "https" : schemes[0] ?? "https";
  const serverList = new ServerList();
  if (host) serverList.add([{ url: `${scheme}://${host}${basePath}`, description: null, pointer: "/host" }]);
  const definitions = asObject(root.securityDefinitions) ?? {};
  const { operations, truncated } = readOperations(root, serverList, "swagger2");
  return {
    format: "swagger2",
    title: asText(asObject(root.info)?.title),
    servers: serverList.list(),
    securitySchemes: Object.entries(definitions).map(([name, value]) =>
      readScheme(value, `/securityDefinitions/${escapePointer(name)}`)),
    operations,
    truncated,
  };
}

function isPostmanCollection(root: JsonObject): boolean {
  const schema = asText(asObject(root.info)?.schema);
  return schema !== null && schema.includes("schema.getpostman.com") && Array.isArray(root.item);
}

function parsePostman(root: JsonObject): ParsedSpec {
  const variables = new Map<string, string>();
  for (const value of Array.isArray(root.variable) ? root.variable : []) {
    const variable = asObject(value);
    if (typeof variable?.key === "string" && typeof variable.value === "string") {
      variables.set(variable.key, variable.value);
    }
  }
  const substitute = (value: string): string =>
    value.replace(/\{\{([^}]+)\}\}/gu, (match, name: string) => variables.get(name.trim()) ?? match);
  const operations: SpecOperation[] = [];
  const serverList = new ServerList();
  let truncated = false;
  const schemes: SpecSecurityScheme[] = [];
  const readAuth = (value: unknown, pointer: string): void => {
    const auth = asObject(value);
    if (!auth) return;
    if (auth.type === "bearer") {
      schemes.push({ pointer, type: "http", in: "header", name: "Authorization", scheme: "bearer" });
    } else if (auth.type === "oauth2") {
      schemes.push({ pointer, type: "oauth2", in: null, name: null, scheme: null });
    } else if (auth.type === "apikey") {
      const entries = (Array.isArray(auth.apikey) ? auth.apikey : []).map(asObject);
      const setting = (key: string): string | null =>
        asText(entries.find((entry) => entry?.key === key)?.value);
      const name = setting("key");
      if (name) schemes.push({ pointer, type: "apiKey", in: setting("in") ?? "header", name, scheme: null });
    }
  };
  const walk = (items: unknown[], pointer: string): void => {
    items.forEach((value, index) => {
      const item = asObject(value);
      if (!item) return;
      const here = `${pointer}/${index}`;
      readAuth(item.auth, `${here}/auth`);
      if (Array.isArray(item.item)) {
        walk(item.item, `${here}/item`);
        return;
      }
      const request = asObject(item.request);
      if (!request) return;
      if (operations.length >= MAX_OPERATIONS) {
        truncated = true;
        return;
      }
      readAuth(request.auth, `${here}/request/auth`);
      const rawUrl = typeof request.url === "string" ? request.url : asText(asObject(request.url)?.raw);
      if (!rawUrl) return;
      // An unresolved placeholder in the host leaves the server unknown, so the request is skipped.
      // Placeholders in the path or query stay as written; URL encodes their braces, so they are decoded back.
      const resolved = substitute(rawUrl);
      const authority = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/iu.exec(resolved)?.[0] ?? "";
      if (authority === "" || authority.includes("{{")) return;
      let url: URL;
      try {
        url = new URL(resolved);
      } catch {
        return;
      }
      const server: SpecServer = { url: url.origin, description: null, pointer: `${here}/request/url` };
      serverList.add([server]);
      operations.push({
        method: (asText(request.method) ?? "GET").toUpperCase(),
        path: url.pathname.replaceAll("%7B", "{").replaceAll("%7D", "}"),
        operationId: asText(item.name),
        summary: asText(item.name),
        description: asText(request.description),
        parameters: [],
        requestBody: request.body ?? null,
        responses: {},
        servers: [server],
      });
    });
  };
  readAuth(root.auth, "/auth");
  walk(root.item as unknown[], "/item");
  return {
    format: "postman",
    title: asText(asObject(root.info)?.name),
    servers: serverList.list(),
    securitySchemes: schemes,
    operations,
    truncated,
  };
}

// Unquoted YAML versions such as `openapi: 3.0` or `swagger: 2.0` parse as numbers, which drop the ".0".
function versionText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? value.toFixed(1) : String(value);
  return null;
}

export function parseMachineDocument(input: string): ParsedSpec | null {
  const root = asObject(loadDocument(input));
  if (!root) return null;
  if (versionText(root.openapi)?.startsWith("3.")) return parseOpenApi3(root);
  if (versionText(root.swagger) === "2.0") return parseSwagger2(root);
  if (isPostmanCollection(root)) {
    const spec = parsePostman(root);
    // A collection with no usable requests is not a spec, so callers treat the document as text.
    return spec.operations.length > 0 ? spec : null;
  }
  return null;
}
