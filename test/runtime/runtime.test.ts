import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository, type AdapterRecord } from "../../src/adapters/repository.js";
import { type AdapterDsl } from "../../src/adapters/schema.js";
import { AuditRepository } from "../../src/audit/repository.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { readForm, ReadApprovalRepository } from "../../src/reads/repository.js";
import {
  AdapterChangedError, AdapterRuntime, fetchStartedOf, noticeOf, prepareCall, ReadNotApprovedError, WriteOperationError,
} from "../../src/runtime/runtime.js";
import { NetworkPolicyError, ResponseByteLimitError, type FetchImplementation } from "../../src/security/network-policy.js";
import type { CallContext, UsageGate } from "../../src/usage/gate.js";
import { Vault } from "../../src/vault/vault.js";

const runtimeDsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.example.test"],
  credentialBindings: [
    { fieldName: "Client-Id", target: "header", headerName: "Client-Id" },
    { fieldName: "Api-Key", target: "header", headerName: "Api-Key" },
  ],
  operations: [
    {
      id: "list_postings",
      description: "List postings",
      risk: "read",
      method: "POST",
      path: "/v3/posting/fbs/list",
      input: {
        limit: { type: "integer", location: "body", required: true },
      },
      documentationRefs: ["postings-doc"],
    },
    {
      id: "list_postings_v4",
      description: "List postings with structured filters",
      risk: "read",
      method: "POST",
      path: "/v4/posting/fbs/list",
      input: {
        filter: { type: "object", location: "body", required: true },
        limit: { type: "integer", location: "body", required: true },
        nms: { type: "array", location: "body", required: false },
      },
      documentationRefs: ["postings-v4-doc"],
    },
  ],
};

// One read and one of each way an operation changes data: labelled write or destructive, and methods that change data
// whatever the label says.
const changingDsl: AdapterDsl = {
  ...runtimeDsl,
  operations: [
    runtimeDsl.operations[0]!,
    {
      id: "ship_posting",
      description: "Ship a posting",
      risk: "write",
      method: "POST",
      path: "/v4/posting/fbs/ship",
      input: {
        posting_number: { type: "string", location: "body", required: true },
        packages: { type: "integer", location: "body", required: true },
      },
      documentationRefs: ["ship-doc"],
    },
    {
      id: "cancel_posting",
      description: "Cancel a posting",
      risk: "destructive",
      method: "POST",
      path: "/v2/posting/fbs/cancel",
      input: { posting_number: { type: "string", location: "body", required: true } },
      documentationRefs: ["cancel-doc"],
    },
    {
      id: "drop_posting",
      description: "Drop a posting",
      risk: "read",
      method: "DELETE",
      path: "/v3/posting/{posting_number}",
      input: { posting_number: { type: "string", location: "path", required: true } },
      documentationRefs: ["drop-doc"],
    },
    {
      id: "replace_posting",
      description: "Replace a posting",
      risk: "read",
      method: "PUT",
      path: "/v3/posting/{posting_number}",
      input: { posting_number: { type: "string", location: "path", required: true } },
      documentationRefs: ["replace-doc"],
    },
    {
      id: "edit_posting",
      description: "Edit a posting",
      risk: "read",
      method: "PATCH",
      path: "/v3/posting/{posting_number}",
      input: { posting_number: { type: "string", location: "path", required: true } },
      documentationRefs: ["edit-doc"],
    },
  ],
};

const changingArgs: Record<string, Record<string, unknown>> = {
  ship_posting: { posting_number: "0001-1", packages: 2 },
  cancel_posting: { posting_number: "0001-1" },
  drop_posting: { posting_number: "0001-1" },
  replace_posting: { posting_number: "0001-1" },
  edit_posting: { posting_number: "0001-1" },
};

function usageSpy(notice?: string): { usage: UsageGate; calls: Array<{ hook: string; context: CallContext }> } {
  const calls: Array<{ hook: string; context: CallContext }> = [];
  return {
    calls,
    usage: {
      beforeCall: async (context) => {
        calls.push({ hook: "beforeCall", context });
        return notice === undefined ? {} : { notice };
      },
      afterCall: async (context) => {
        calls.push({ hook: "afterCall", context });
      },
      beforeDraft: async () => {},
      beforeDocumentation: async () => {},
      afterDocumentation: async () => {},
    },
  };
}

describe("guarded adapter runtime", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let vault: Vault;
  let audits: AuditRepository;
  let connectionId: string;
  let adapterId: string;
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let fetchImpl: FetchImplementation;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    vault = new Vault(db, Buffer.alloc(32, 3));
    audits = new AuditRepository(db);
    const source = connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    vault.storeFields("credentials-1", {
      "Api-Key": "super-secret",
      "Client-Id": "client-7",
    });
    const adapter = adapters.create({
      slug: "fixture",
      displayName: "Fixture API",
      documentationSourceId: source.id,
      dsl: runtimeDsl,
    });
    const working = adapters.markWorking(adapter.id, adapter.version);
    adapterId = working.id;
    connectionId = connections.createConnection({
      label: "Fixture primary",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-1",
      adapterId,
    }).id;
    fetchCalls = [];
    fetchImpl = async (input, init = {}) => {
      fetchCalls.push({ url: input.toString(), init });
      return new Response(
        JSON.stringify({ result: { postings: [] }, api_key: "super-secret" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
  });

  afterEach(() => db.close());

  // These reads are sent with POST. Their approval has tests of its own; everywhere else every read is approved.
  const approvesEvery = { approves: () => true };

  function buildRuntime(
    overrideFetch: FetchImplementation = fetchImpl,
    maxUpstreamBytes?: number,
    usage?: UsageGate,
    readApprovals: Pick<ReadApprovalRepository, "approves"> | null = approvesEvery,
  ): AdapterRuntime {
    return new AdapterRuntime({
      ...(maxUpstreamBytes === undefined ? {} : { maxUpstreamBytes }),
      ...(usage === undefined ? {} : { usage }),
      ...(readApprovals === null ? {} : { readApprovals }),
      adapters,
      connections,
      vault,
      audits,
      resolver: async () => ["8.8.8.8"],
      fetchImpl: overrideFetch,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });
  }

  it("injects credentials into the upstream request and removes them from results and audit", async () => {
    const result = await buildRuntime().execute({
      connectionId,
      operationId: "list_postings",
      args: { limit: 10 },
      mode: "call",
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.example.test/v3/posting/fbs/list");
    const headers = new Headers(fetchCalls[0]?.init.headers);
    expect(headers.get("Api-Key")).toBe("super-secret");
    expect(headers.get("Client-Id")).toBe("client-7");
    expect(fetchCalls[0]?.init.body).toBe(JSON.stringify({ limit: 10 }));
    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { result: { postings: [] }, api_key: "[REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    const storedAudits = audits.recent(connectionId, 10);
    expect(storedAudits).toHaveLength(1);
    expect(storedAudits[0]).toMatchObject({
      adapterId,
      operationId: "list_postings",
      outcome: "success",
      httpStatus: 200,
    });
    expect(JSON.stringify(storedAudits)).not.toContain("super-secret");
  });

  describe("a read sent with POST", () => {
    const listPostings = { connectionId: "", operationId: "list_postings", args: { limit: 10 } };
    const call = (runtime: AdapterRuntime, mode: "call" | "test", target = connectionId) =>
      runtime.execute({ ...listPostings, connectionId: target, mode });

    it("runs in calls and tests only once approved for the connection in its current form, and is refused before the usage gate", async () => {
      const approvals = new ReadApprovalRepository(db);
      const { usage, calls } = usageSpy();
      const runtime = buildRuntime(fetchImpl, undefined, usage, approvals);

      for (const mode of ["call", "test"] as const) {
        const error = await call(runtime, mode).catch((caught: unknown) => caught);
        expect(error, mode).toBeInstanceOf(ReadNotApprovedError);
        expect((error as ReadNotApprovedError).operationId).toBe("list_postings");
        expect((error as Error).message).toBe(
          "Operation list_postings is sent with POST and labelled as a read, and the person has not approved it as a read for this connection in its current form. Nothing was sent.",
        );
        expect(fetchStartedOf(error), mode).toBe(false);
      }
      expect(fetchCalls).toEqual([]);
      expect(calls).toEqual([]);
      expect(audits.recent(connectionId, 10)).toEqual([]);

      const adapter = adapters.get(adapterId);
      const operation = adapter.dsl.operations[0]!;
      approvals.record(connectionId, [readForm(adapter.dsl, operation)], "person");
      expect((await call(runtime, "call")).ok).toBe(true);
      expect((await call(runtime, "test")).ok).toBe(true);
      // Only the approved operation: the other read sent with POST still waits.
      await expect(runtime.execute({
        connectionId, operationId: "list_postings_v4", args: { filter: {}, limit: 1 }, mode: "call",
      })).rejects.toBeInstanceOf(ReadNotApprovedError);
      expect(fetchCalls).toHaveLength(2);

      // Any edit of the operation, its description included, is a form nobody approved; the old form runs again.
      const edited = adapters.patch(adapterId, adapter.version, {
        ...runtimeDsl,
        operations: [{ ...operation, description: "List postings and cancel the late ones" }, runtimeDsl.operations[1]!],
      });
      await expect(call(runtime, "test")).rejects.toBeInstanceOf(ReadNotApprovedError);
      adapters.markWorking(adapterId, adapters.patch(adapterId, edited.version, runtimeDsl).version);
      expect((await call(runtime, "call")).ok).toBe(true);
      // Another host is another form as well.
      const moved = adapters.patch(adapterId, adapters.get(adapterId).version, {
        ...runtimeDsl,
        baseOrigins: ["https://stats.example.test", "https://api.example.test"],
      });
      adapters.markWorking(adapterId, moved.version);
      db.prepare("update connections set allowed_origins_json = ? where id = ?")
        .run(JSON.stringify(["https://stats.example.test", "https://api.example.test"]), connectionId);
      await expect(call(runtime, "call")).rejects.toBeInstanceOf(ReadNotApprovedError);
      expect(fetchCalls).toHaveLength(3);
    });

    it("needs its own approval on every connection", async () => {
      const approvals = new ReadApprovalRepository(db);
      const runtime = buildRuntime(fetchImpl, undefined, undefined, approvals);
      const { documentationSourceId } = connections.getConnection(connectionId);
      const second = connections.createConnection({
        label: "Fixture second", documentationSourceId, allowedOrigins: ["https://api.example.test"], credentialSetId: "credentials-1", adapterId,
      }).id;
      const { dsl } = adapters.get(adapterId);
      approvals.record(connectionId, [readForm(dsl, dsl.operations[0]!)], "person");

      expect((await call(runtime, "call")).ok).toBe(true);
      await expect(call(runtime, "call", second)).rejects.toBeInstanceOf(ReadNotApprovedError);
      expect(fetchCalls).toHaveLength(1);
    });

    it("never runs without the approvals, while a GET read runs as before", async () => {
      const runtime = buildRuntime(fetchImpl, undefined, undefined, null);
      await expect(call(runtime, "call")).rejects.toBeInstanceOf(ReadNotApprovedError);
      const withGet = adapters.patch(adapterId, adapters.get(adapterId).version, {
        ...runtimeDsl,
        operations: [{ ...runtimeDsl.operations[0]!, method: "GET", input: {} }],
      });
      adapters.markWorking(adapterId, withGet.version);

      expect(await runtime.execute({ connectionId, operationId: "list_postings", args: {}, mode: "call" })).toMatchObject({ ok: true });
      expect(await runtime.execute({ connectionId, operationId: "list_postings", args: {}, mode: "test" })).toMatchObject({ ok: true });
      expect(fetchCalls.map(({ init }) => init.method)).toEqual(["GET", "GET"]);
    });
  });

  it("rejects missing, unknown, and incorrectly typed arguments before network access", async () => {
    const runtime = buildRuntime();

    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: {}, mode: "call" }),
    ).rejects.toThrow(/limit.*required/i);
    await expect(
      runtime.execute({
        connectionId,
        operationId: "list_postings",
        args: { limit: "ten" },
        mode: "call",
      }),
    ).rejects.toThrow(/limit.*integer/i);
    await expect(
      runtime.execute({
        connectionId,
        operationId: "list_postings",
        args: { limit: 10, surprise: true },
        mode: "call",
      }),
    ).rejects.toThrow(/unknown argument.*surprise/i);
    expect(fetchCalls).toHaveLength(0);
  });

  it("passes a structured object through to an approved JSON request body", async () => {
    await buildRuntime().execute({
      connectionId,
      operationId: "list_postings_v4",
      args: {
        filter: { status: ["awaiting_packaging"], since: "2026-08-01T00:00:00Z" },
        limit: 100,
      },
      mode: "call",
    });

    expect(fetchCalls[0]?.url).toBe("https://api.example.test/v4/posting/fbs/list");
    expect(fetchCalls[0]?.init.body).toBe(JSON.stringify({
      filter: { status: ["awaiting_packaging"], since: "2026-08-01T00:00:00Z" },
      limit: 100,
    }));
  });

  // Such as the list of article numbers a marketplace campaign is made for: plain values only, never nested.
  it("passes a list of plain values to the JSON body and refuses one that is not such a list", async () => {
    await buildRuntime().execute({
      connectionId, operationId: "list_postings_v4", args: { filter: {}, limit: 1, nms: [87654321, "x", true] }, mode: "call",
    });
    expect(fetchCalls[0]?.init.body).toBe(JSON.stringify({ filter: {}, limit: 1, nms: [87654321, "x", true] }));
    for (const nms of [87654321, { a: 1 }, [[1]], [{ a: 1 }], [null], [Number.NaN]]) {
      await expect(buildRuntime().execute({
        connectionId, operationId: "list_postings_v4", args: { filter: {}, limit: 1, nms }, mode: "call",
      })).rejects.toThrow(/nms must be a list of strings, numbers or booleans/u);
    }
    expect(fetchCalls).toHaveLength(1);
  });

  it("rejects draft, write-risk, and origin-mismatched execution", async () => {
    const runtime = buildRuntime();
    const draft = adapters.patch(adapterId, 2, runtimeDsl);
    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" }),
    ).rejects.toThrow(/working/i);

    const writeDsl: AdapterDsl = {
      ...runtimeDsl,
      operations: [{ ...runtimeDsl.operations[0]!, risk: "write" }],
    };
    const patched = adapters.patch(adapterId, draft.version, writeDsl);
    adapters.markWorking(adapterId, patched.version);
    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" }),
    ).rejects.toThrow(/Operation list_postings changes data \(write\)\. Call request_change instead/u);

    const readPatch = adapters.patch(adapterId, 5, runtimeDsl);
    adapters.markWorking(adapterId, readPatch.version);
    db.prepare("update connections set allowed_origins_json = ? where id = ?").run(
      JSON.stringify(["https://other.example.test"]),
      connectionId,
    );
    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" }),
    ).rejects.toThrow(/connection does not approve/i);
    expect(fetchCalls).toHaveLength(0);
  });

  it("sends each operation to its own approved origin", async () => {
    const multiHostDsl: AdapterDsl = {
      ...runtimeDsl,
      baseOrigins: ["https://api.example.test", "https://stats.example.test"],
      operations: [
        runtimeDsl.operations[0]!,
        { ...runtimeDsl.operations[0]!, id: "list_sales", path: "/v1/sales", origin: "https://stats.example.test" },
      ],
    };
    const patched = adapters.patch(adapterId, 2, multiHostDsl);
    adapters.markWorking(adapterId, patched.version);
    db.prepare("update connections set allowed_origins_json = ? where id = ?").run(
      JSON.stringify(["https://api.example.test", "https://stats.example.test"]),
      connectionId,
    );
    const runtime = buildRuntime();

    await runtime.execute({ connectionId, operationId: "list_sales", args: { limit: 1 }, mode: "call" });
    await runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 1 }, mode: "call" });

    expect(fetchCalls.map(({ url }) => url)).toEqual([
      "https://stats.example.test/v1/sales",
      "https://api.example.test/v3/posting/fbs/list",
    ]);
  });

  it("rejects an operation whose own origin the connection does not approve", async () => {
    const multiHostDsl: AdapterDsl = {
      ...runtimeDsl,
      baseOrigins: ["https://api.example.test", "https://stats.example.test"],
      operations: [{ ...runtimeDsl.operations[0]!, id: "list_sales", path: "/v1/sales", origin: "https://stats.example.test" }],
    };
    const patched = adapters.patch(adapterId, 2, multiHostDsl);
    adapters.markWorking(adapterId, patched.version);

    await expect(
      buildRuntime().execute({ connectionId, operationId: "list_sales", args: { limit: 1 }, mode: "call" }),
    ).rejects.toThrow(/connection does not approve/i);
    expect(fetchCalls).toHaveLength(0);
  });

  it("rejects an oversized upstream response", async () => {
    const runtime = buildRuntime(async () => new Response("x".repeat(2_000)), 1_500);

    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" }),
    ).rejects.toThrow(/byte limit/i);
    expect(audits.recent(connectionId, 1)[0]?.errorCategory).toBe("response_limit");
  });

  it("records why a call failed by the kind of error, whatever its message says", async () => {
    const categoryAfter = async (failure: () => never, resolver?: () => Promise<string[]>) => {
      const runtime = new AdapterRuntime({
        adapters, connections, vault, audits, readApprovals: approvesEvery,
        resolver: resolver ?? (async () => ["8.8.8.8"]),
        fetchImpl: async () => failure(),
        requestTimeoutMs: 1_000, maxResponseBytes: 1_024,
      });
      await expect(runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 1 }, mode: "call" })).rejects.toThrow();
      return audits.recent(connectionId, 1)[0]?.errorCategory;
    };
    const fetchFailed = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

    for (const code of ["ENOTFOUND", "EAI_AGAIN"]) {
      expect(await categoryAfter(() => { throw fetchFailed(code); }), code).toBe("dns");
    }
    // The name was found, but the connection was refused or reset, or its TLS handshake failed.
    for (const code of ["ECONNREFUSED", "ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
      expect(await categoryAfter(() => { throw fetchFailed(code); }), code).toBe("network");
    }
    // The address check before the request: the resolver's own error.
    expect(await categoryAfter(() => { throw new Error("unreachable"); }, async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND" });
    })).toBe("dns");
    expect(await categoryAfter(() => { throw new ResponseByteLimitError(); })).toBe("response_limit");
    expect(await categoryAfter(() => { throw new NetworkPolicyError("Upstream response exceeded the configured byte limit"); })).toBe("policy");
    expect(await categoryAfter(() => { throw new DOMException("The operation timed out", "TimeoutError"); })).toBe("timeout");
    // A message that only sounds like the network says nothing.
    expect(await categoryAfter(() => { throw new TypeError("fetch failed: dns getaddrinfo"); })).toBe("internal");
    expect(await categoryAfter(() => { throw new Error("getaddrinfo ENOTFOUND"); })).toBe("internal");
  });

  it("keeps only the selected fields so a large response fits the limit", async () => {
    const selectingDsl: AdapterDsl = {
      ...runtimeDsl,
      operations: [{ ...runtimeDsl.operations[0]!, response: { select: ["cards.nmID", "cursor.total", "__proto__.polluted"] } }],
    };
    const patched = adapters.patch(adapterId, 2, selectingDsl);
    adapters.markWorking(adapterId, patched.version);
    const cards = Array.from({ length: 20 }, (_, index) => ({ nmID: index, description: "d".repeat(200) }));
    const runtime = buildRuntime(async () => new Response(JSON.stringify({ cards, cursor: { total: 20, updatedAt: "x" } })));

    const result = await runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { cards: cards.map(({ nmID }) => ({ nmID })), cursor: { total: 20 } },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("tells the assistant how to shrink a response that stays above the limit", async () => {
    const runtime = buildRuntime(async () => new Response(JSON.stringify({ rows: "r".repeat(2_000) })));

    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 10 }, mode: "call" }),
    ).rejects.toThrow(/response\.select/u);
    expect(audits.recent(connectionId, 1)[0]?.errorCategory).toBe("response_limit");
  });

  function useChangingAdapter(): AdapterRecord {
    const patched = adapters.patch(adapterId, 2, changingDsl);
    return adapters.markWorking(adapterId, patched.version);
  }

  it("refuses a write, destructive, or read-labelled DELETE, PUT and PATCH in calls and tests before network access", async () => {
    useChangingAdapter();
    const { usage, calls } = usageSpy();
    const runtime = buildRuntime(fetchImpl, undefined, usage);

    for (const [operationId, args] of Object.entries(changingArgs)) {
      for (const mode of ["call", "test"] as const) {
        const error = await runtime.execute({ connectionId, operationId, args, mode }).catch((caught: unknown) => caught);
        expect(error, `${operationId} in ${mode}`).toBeInstanceOf(WriteOperationError);
        expect((error as Error).name).toBe("WriteOperationError");
        expect((error as Error).message).toContain(`Operation ${operationId} changes data`);
        expect((error as Error).message).toContain("request_change");
      }
    }
    expect((await runtime.execute({ connectionId, operationId: "drop_posting", args: changingArgs.drop_posting!, mode: "call" })
      .catch((caught: unknown) => caught) as Error).message).toContain("(destructive)");
    expect(fetchCalls).toHaveLength(0);
    // A refusal is not a call, so the host neither counts it nor is asked about it.
    expect(calls).toEqual([]);
  });

  it("runs a write only in change mode, for the adapter version the change was requested for", async () => {
    const adapter = useChangingAdapter();
    const { usage, calls } = usageSpy();
    const runtime = buildRuntime(fetchImpl, undefined, usage);
    const expectedAdapter = { id: adapter.id, version: adapter.version };

    const result = await runtime.execute({
      connectionId,
      operationId: "ship_posting",
      args: changingArgs.ship_posting!,
      mode: "change",
      expectedAdapter,
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.example.test/v4/posting/fbs/ship");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(fetchCalls[0]?.init.body).toBe(JSON.stringify({ posting_number: "0001-1", packages: 2 }));
    expect(calls.map(({ hook, context }) => [hook, context.mode])).toEqual([["beforeCall", "change"], ["afterCall", "change"]]);

    await runtime.execute({
      connectionId,
      operationId: "drop_posting",
      args: changingArgs.drop_posting!,
      mode: "change",
      expectedAdapter,
    });
    expect(fetchCalls[1]?.url).toBe("https://api.example.test/v3/posting/0001-1");
    expect(fetchCalls[1]?.init.method).toBe("DELETE");
    expect(fetchCalls[1]?.init.body).toBeUndefined();

    fetchCalls = [];
    calls.length = 0;
    const stale = [
      { id: adapter.id, version: adapter.version - 1 },
      { id: "another-adapter", version: adapter.version },
      undefined,
    ];
    for (const expected of stale) {
      const error = await runtime.execute({
        connectionId,
        operationId: "ship_posting",
        args: changingArgs.ship_posting!,
        mode: "change",
        ...(expected === undefined ? {} : { expectedAdapter: expected }),
      }).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(expected)).toBeInstanceOf(AdapterChangedError);
      expect((error as Error).name).toBe("AdapterChangedError");
    }

    await expect(
      runtime.execute({ connectionId, operationId: "list_postings", args: { limit: 1 }, mode: "change", expectedAdapter }),
    ).rejects.toThrow("Read operations run through call_adapter");

    // A draft at the version the change names still does not run: changes need a working adapter, as calls do.
    const draft = adapters.patch(adapterId, adapter.version, changingDsl);
    await expect(
      runtime.execute({
        connectionId,
        operationId: "ship_posting",
        args: changingArgs.ship_posting!,
        mode: "change",
        expectedAdapter: { id: draft.id, version: draft.version },
      }),
    ).rejects.toThrow(/working/i);

    // The connection no longer bound to any adapter is a changed adapter too.
    db.prepare("update connections set adapter_id = null where id = ?").run(connectionId);
    await expect(
      runtime.execute({
        connectionId,
        operationId: "ship_posting",
        args: changingArgs.ship_posting!,
        mode: "change",
        expectedAdapter,
      }),
    ).rejects.toBeInstanceOf(AdapterChangedError);

    expect(fetchCalls).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("refuses a path argument that would move the request off the operation's path, in every mode", async () => {
    const adapter = useChangingAdapter();
    const pathDsl: AdapterDsl = {
      ...changingDsl,
      operations: [
        ...changingDsl.operations,
        {
          id: "read_posting",
          description: "Read a posting",
          risk: "read",
          method: "GET",
          path: "/v3/posting/{posting_number}",
          input: { posting_number: { type: "string", location: "path", required: true } },
          documentationRefs: ["read-doc"],
        },
      ],
    };
    const withPaths = adapters.markWorking(adapterId, adapters.patch(adapterId, adapter.version, pathDsl).version);
    const pathExpected = { id: withPaths.id, version: withPaths.version };
    const runtime = buildRuntime();

    for (const value of ["..", ".", ""]) {
      await expect(
        runtime.execute({
          connectionId,
          operationId: "drop_posting",
          args: { posting_number: value },
          mode: "change",
          expectedAdapter: pathExpected,
        }),
        JSON.stringify(value),
      ).rejects.toThrow("Argument posting_number cannot be empty, . or .. in the request path");
      for (const mode of ["call", "test"] as const) {
        await expect(
          runtime.execute({ connectionId, operationId: "read_posting", args: { posting_number: value }, mode }),
          `${JSON.stringify(value)} in ${mode}`,
        ).rejects.toThrow("Argument posting_number cannot be empty, . or .. in the request path");
      }
    }
    expect(fetchCalls).toHaveLength(0);

    // The schema refuses a dot segment in an operation's path template in any spelling, and the repository parses a stored
    // adapter with it on every read, so no saved adapter has one. prepareCall checks the template again because it takes
    // any operation it is given.
    const hidden: AdapterDsl["operations"][number] = {
      id: "drop_hidden",
      description: "Drop a posting through a hidden parent path",
      risk: "destructive",
      method: "DELETE",
      path: "/v3/posting/%2E%2e/{posting_number}",
      input: { posting_number: { type: "string", location: "path", required: true } },
      documentationRefs: ["drop-hidden-doc"],
    };
    expect(() => adapters.patch(adapterId, withPaths.version, { ...pathDsl, operations: [...pathDsl.operations, hidden] })).toThrow(/safe relative path/u);
    const prepare = (path: string, args: Record<string, unknown> = { posting_number: "0001-1" }) =>
      prepareCall(withPaths, connections.getConnection(connectionId), { ...hidden, path }, args);
    // The template alone decides, before any argument is looked at: these fail although the argument is missing.
    for (const path of [
      "/v3/posting/%2E%2e/{posting_number}",
      "/v3/posting/..?x={posting_number}",
      "/v3/posting/.#{posting_number}",
      // A trailing space is stripped by the URL parser, which makes this a dot segment.
      "/v3/posting/.. ",
      "/v3/posting/%2e%2e ",
    ]) {
      expect(() => prepare(path, {}), path).toThrow("The request path leaves the operation's path");
    }
    // An argument cannot make one: "." is refused as a value, and anything else is percent-encoded.
    expect(() => prepare("/v3/posting/.{posting_number}", { posting_number: "." })).toThrow("cannot be empty, . or ..");
    expect(prepare("/v3/posting/.{posting_number}", { posting_number: "x" }).url.pathname).toBe("/v3/posting/.x");
    expect(prepare("/v3/posting/{posting_number}").url.href).toBe("https://api.example.test/v3/posting/0001-1");
    expect(fetchCalls).toHaveLength(0);

    // Percent signs are encoded in turn, so an encoded dot segment stays a literal value under the operation's path.
    await runtime.execute({
      connectionId,
      operationId: "drop_posting",
      args: { posting_number: "%2e%2e" },
      mode: "change",
      expectedAdapter: pathExpected,
    });
    await runtime.execute({ connectionId, operationId: "read_posting", args: { posting_number: "../.." }, mode: "call" });
    expect(fetchCalls.map(({ url, init }) => [init.method, url])).toEqual([
      ["DELETE", "https://api.example.test/v3/posting/%252e%252e"],
      ["GET", "https://api.example.test/v3/posting/..%2F.."],
    ]);
  });

  it("keeps the result of a change whose answer is too large, without the data", async () => {
    const adapter = useChangingAdapter();
    const { usage } = usageSpy("Most of this month's calls are used.");
    const expectedAdapter = { id: adapter.id, version: adapter.version };
    let status = 200;
    const runtime = buildRuntime(
      async () => new Response(JSON.stringify({ rows: "r".repeat(2_000) }), { status }),
      undefined,
      usage,
    );

    const result = await runtime.execute({
      connectionId,
      operationId: "ship_posting",
      args: changingArgs.ship_posting!,
      mode: "change",
      expectedAdapter,
    });
    expect(result).toMatchObject({ ok: true, status: 200, data: null });
    expect(result.notice).toContain("too large");
    expect(result.notice).toContain("Most of this month's calls are used.");
    expect(JSON.stringify(result)).not.toContain("rrrr");

    status = 500;
    const failed = await runtime.execute({
      connectionId,
      operationId: "ship_posting",
      args: changingArgs.ship_posting!,
      mode: "change",
      expectedAdapter,
    });
    expect(failed).toMatchObject({ ok: false, status: 500, error: null });
    expect(failed.notice).toContain("too large");
    expect(audits.recent(connectionId, 2).map(({ httpStatus, outcome }) => [httpStatus, outcome])).toEqual([
      [500, "failure"],
      [200, "success"],
    ]);
  });

  it("marks every error it throws with whether fetch had started, and with the gate's notice apart from the message", async () => {
    const adapter = useChangingAdapter();
    const change = {
      connectionId, operationId: "ship_posting", args: changingArgs.ship_posting!, mode: "change" as const,
      expectedAdapter: { id: adapter.id, version: adapter.version },
    };
    const caught = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
    const notice = "Most of this month's calls are used.";
    const gate = (overrides: Partial<UsageGate>): UsageGate => ({ ...usageSpy(notice).usage, ...overrides });

    // Before fetch: an argument the operation does not know, a gate that fails, a private address.
    const unknownArgument = await caught(buildRuntime().execute({ ...change, args: { ...change.args, extra: 1 } }));
    const gateDown = await caught(buildRuntime(fetchImpl, undefined, gate({
      beforeCall: async () => {
        throw new Error("The gate is down");
      },
    })).execute(change));
    const privateHost = await caught(new AdapterRuntime({
      adapters, connections, vault, audits, resolver: async () => ["10.0.0.7"], fetchImpl, requestTimeoutMs: 1_000, maxResponseBytes: 1_024,
    }).execute(change));
    for (const error of [unknownArgument, gateDown, privateHost]) expect(fetchStartedOf(error)).toBe(false);
    expect(fetchCalls).toHaveLength(0);

    // After fetch was called: a timeout, and a gate that throws after the answer.
    const timedOut = await caught(buildRuntime(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }, undefined, gate({})).execute(change));
    const afterAnswer = await caught(buildRuntime(fetchImpl, undefined, gate({
      afterCall: async () => {
        throw new Error("The gate failed after the call");
      },
    })).execute(change));
    expect(fetchStartedOf(timedOut)).toBe(true);
    expect(fetchStartedOf(afterAnswer)).toBe(true);
    expect(noticeOf(timedOut)).toBe(notice);
    expect((timedOut as Error).message).toContain(` Notice: ${notice}`);

    // A message that only looks like it carries a notice has none.
    const lookalike = await caught(buildRuntime(async () => {
      throw new TypeError("fetch failed Notice: injected");
    }).execute(change));
    expect(noticeOf(lookalike)).toBeUndefined();
    expect(fetchStartedOf(lookalike)).toBe(true);
    expect(noticeOf(new Error("x Notice: y"))).toBeUndefined();
    expect(fetchStartedOf("thrown text")).toBeUndefined();
  });
});
