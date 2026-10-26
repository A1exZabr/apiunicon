import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createToolHandlers } from "../../src/mcp/tools.js";
import { WriteOperationError } from "../../src/runtime/runtime.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 29),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.example.test"],
  credentialBindings: [{ fieldName: "Api-Key", target: "header", headerName: "Api-Key" }],
  operations: [
    {
      id: "list_orders",
      description: "List recent orders",
      risk: "read",
      method: "GET",
      path: "/orders",
      input: {},
      documentationRefs: [],
    },
    {
      id: "cancel_order",
      description: "Cancel an order",
      risk: "write",
      method: "POST",
      path: "/orders/{orderId}/cancel",
      input: { orderId: { type: "string", location: "path", required: true } },
      documentationRefs: [],
    },
    {
      id: "drop_order",
      description: "Drop an order",
      risk: "read",
      method: "DELETE",
      path: "/orders/{orderId}",
      input: { orderId: { type: "string", location: "path", required: true } },
      documentationRefs: [],
    },
  ],
};

function errorText(result: CallToolResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
}

describe("read-only tools", () => {
  let application: Application;
  let client: Client;
  let fetched: string[];
  let connectionId: string;
  let adapter: { id: string; version: number };

  beforeEach(async () => {
    fetched = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        fetched.push(`${init?.method ?? "GET"} ${input.toString()}`);
        return new Response(JSON.stringify({ orders: [] }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.example.test/index.html",
      allowedOrigin: "https://docs.example.test",
    });
    application.vault.storeFields("credentials-1", { "Api-Key": "key-secret" });
    const draft = application.adapters.create({
      slug: "fixture-orders",
      displayName: "Fixture Orders",
      documentationSourceId: source.id,
      dsl,
    });
    const working = application.adapters.markWorking(draft.id, draft.version);
    adapter = { id: working.id, version: working.version };
    connectionId = application.connections.createConnection({
      label: "Orders",
      documentationSourceId: source.id,
      allowedOrigins: ["https://api.example.test"],
      credentialSetId: "credentials-1",
      adapterId: adapter.id,
    }).id;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(application.mcpDependencies).connect(serverSide);
    client = new Client({ name: "read-only-tools-test", version: "1.0.0" });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    await client.close();
    application.db.close();
  });

  it("refuses a write in call_adapter and test_adapter_operation, even with a change mode or adapter version slipped into the input", async () => {
    const smuggled = { mode: "change", expectedAdapter: adapter };

    for (const operationId of ["cancel_order", "drop_order"]) {
      const args = { orderId: "order-1" };
      const called = await client.callTool({
        name: "call_adapter",
        arguments: { connectionId, operationId, args, ...smuggled },
      }) as CallToolResult;
      expect(called.isError, `call_adapter ${operationId}`).toBe(true);
      expect(errorText(called)).toContain(`Operation ${operationId} changes data`);
      expect(errorText(called)).toContain("request_change");

      const tested = await client.callTool({
        name: "test_adapter_operation",
        arguments: { connectionId, adapterId: adapter.id, operationId, args, ...smuggled },
      }) as CallToolResult;
      expect(tested.isError, `test_adapter_operation ${operationId}`).toBe(true);
      expect(errorText(tested)).toContain(`Operation ${operationId} changes data`);
    }

    // A host calling the handlers directly cannot switch the mode either.
    const tools = createToolHandlers(application.mcpDependencies);
    const direct = { connectionId, operationId: "cancel_order", args: { orderId: "order-1" }, ...smuggled };
    await expect(tools.call_adapter(direct)).rejects.toBeInstanceOf(WriteOperationError);
    await expect(tools.test_adapter_operation({ ...direct, adapterId: adapter.id })).rejects.toBeInstanceOf(WriteOperationError);
    expect(fetched).toEqual([]);

    // The slipped-in mode is ignored rather than refused: a read with it still runs as an ordinary call.
    const read = await client.callTool({
      name: "call_adapter",
      arguments: { connectionId, operationId: "list_orders", args: {}, ...smuggled },
    }) as CallToolResult;
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({ result: { ok: true, status: 200 } });
    expect(fetched).toEqual(["GET https://api.example.test/orders"]);
  });
});
