import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createToolHandlers, type ToolName } from "../../src/mcp/tools.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { createFixtureApi } from "../helpers/fixture-server.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "../http/helpers.js";
import { ran } from "../helpers/results.js";

const FIRST_SECRET = "first-fixture-secret";
const SECOND_SECRET = "second-fixture-secret";

const config: AppConfig = {
  setupTokenPath: setupTokenPath(),
  stateDir: ".",
  binDir: ".",
  dbPath: ":memory:",
  masterKey: Buffer.alloc(32, 8),
  httpHost: "127.0.0.1",
  httpPort: 3210,
  maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000,
  maxCrawlPages: 5,
};

const staleDsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.example.test"],
  credentialBindings: [
    { fieldName: "Api-Key", target: "header", headerName: "Api-Key" },
  ],
  operations: [
    {
      id: "list_orders",
      description: "List recent orders",
      risk: "read",
      method: "GET",
      path: "/orders-stale",
      input: {},
      documentationRefs: [],
    },
  ],
};

describe("adapter reuse across connections", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  it("builds once, saves the repair, and reuses without documentation or mutation", async () => {
    const fixture = createFixtureApi();
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: fixture.fetchImpl,
    });
    const server = buildHttpServer(application);
    const session = await setupAdmin(server, application);
    const firstConnectionId = await createDiscoveredConnection(
      server,
      application,
      session,
      FIRST_SECRET,
    );
    const firstCalls: ToolName[] = [];
    const firstTools = createToolHandlers({
      ...application.mcpDependencies,
      onToolCall: (name) => firstCalls.push(name),
    });

    expect((await firstTools.search_docs({
      connectionId: firstConnectionId,
      query: "orders list",
    }))[0]?.body).toContain("GET /orders");
    const draft = await firstTools.create_adapter({
      connectionId: firstConnectionId,
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      dsl: staleDsl,
    });
    const failed = ran(await firstTools.test_adapter_operation({
      connectionId: firstConnectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    expect(failed.ok).toBe(false);
    const correctedDsl: AdapterDsl = {
      ...staleDsl,
      operations: [{ ...staleDsl.operations[0]!, path: "/orders" }],
    };
    const patched = await firstTools.patch_adapter({
      adapterId: draft.id,
      expectedVersion: draft.version,
      dsl: correctedDsl,
    });
    await firstTools.record_learning({
      adapterId: draft.id,
      operationId: "list_orders",
      kind: "behavior",
      finding: { stalePath: "/orders-stale", workingPath: "/orders" },
      evidence: { testStatus: 404, docsPath: "/orders" },
    });
    const passed = ran(await firstTools.test_adapter_operation({
      connectionId: firstConnectionId,
      adapterId: draft.id,
      operationId: "list_orders",
      args: {},
    }));
    expect(passed.ok).toBe(true);
    expect(passed.adapterVersion).toBeGreaterThan(patched.version);
    const requestedReuse = await firstTools.mark_adapter_reusable({
      adapterId: draft.id,
      expectedVersion: passed.adapterVersion,
    });
    expect(requestedReuse.confirmationRequired).toBe(true);
    expect(application.adapters.get(draft.id).visibility).toBe("private");
    const confirmedReuse = await server.inject({
      method: "POST",
      url: `/adapters/${draft.id}/mark-reusable`,
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([
        ["csrf", session.csrf],
        ["expectedVersion", String(passed.adapterVersion)],
        ["confirmContribution", "yes"],
      ]),
    });
    expect(confirmedReuse.statusCode).toBe(303);
    const reusable = application.adapters.get(draft.id);
    expect(reusable.visibility).toBe("reusable");

    const secondConnectionId = await createDiscoveredConnection(
      server,
      application,
      session,
      SECOND_SECRET,
    );
    const secondCalls: ToolName[] = [];
    const secondTools = createToolHandlers({
      ...application.mcpDependencies,
      onToolCall: (name) => secondCalls.push(name),
    });

    const found = await secondTools.search_adapters({ query: "fixture" });
    await secondTools.get_adapter({ adapterId: found[0]!.id });
    await secondTools.bind_adapter({ connectionId: secondConnectionId, adapterId: found[0]!.id });
    const reused = ran(await secondTools.call_adapter({
      connectionId: secondConnectionId,
      operationId: "list_orders",
      args: {},
    }));

    expect(reused).toEqual({
      ok: true,
      status: 200,
      data: { orders: [{ id: "order-1" }] },
    });
    expect(secondCalls).toEqual([
      "search_adapters",
      "get_adapter",
      "bind_adapter",
      "call_adapter",
    ]);
    expect(secondCalls).not.toEqual(
      expect.arrayContaining(["search_docs", "create_adapter", "patch_adapter"]),
    );
    expect(application.adapters.get(reusable.id).version).toBe(reusable.version);
    expect(fixture.apiCalls.map(({ apiKey }) => apiKey)).toEqual([
      FIRST_SECRET,
      FIRST_SECRET,
      SECOND_SECRET,
    ]);

    expect(findKeyFragment(application.db, FIRST_SECRET)).toEqual([]);
    expect(findKeyFragment(application.db, SECOND_SECRET)).toEqual([]);
    await server.close();
  });
});

async function createDiscoveredConnection(
  server: FastifyInstance,
  application: Application,
  session: { cookies: string; csrf: string },
  secret: string,
): Promise<string> {
  const startPayload = form([
    ["csrf", session.csrf],
    ["documentationUrl", "https://docs.example.test/index.html"],
  ]);
  expect(startPayload).not.toContain("allowedOrigin");
  expect(startPayload).not.toContain("credentialName");
  expect(startPayload).not.toContain("label=");
  const created = await server.inject({
    method: "POST",
    url: "/connection-drafts",
    headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
    payload: startPayload,
  });
  expect(created.statusCode).toBe(303);
  const draftId = created.headers.location!.split("/").at(-1)!;
  await application.jobRunner.runOne();
  const discovered = application.drafts.get(draftId);
  expect(discovered.status).toBe("needs_review");
  const selected = await server.inject({
    method: "POST",
    url: `/connection-drafts/${draftId}/select`,
    headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
    payload: form([
      ["csrf", session.csrf],
      ...discovered.discovery.origins.map(({ id }) => ["originId", id] as [string, string]),
      ...discovered.discovery.credentials.map(({ id }) => ["credentialId", id] as [string, string]),
    ]),
  });
  expect(selected.statusCode).toBe(303);
  const ready = application.drafts.get(draftId);
  const completed = await server.inject({
    method: "POST",
    url: `/connection-drafts/${draftId}/complete`,
    headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
    payload: form([
      ["csrf", session.csrf],
      ...ready.selectedCredentials!.map(({ id }) => [`credentialValue:${id}`, secret] as [string, string]),
    ]),
  });
  expect(completed.statusCode).toBe(303);
  expect(completed.body).not.toContain(secret);
  return completed.headers.location!.split("/").at(-1)!;
}
