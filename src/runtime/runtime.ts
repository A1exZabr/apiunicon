import { effectiveRisk, readsThroughPost, type EffectiveRisk } from "../adapters/risk.js";
import { hasDotSegment, OPERATION_ID_PATTERN, type AdapterOperation } from "../adapters/schema.js";
import type { AdapterRecord, AdapterRepository } from "../adapters/repository.js";
import {
  type AuditRepository,
  type ErrorCategory,
} from "../audit/repository.js";
import type { ConnectionRecord, ConnectionRepository } from "../connections/repository.js";
import type { ReadApprovalRepository } from "../reads/repository.js";
import {
  guardedFetch,
  NetworkPolicyError,
  ResponseByteLimitError,
  type FetchImplementation,
  type HostResolver,
} from "../security/network-policy.js";
import { redact } from "../security/redaction.js";
import { unlimitedUsage, type CallMode, type UsageGate } from "../usage/gate.js";
import type { Vault } from "../vault/vault.js";

// What an argument name of an adapter looks like, for naming one back in a refusal.
const ARGUMENT_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;

export type RuntimeResult =
  | { ok: true; status: number; data: unknown; notice?: string }
  | { ok: false; status: number; error: unknown; notice?: string };

export type AdapterRuntimeDependencies = {
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  vault: Vault;
  audits: AuditRepository;
  resolver: HostResolver;
  fetchImpl: FetchImplementation;
  requestTimeoutMs: number;
  // The most the assistant receives, after response.select. The upstream body may be larger, up to maxUpstreamBytes.
  maxResponseBytes: number;
  maxUpstreamBytes?: number;
  usage?: UsageGate;
  // The approvals of reads sent with POST. Without it, no such read runs.
  readApprovals?: Pick<ReadApprovalRepository, "approves">;
  now?: () => Date;
};

export const DEFAULT_MAX_UPSTREAM_BYTES = 16 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(
      `The response is larger than the ${limit}-byte limit for the assistant. Add response.select to the operation to keep only the fields you need, or narrow the request (filters, period, limit).`,
    );
    this.name = "ResponseTooLargeError";
  }
}

// call_adapter and test_adapter_operation run reads only; a change goes through request_change, which asks the person
// on a page unless they let that change run at once.
export class WriteOperationError extends Error {
  constructor(operationId: string, risk: EffectiveRisk) {
    super(
      `Operation ${operationId} changes data (${risk}). Call request_change instead; its result says whether the change ran at once or needs the person's confirmation on a page first.`,
    );
    this.name = "WriteOperationError";
  }
}

// A read sent with POST runs only once it was approved as a read for the connection, as the adapter describes it now:
// the method does not say it only reads, and its label is the assistant's word or a catalog author's.
export class ReadNotApprovedError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Operation ${operationId} is sent with POST and labelled as a read, and the person has not approved it as a read for this connection in its current form. Nothing was sent.`,
    );
    this.name = "ReadNotApprovedError";
  }
}

// A change runs only for the adapter and version the person was shown when it was requested.
export class AdapterChangedError extends Error {
  constructor() {
    super("The connection or its adapter changed after the request. Request the change again.");
    this.name = "AdapterChangedError";
  }
}

const ANSWER_TOO_LARGE_NOTICE = "The service's answer was too large to show.";

type SelectionTree = Map<string, SelectionTree>;

function selectionTree(paths: readonly string[]): SelectionTree {
  const root: SelectionTree = new Map();
  for (const path of paths) {
    let node = root;
    for (const key of path.split(".").filter((part) => part !== "")) {
      let child = node.get(key);
      if (!child) {
        child = new Map();
        node.set(key, child);
      }
      node = child;
    }
  }
  return root;
}

// Keeps only the selected dotted paths; arrays are traversed element by element. The result uses null-prototype
// objects and own-property checks, so a path such as "__proto__" cannot reach or alter any prototype.
function project(value: unknown, tree: SelectionTree): unknown {
  if (tree.size === 0) return value;
  if (Array.isArray(value)) return value.map((item) => project(item, tree));
  if (value === null || typeof value !== "object") return undefined;
  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    const projected = project((value as Record<string, unknown>)[key], child);
    if (projected !== undefined) result[key] = projected;
  }
  return result;
}

const isPlainValue = (item: unknown): boolean =>
  typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));

function assertArgumentType(name: string, value: unknown, type: string): void {
  if (type === "array") {
    if (!Array.isArray(value) || !value.every(isPlainValue)) throw new Error(`Argument ${name} must be a list of strings, numbers or booleans`);
    return;
  }
  const valid =
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "object" && value !== null && typeof value === "object" && !Array.isArray(value));
  if (!valid) throw new Error(`Argument ${name} must be ${type}`);
}

function buildRequest(operation: AdapterOperation, args: Record<string, unknown>): {
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
} {
  const known = new Set(Object.keys(operation.input));
  for (const name of Object.keys(args)) {
    // Named back only when it looks like an argument name, as an unknown operation is: anything else the assistant typed
    // stays out of the refusal, which reaches the host's error records.
    if (!known.has(name)) throw new Error(ARGUMENT_NAME.test(name) ? `Unknown argument: ${name}` : "Unknown argument");
  }

  let path = operation.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(operation.input)) {
    const value = args[name];
    if (value === undefined) {
      if (definition.required) throw new Error(`Argument ${name} is required`);
      continue;
    }
    assertArgumentType(name, value, definition.type);
    if (definition.location === "path") {
      const text = String(value);
      // A dot segment would move the request up the API's paths (DELETE /v3/posting/.. goes to /v3/), and an empty one
      // drops the segment the operation names. Other values are percent-encoded, so they stay inside their segment.
      if (text === "" || text === "." || text === "..") {
        throw new Error(`Argument ${name} cannot be empty, . or .. in the request path`);
      }
      path = path.replaceAll(`{${name}}`, encodeURIComponent(text));
    } else if (definition.location === "query") {
      query.set(name, String(value));
    } else {
      body[name] = value;
    }
  }
  return { path, query, body };
}

const LEAVES_OPERATION_PATH = "The request path leaves the operation's path";

// Checks the arguments and the address and builds the request, without network access.
export function prepareCall(
  adapter: AdapterRecord,
  connection: ConnectionRecord,
  operation: AdapterOperation,
  args: Record<string, unknown>,
): { origin: string; url: URL; method: AdapterOperation["method"]; body: Record<string, unknown> } {
  const origin = operation.origin ?? adapter.dsl.baseOrigins[0];
  if (!origin) throw new Error("Adapter has no base origin");
  if (!connection.allowedOrigins.includes(origin)) {
    throw new Error("Connection does not approve the adapter origin");
  }
  // The schema refuses a dot segment in a path template, and the repository parses every stored adapter with it, so a
  // saved adapter has none. This function takes any operation it is given, so the template is checked here too, before
  // the arguments are looked at. An argument value cannot make one: buildRequest refuses ".", ".." and "", and
  // percent-encodes the rest. As a last guard, the final path must stay under the operation's path up to its first
  // argument.
  if (hasDotSegment(operation.path)) throw new Error(LEAVES_OPERATION_PATH);
  const request = buildRequest(operation, args);
  const url = new URL(request.path, `${origin}/`);
  // A template may carry its own query, such as an OData filter ("?$filter=Posted eq true"): it is kept as written, and
  // the query arguments follow it.
  const own = url.search.slice(1);
  const added = request.query.toString();
  url.search = own !== "" && added !== "" ? `${own}&${added}` : own || added;
  const literalPrefix = new URL(operation.path.split("{", 1)[0] ?? "/", `${origin}/`).pathname;
  if (!url.pathname.startsWith(literalPrefix)) throw new Error(LEAVES_OPERATION_PATH);
  return { origin, url, method: operation.method, body: request.body };
}

// The codes of a name that could not be looked up, as the system's resolver gives them.
const LOOKUP_FAILURE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA", "EAI_NONAME"]);

function codeOf(value: unknown): unknown {
  return value !== null && typeof value === "object" ? (value as { code?: unknown }).code : undefined;
}

// Why a request could not reach the service, or null when the error is not about that. undici's fetch reports a failure
// on the way (no address, a refused or reset connection, a failed TLS handshake) as a TypeError whose cause carries the
// system's or undici's code; the address check before it fails with the resolver's own error and code. A name that
// could not be looked up is "dns", any other such failure "network".
function unreachable(error: unknown): "dns" | "network" | null {
  const cause = error instanceof TypeError ? codeOf(error.cause) : undefined;
  if (typeof cause === "string") return LOOKUP_FAILURE_CODES.has(cause) ? "dns" : "network";
  const code = codeOf(error);
  return typeof code === "string" && LOOKUP_FAILURE_CODES.has(code) ? "dns" : null;
}

function categorize(error: unknown): ErrorCategory {
  if (error instanceof ResponseTooLargeError || error instanceof ResponseByteLimitError) return "response_limit";
  if (error instanceof NetworkPolicyError) return "policy";
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  return unreachable(error) ?? "internal";
}

// What the runtime knows about an error it throws, kept beside the error rather than on it, so nothing the error carries
// (or a host's own error class) can claim it.
type ErrorFacts = { notice?: string; fetchStarted?: boolean };
const errorFacts = new WeakMap<object, ErrorFacts>();

function addFacts(error: unknown, facts: ErrorFacts): void {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  errorFacts.set(error, { ...errorFacts.get(error), ...facts });
}

// The usage gate's notice for a call that threw, as the gate gave it.
export function noticeOf(error: unknown): string | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  return errorFacts.get(error)?.notice;
}

// Whether the runtime had called fetch when the error was thrown: false means the request was never sent. Undefined
// for a value the runtime did not throw, or one it could not mark.
export function fetchStartedOf(error: unknown): boolean | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  return errorFacts.get(error)?.fetchStarted;
}

// A failed call has no result to carry the gate's notice, so the error message carries it to the AI instead, and
// noticeOf gives it to a caller that needs it apart. The error keeps its type, and DOMException's message is a getter,
// so the message is redefined rather than assigned.
function withNotice(error: unknown, notice: string | undefined): unknown {
  if (notice === undefined || !(error instanceof Error)) return error;
  Object.defineProperty(error, "message", { value: `${error.message} Notice: ${notice}`, configurable: true, writable: true });
  addFacts(error, { notice });
  return error;
}

type ExecuteInput = {
  connectionId: string;
  operationId: string;
  args: Record<string, unknown>;
  mode: CallMode;
  // Required in change mode: the adapter and version the change was requested and confirmed for.
  expectedAdapter?: { id: string; version: number };
  // The caller's last look before the request leaves: after the usage gate, the keys and the address check, right
  // before fetch. A throw stops the call with nothing sent; the error is the caller's own and is not audited, as a
  // refusal of the usage gate is not.
  beforeSend?: () => void | Promise<void>;
};

export class AdapterRuntime {
  private readonly now: () => Date;

  constructor(private readonly dependencies: AdapterRuntimeDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  // Every error it throws is marked with whether fetch had been called (fetchStartedOf), so a caller can tell a request
  // that never left from one that may have reached the service, including when afterCall throws after it.
  async execute(input: ExecuteInput): Promise<RuntimeResult> {
    const progress = { fetchStarted: false };
    try {
      return await this.run(input, progress);
    } catch (error) {
      addFacts(error, { fetchStarted: progress.fetchStarted });
      throw error;
    }
  }

  private async run(input: ExecuteInput, progress: { fetchStarted: boolean }): Promise<RuntimeResult> {
    const connection = this.dependencies.connections.getConnection(input.connectionId);
    const expected = input.expectedAdapter;
    // Checked before the adapter's status: a change requested for an adapter since edited back to a draft is a changed
    // adapter, not a call to a draft.
    if (input.mode === "change" && (expected === undefined || connection.adapterId !== expected.id)) {
      throw new AdapterChangedError();
    }
    if (!connection.adapterId) throw new Error("Connection is not bound to an adapter");
    const adapter = this.dependencies.adapters.get(connection.adapterId);
    if (input.mode === "change" && adapter.version !== expected?.version) throw new AdapterChangedError();
    if (input.mode !== "test" && adapter.status !== "working") {
      throw new Error("Adapter must be working before normal calls");
    }
    const operation = adapter.dsl.operations.find(({ id }) => id === input.operationId);
    // The id is the assistant's free text: it is named back only when it has the shape of an operation id, so a refusal never
    // repeats anything else the assistant typed (the refusal text reaches the host's error records, ToolResultEvent.detail).
    if (!operation) {
      throw new Error(OPERATION_ID_PATTERN.test(input.operationId) ? `Unknown adapter operation: ${input.operationId}` : "Unknown adapter operation");
    }
    // Before the usage gate, so a refused operation is neither asked about nor counted.
    const risk = effectiveRisk(operation);
    if (input.mode === "change") {
      if (risk === "read") throw new Error("Read operations run through call_adapter");
    } else if (risk !== "read") {
      throw new WriteOperationError(operation.id, risk);
    } else if (readsThroughPost(operation) && this.dependencies.readApprovals?.approves(connection.id, adapter.dsl, operation) !== true) {
      throw new ReadNotApprovedError(operation.id);
    }
    const request = prepareCall(adapter, connection, operation, input.args);
    const usage = this.dependencies.usage ?? unlimitedUsage;
    const context = { connectionId: connection.id, operationId: operation.id, mode: input.mode };
    const { notice } = await usage.beforeCall(context);
    // Counted when the request reached the external API, whatever it answered (an error, a redirect, an oversized body).
    let dispatched = false;
    let refusedBeforeSend = false;
    const fetchImpl: FetchImplementation = async (target, requestInit) => {
      if (input.beforeSend) {
        try {
          await input.beforeSend();
        } catch (error) {
          refusedBeforeSend = true;
          throw error;
        }
      }
      // Set before the call: from here the request may reach the service, whatever fetch then throws.
      progress.fetchStarted = true;
      const response = await this.dependencies.fetchImpl(target, requestInit);
      dispatched = true;
      return response;
    };
    const startedAt = this.now();
    let httpStatus: number | null = null;
    let answerTooLarge = false;

    try {
      const result = await this.dependencies.vault.withCredentials(
        connection.credentialSetId,
        async (credentials) => {
          const headers = new Headers();
          for (const binding of adapter.dsl.credentialBindings) {
            const value = credentials[binding.fieldName];
            if (value === undefined) {
              throw new Error(`Credential field is not configured: ${binding.fieldName}`);
            }
            headers.set(binding.headerName, value);
          }
          const hasBody = Object.keys(request.body).length > 0;
          if (hasBody) headers.set("content-type", "application/json");
          const init: RequestInit = { method: request.method, headers };
          if (hasBody) init.body = JSON.stringify(request.body);
          const response = await guardedFetch(request.url, init, {
            allowedOrigins: connection.allowedOrigins,
            resolver: this.dependencies.resolver,
            fetchImpl,
            timeoutMs: this.dependencies.requestTimeoutMs,
            maxResponseBytes: Math.max(
              this.dependencies.maxUpstreamBytes ?? DEFAULT_MAX_UPSTREAM_BYTES,
              this.dependencies.maxResponseBytes,
            ),
          });
          httpStatus = response.status;
          const text = await response.text();
          let parsed: unknown = text;
          if (text !== "") {
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              parsed = text;
            }
          }
          const select = operation.response?.select;
          if (response.ok && select && select.length > 0 && typeof parsed === "object") {
            parsed = project(parsed, selectionTree(select));
          }
          const sanitized = redact(
            parsed,
            adapter.dsl.credentialBindings.flatMap(({ fieldName, headerName }) => [
              fieldName,
              headerName,
            ]),
            Object.values(credentials),
          );
          if (Buffer.byteLength(JSON.stringify(sanitized) ?? "") > this.dependencies.maxResponseBytes) {
            if (input.mode !== "change") throw new ResponseTooLargeError(this.dependencies.maxResponseBytes);
            // The change reached the service and its status says how it went, so an oversized answer only loses its data.
            answerTooLarge = true;
            if (!response.ok) return { ok: false as const, status: response.status, error: null };
            return { ok: true as const, status: response.status, data: null };
          }
          if (!response.ok) return { ok: false as const, status: response.status, error: sanitized };
          return { ok: true as const, status: response.status, data: sanitized };
        },
      );
      this.dependencies.audits.record({
        connectionId: connection.id,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        operationId: operation.id,
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        httpStatus,
        outcome: result.ok ? "success" : "failure",
        errorCategory: result.ok ? null : "upstream_http",
      });
      const notices = [answerTooLarge ? ANSWER_TOO_LARGE_NOTICE : undefined, notice].filter(
        (text): text is string => text !== undefined,
      );
      return notices.length === 0 ? result : { ...result, notice: notices.join(" ") };
    } catch (error) {
      if (refusedBeforeSend) throw withNotice(error, notice);
      const errorCategory = categorize(error);
      // A timed-out request was sent but never answered, so no response flagged it above.
      if (errorCategory === "timeout") dispatched = true;
      this.dependencies.audits.record({
        connectionId: connection.id,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        operationId: operation.id,
        startedAt: startedAt.toISOString(),
        durationMs: Math.max(0, this.now().getTime() - startedAt.getTime()),
        httpStatus,
        outcome: "failure",
        errorCategory,
      });
      throw withNotice(error, notice);
    } finally {
      await usage.afterCall({ ...context, dispatched });
    }
  }
}
