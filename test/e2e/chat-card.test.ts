import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import type { CardAnswer, ChangeCardData } from "../../src/mcp/card.js";
import { createStdioMcpServer } from "../../src/mcp/server.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 67),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const SECRET = "shop-secret-for-the-card";
const SUMMARY = "Set the price of 123456789 to 349, as asked in the chat";

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [{
    id: "set_price",
    description: "Set the price of a card",
    risk: "write",
    method: "POST",
    path: "/prices",
    input: {
      nmId: { type: "integer", location: "body", required: true, description: "Card number" },
      price: { type: "integer", location: "body", required: true, description: "Price" },
    },
    documentationRefs: [],
  }],
};

// Everything the process writes to stderr, and everything it says on the console, while the test runs.
function captureOutput(): { output: () => string; restore: () => void } {
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return (write as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    }));
  return {
    output: () => written.join("\n"),
    restore: () => {
      process.stderr.write = write;
      for (const spy of spies) spy.mockRestore();
    },
  };
}

// What a client that draws MCP Apps cards declares at initialize.
const DRAWS_CARDS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

describe("the chat card on this computer", () => {
  let application: Application | undefined;
  let client: Client | undefined;
  let captured: ReturnType<typeof captureOutput> | undefined;

  afterEach(async () => {
    captured?.restore();
    await client?.close();
    application?.db.close();
  });

  // A shop whose one connection may change data, and the local server over stdio with a client that connects as named
  // and declares what it draws.
  async function localShop(clientName: string, capabilities: Record<string, unknown>) {
    const sent: string[] = [];
    const app = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? "GET"} ${input.toString()} ${typeof init?.body === "string" ? init.body : ""}`);
        return new Response(JSON.stringify({ updated: true }), { status: 200 });
      },
    });
    application = app;
    const source = app.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    app.vault.storeFields("credentials-1", { Authorization: SECRET });
    const draft = app.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapter = app.adapters.markWorking(draft.id, draft.version);
    const connectionId = app.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1", adapterId: adapter.id,
    }).id;
    app.changes.setWrites(connectionId, true);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createStdioMcpServer(app.mcpDependencies).connect(serverSide);
    const connected = new Client({ name: clientName, version: "1.0.0" }, { capabilities });
    client = connected;
    await connected.connect(clientSide);
    const call = (name: string, args: Record<string, unknown>) => connected.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    return { app, connectionId, sent, client: connected, call };
  }

  it("confirms a change from the chat card on this computer", async () => {
    captured = captureOutput();
    // A client that says at initialize that it draws cards.
    const { app: application, connectionId, sent, call } = await localShop("claude-desktop", DRAWS_CARDS);

    // The assistant asks; it is given the local link, and the card its data in English.
    const requested = await call("request_change", {
      connectionId, operationId: "set_price", args: { nmId: 123456789, price: 349 }, summary: SUMMARY,
    });
    expect(requested.structuredContent).toBeUndefined();
    const [text] = requested.content;
    if (text?.type !== "text") throw new Error("request_change gave the assistant no text");
    const seen = JSON.parse(text.text) as { status: string; changeId: string; confirmation: { url: string } };
    expect(seen.status).toBe("pending");
    expect(seen.confirmation.url.startsWith(`http://127.0.0.1:3210/confirm/change/${seen.changeId}?t=`)).toBe(true);
    const card = (requested._meta as { apiunicon: { card: ChangeCardData } }).apiunicon.card;
    if (card.kind !== "confirm") throw new Error("Expected a confirmation card");
    expect(card).toMatchObject({ locale: "en", changeId: seen.changeId, url: seen.confirmation.url, step: 0, risk: "write" });
    expect(card.labels.run).toBe("Run");
    const linkToken = new URL(seen.confirmation.url).searchParams.get("t") ?? "";
    expect(text.text).not.toContain(card.cardToken);

    // The same client, as the card: presses that do not fit first, then the person's.
    const answerOf = (result: CallToolResult) => (result.structuredContent as { result: CardAnswer }).result;
    const press = (cardToken: string, changeId = card.changeId) =>
      call("confirm_change", { changeId, cardToken, decision: "run", step: 0 });
    expect(answerOf(await press(linkToken))).toMatchObject({ result: "rejected", changeStatus: "pending" });
    expect(answerOf(await press(card.cardToken, randomUUID()))).toMatchObject({ result: "rejected", changeStatus: null });
    expect((await press(`${card.cardToken}${"x".repeat(60)}`)).isError).toBe(true);
    expect(sent).toEqual([]);

    const decided = answerOf(await press(card.cardToken));
    expect(decided).toMatchObject({ result: "decided", changeStatus: "succeeded", title: "Done" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("POST https://api.shop.test/prices");

    // The assistant learns the outcome through get_change, as the instructions tell it.
    const state = await call("get_change", { changeId: seen.changeId });
    expect(state.structuredContent).toMatchObject({ result: { changeId: seen.changeId, status: "succeeded" } });
    expect(application.changes.list({ connectionId, limit: 1 })[0]).toMatchObject({ id: seen.changeId, confirmation: "card" });
    // Pressed again, the card runs nothing.
    expect(answerOf(await press(card.cardToken))).toMatchObject({ result: "rejected", changeStatus: "succeeded" });
    expect(sent).toHaveLength(1);

    // Nothing the process wrote out carries the card's token, the link's token, the assistant's words or the key.
    const output = captured.output();
    for (const secret of [card.cardToken, linkToken, SUMMARY, SECRET]) expect(output).not.toContain(secret);
  });

  it("gives a client that draws no card the link alone, makes no card token for it and lets it confirm nothing", async () => {
    // Claude Code over stdio: it declares no UI extension.
    const { app, connectionId, sent, client: connected, call } = await localShop("claude-code", {});

    const names = (await connected.listTools()).tools.map(({ name }) => name);
    expect(names).toContain("request_change");
    expect(names).not.toContain("confirm_change");
    expect((await connected.listResources()).resources).toEqual([]);

    const requested = await call("request_change", {
      connectionId, operationId: "set_price", args: { nmId: 123456789, price: 349 }, summary: SUMMARY,
    });
    expect(Object.keys(requested)).toEqual(["content"]);
    const [text] = requested.content;
    if (text?.type !== "text") throw new Error("request_change gave the assistant no text");
    const seen = JSON.parse(text.text) as { status: string; changeId: string; confirmation: { url: string } };
    expect(seen.status).toBe("pending");
    expect(seen.confirmation.url.startsWith(`http://127.0.0.1:3210/confirm/change/${seen.changeId}?t=`)).toBe(true);
    // No card token exists for the change, so nothing but its link can decide it.
    expect(app.db.prepare("select card_token_hash from change_requests where id = ?").get(seen.changeId)).toEqual({ card_token_hash: null });

    // The model calling the card's tool is refused before anything is read or counted.
    const pressed = await call("confirm_change", { changeId: seen.changeId, cardToken: "A".repeat(22), decision: "run", step: 0 })
      .catch((error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String(error) }] }));
    expect(pressed.isError).toBe(true);
    expect(app.db.prepare("select status, card_failures from change_requests where id = ?").get(seen.changeId))
      .toEqual({ status: "pending", card_failures: 0 });
    expect(sent).toEqual([]);
  });
});
