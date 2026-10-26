import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AdapterDsl } from "../../src/adapters/schema.js";
import type { AppConfig } from "../../src/config.js";
import { buildApplication, type Application } from "../../src/index.js";
import { CHANGE_CARD_URI, type ChangeCardData } from "../../src/mcp/card.js";
import { createMcpServer, createStdioMcpServer, toolAnnotations, type McpServerOptions, type ToolResultEvent } from "../../src/mcp/server.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 53),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api.shop.test"],
  credentialBindings: [{ fieldName: "Authorization", target: "header", headerName: "Authorization" }],
  operations: [
    {
      id: "set_price",
      description: "Set the price of a card",
      risk: "write",
      method: "POST",
      path: "/prices",
      input: {
        nmId: { type: "integer", location: "body", required: true, description: "Артикул" },
        price: { type: "integer", location: "body", required: true, description: "Цена, ₽" },
      },
      documentationRefs: [],
    },
  ],
};

const SUMMARY = "Set the price of 123456789 to 349";
// What a client that draws MCP Apps cards declares at initialize.
const DRAWS_CARDS = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

type ConfirmCard = Extract<ChangeCardData, { kind: "confirm" }>;
type Answered = { result: { status: string; changeId?: string; confirmation?: { url: string } } };

describe("the change card's tools", () => {
  let application: Application;
  let connectionId: string;
  let sent: string[];
  const clients: Client[] = [];

  // A server that offers the card unless the options say otherwise, and a client that declares what it draws.
  async function connect(options: McpServerOptions = {}, capabilities: Record<string, unknown> = {}): Promise<Client> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(application.mcpDependencies, { cards: true, ...options }).connect(serverSide);
    const client = new Client({ name: "card-tools-test", version: "1.0.0" }, { capabilities });
    await client.connect(clientSide);
    clients.push(client);
    return client;
  }

  const cardTokenHash = (changeId: string) =>
    (application.db.prepare("select card_token_hash from change_requests where id = ?").get(changeId) as { card_token_hash: string | null })
      .card_token_hash;

  // A call the server refused, whether it answered with an error result or the SDK threw.
  const refusedCall = (client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    client.callTool({ name, arguments: args }).then(
      (result) => result as CallToolResult,
      (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: String(error) }] }),
    );

  const requestChange = async (client: Client, price = 349): Promise<CallToolResult> => client.callTool({
    name: "request_change",
    arguments: { connectionId, operationId: "set_price", args: { nmId: 123456789, price }, summary: SUMMARY },
  }) as Promise<CallToolResult>;

  // What the assistant reads: the text, never anything else of the result.
  const assistantSees = (result: CallToolResult): Answered["result"] => {
    const [first] = result.content;
    if (first?.type !== "text") throw new Error("request_change gave the assistant no text");
    return JSON.parse(first.text) as Answered["result"];
  };

  const cardOf = (result: CallToolResult): ChangeCardData => {
    const card = (result._meta as { apiunicon?: { card?: ChangeCardData } } | undefined)?.apiunicon?.card;
    if (!card) throw new Error("request_change gave the card nothing");
    return card;
  };

  const confirmCard = (result: CallToolResult): ConfirmCard => {
    const card = cardOf(result);
    if (card.kind !== "confirm") throw new Error(`Expected a confirmation card, got ${card.kind}`);
    return card;
  };

  const press = (client: Client, card: Pick<ConfirmCard, "changeId" | "cardToken" | "step">, decision: "run" | "cancel" = "run") =>
    client.callTool({
      name: "confirm_change",
      arguments: { changeId: card.changeId, cardToken: card.cardToken, decision, step: card.step },
    }) as Promise<CallToolResult>;

  beforeEach(() => {
    sent = [];
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"],
      fetchImpl: async (input, init) => {
        sent.push(`${init?.method ?? "GET"} ${input.toString()}`);
        return new Response(JSON.stringify({ updated: true }), { status: 200 });
      },
    });
    const source = application.connections.createDocumentationSource({
      rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test",
    });
    application.vault.storeFields("credentials-1", { Authorization: "shop-secret-1" });
    const draft = application.adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    const adapter = application.adapters.markWorking(draft.id, draft.version);
    connectionId = application.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"],
      credentialSetId: "credentials-1", adapterId: adapter.id,
    }).id;
    application.changes.setWrites(connectionId, true);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    application.db.close();
  });

  it("lists request_change with the card and confirm_change for the card alone", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = (name: string) => tools.find((candidate) => candidate.name === name);

    expect(tool("request_change")?._meta).toEqual({ ui: { resourceUri: CHANGE_CARD_URI }, "ui/resourceUri": CHANGE_CARD_URI });
    const confirm = tool("confirm_change");
    expect(confirm?._meta).toEqual({ ui: { visibility: ["app"] } });
    expect(Object.keys(confirm?.inputSchema.properties ?? {})).toEqual(["changeId", "cardToken", "decision", "step"]);
    expect(confirm?.inputSchema.properties?.["cardToken"]).toMatchObject({ type: "string", minLength: 1, maxLength: 64 });
    expect(confirm?.annotations).toEqual(toolAnnotations.changeRequest);
    expect(confirm?.title).toBe("Confirm change from card");
    expect(confirm?.description).toBe(
      "Only the change confirmation card calls this, when the person presses its button. Not for the assistant: it cannot confirm changes.",
    );
    // Every other tool is the model's: none carries a card or hides from it.
    for (const other of tools.filter(({ name }) => name !== "request_change" && name !== "confirm_change")) {
      expect(other._meta, other.name).toBeUndefined();
    }
  });

  it("serves the card among the resources", async () => {
    const client = await connect();

    const { resources } = await client.listResources();

    expect(resources.map(({ uri }) => uri)).toContain(CHANGE_CARD_URI);
    const read = await client.readResource({ uri: CHANGE_CARD_URI });
    expect(read.contents[0]).toMatchObject({ uri: CHANGE_CARD_URI, mimeType: "text/html;profile=mcp-app" });
  });

  it("serves neither the card nor its tool when the host leaves out request_change", async () => {
    const client = await connect({ omitTools: ["request_change"] });

    const { resources } = await client.listResources().catch(() => ({ resources: [] }));

    expect(resources.map(({ uri }) => uri)).not.toContain(CHANGE_CARD_URI);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    expect(names).not.toContain("request_change");
    expect(names).not.toContain("confirm_change");
    expect(names).toContain("get_change");
    const called = await refusedCall(client, "confirm_change", {
      changeId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", cardToken: "AbCdEfGhIjKlMnOpQrStUv", decision: "run", step: 0,
    });
    expect(called.isError).toBe(true);

    // Leaving out confirm_change alone keeps the card: it still shows the link.
    const linkOnly = await connect({ omitTools: ["confirm_change"] });
    expect((await linkOnly.listResources()).resources.map(({ uri }) => uri)).toContain(CHANGE_CARD_URI);
    expect((await linkOnly.listTools()).tools.map(({ name }) => name)).not.toContain("confirm_change");
  });

  it("gives the assistant the link without structuredContent and the card its token only in _meta", async () => {
    const client = await connect();

    const result = await requestChange(client);

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const seen = assistantSees(result);
    expect(seen).toMatchObject({ status: "pending", confirmation: { url: expect.stringContaining("/confirm/change/") } });
    const card = confirmCard(result);
    expect(card.cardToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(card.changeId).toBe(seen.changeId);
    expect(card.url).toBe(seen.confirmation?.url);
    expect(card.locale).toBe("en");
    expect(card.labels.run).toBe("Run");
    expect(JSON.stringify(result.content)).not.toContain(card.cardToken);
    expect(Object.keys(result).sort()).toEqual(["_meta", "content"]);

    const russian = confirmCard(await requestChange(await connect({ locale: "ru" }), 350));
    expect(russian.locale).toBe("ru");
    expect(russian.labels.run).toBe("Выполнить");
    expect(sent).toEqual([]);
  });

  it("runs the change when the card calls confirm_change, and get_change reports it", async () => {
    const client = await connect();
    const card = confirmCard(await requestChange(client));

    const pressed = await press(client, card);

    expect(pressed.isError).not.toBe(true);
    expect((pressed.structuredContent as { result: unknown }).result).toMatchObject({
      result: "decided", changeStatus: "succeeded", title: "Done",
    });
    // The card gets only the answer for it, never the change's values or the service's answer.
    expect(Object.keys((pressed.structuredContent as { result: object }).result).sort()).toEqual(
      ["changeStatus", "note", "result", "text", "title"],
    );
    expect(sent).toEqual(["POST https://api.shop.test/prices"]);

    const state = await client.callTool({ name: "get_change", arguments: { changeId: card.changeId } }) as CallToolResult;
    expect(state.structuredContent).toMatchObject({ result: { changeId: card.changeId, status: "succeeded" } });
    expect(application.changes.list({ connectionId, limit: 1 })[0]).toMatchObject({ id: card.changeId, confirmation: "card" });

    // The same card pressed again runs nothing and tells how the change ended.
    const again = await press(client, card);
    expect((again.structuredContent as { result: unknown }).result).toMatchObject({ result: "rejected", changeStatus: "succeeded" });
    expect(sent).toHaveLength(1);
  });

  it("cancels the change when the card says so", async () => {
    const client = await connect();
    const card = confirmCard(await requestChange(client));

    const cancelled = await press(client, card, "cancel");

    expect((cancelled.structuredContent as { result: unknown }).result).toMatchObject({
      result: "decided", changeStatus: "cancelled", title: "Cancelled",
    });
    expect(sent).toEqual([]);
  });

  it("refuses confirm_change without the card's token", async () => {
    const client = await connect();
    const first = await requestChange(client);
    const card = confirmCard(first);
    const other = confirmCard(await requestChange(client, 350));
    const linkToken = new URL(assistantSees(first).confirmation?.url ?? "").searchParams.get("t") ?? "";
    expect(linkToken).not.toBe("");

    for (const cardToken of [other.cardToken, linkToken]) {
      const refused = await press(client, { ...card, cardToken });
      expect(refused.isError, cardToken === linkToken ? "link token" : "another card's token").not.toBe(true);
      expect((refused.structuredContent as { result: unknown }).result).toMatchObject({ result: "rejected" });
    }
    // A token longer than any card's is refused before the tool runs.
    const long = await press(client, { ...card, cardToken: "A".repeat(65) });
    expect(long.isError).toBe(true);
    expect(sent).toEqual([]);
    expect(application.changes.list({ connectionId, limit: 2 }).map(({ status }) => status)).toEqual(["pending", "pending"]);
  });

  it("returns no structuredContent for any request_change answer", async () => {
    const client = await connect();

    // Changing data turned off: refused before anything is stored.
    application.changes.setWrites(connectionId, false);
    const refused = await requestChange(client);
    expect(refused.structuredContent).toBeUndefined();
    expect(assistantSees(refused)).toMatchObject({ status: "refused", reason: "writes_off" });
    expect(cardOf(refused).kind).toBe("outcome");
    application.changes.setWrites(connectionId, true);

    // Confirmation off, after the person confirmed this write once on its page: it runs at once.
    application.changes.setConfirmChanges(connectionId, false);
    const first = assistantSees(await requestChange(client));
    const token = new URL(first.confirmation?.url ?? "").searchParams.get("t") ?? "";
    expect(await application.changes.decide(first.changeId ?? "", token, "run", 0)).toMatchObject({ record: { status: "succeeded" } });
    const ran = await requestChange(client, 350);
    expect(ran.structuredContent).toBeUndefined();
    expect(assistantSees(ran)).toMatchObject({ status: "succeeded", changesConfirmation: "off" });
    expect(cardOf(ran)).toMatchObject({ kind: "outcome", title: "Done" });
    expect(sent).toHaveLength(2);
  });

  it("reports confirm_change to onToolResult without the token", async () => {
    const events: ToolResultEvent[] = [];
    const client = await connect({ onToolResult: (event) => events.push(event) });
    const card = confirmCard(await requestChange(client));
    const linkToken = new URL(card.url).searchParams.get("t") ?? "";

    await press(client, { ...card, cardToken: "B".repeat(22) });
    await press(client, card);

    expect(events.map(({ tool, ok }) => [tool, ok])).toEqual([
      ["request_change", true], ["confirm_change", true], ["confirm_change", true],
    ]);
    expect(events[2]).toMatchObject({ tool: "confirm_change", ok: true, connectionId: null, detail: null });
    const reported = JSON.stringify(events);
    for (const secret of [card.cardToken, linkToken, SUMMARY]) expect(reported).not.toContain(secret);
  });

  describe("for a client that draws no card", () => {
    it("is off by default: the link alone, no card token, and neither the card's tool nor its page", async () => {
      for (const options of [{ cards: undefined }, { cards: false }] as const) {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        const plain = options.cards === undefined ? {} : { cards: options.cards };
        await createMcpServer(application.mcpDependencies, plain).connect(serverSide);
        const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: DRAWS_CARDS });
        await client.connect(clientSide);
        clients.push(client);
        const label = `cards: ${String(options.cards)}`;

        const { tools } = await client.listTools();
        expect(tools.map(({ name }) => name), label).not.toContain("confirm_change");
        // Without the card there is nothing for the host to draw request_change with.
        expect(tools.find(({ name }) => name === "request_change")?._meta, label).toBeUndefined();
        const { resources } = await client.listResources().catch(() => ({ resources: [] }));
        expect(resources.map(({ uri }) => uri), label).not.toContain(CHANGE_CARD_URI);

        const result = await requestChange(client, options.cards === undefined ? 351 : 352);
        expect(Object.keys(result), label).toEqual(["content"]);
        const seen = assistantSees(result);
        expect(seen, label).toMatchObject({ status: "pending", confirmation: { url: expect.stringContaining("/confirm/change/") } });
        expect(cardTokenHash(seen.changeId ?? ""), label).toBeNull();

        const pressed = await refusedCall(client, "confirm_change", {
          changeId: seen.changeId, cardToken: "A".repeat(22), decision: "run", step: 0,
        });
        expect(pressed.isError, label).toBe(true);
      }
      expect(sent).toEqual([]);
    });

    it("on stdio offers the card only to a client that declared it draws cards at initialize", async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createStdioMcpServer(application.mcpDependencies).connect(serverSide);
      const drawing = new Client({ name: "claude-desktop", version: "1.0.0" }, { capabilities: DRAWS_CARDS });
      await drawing.connect(clientSide);
      clients.push(drawing);
      const drawingTools = (await drawing.listTools()).tools;
      expect(drawingTools.map(({ name }) => name)).toContain("confirm_change");
      expect(drawingTools.find(({ name }) => name === "request_change")?._meta)
        .toEqual({ ui: { resourceUri: CHANGE_CARD_URI }, "ui/resourceUri": CHANGE_CARD_URI });
      expect((await drawing.listResources()).resources.map(({ uri }) => uri)).toEqual([CHANGE_CARD_URI]);
      const card = confirmCard(await requestChange(drawing));
      expect(cardTokenHash(card.changeId)).not.toBeNull();

      // Claude Code and older clients declare no UI extension, or one without the cards' type.
      for (const capabilities of [{}, { extensions: { "io.modelcontextprotocol/ui": {} } }, { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html"] } } }]) {
        const label = JSON.stringify(capabilities);
        const [otherSide, otherServer] = InMemoryTransport.createLinkedPair();
        await createStdioMcpServer(application.mcpDependencies).connect(otherServer);
        const plain = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities });
        await plain.connect(otherSide);
        clients.push(plain);

        const plainTools = (await plain.listTools()).tools;
        expect(plainTools.map(({ name }) => name), label).not.toContain("confirm_change");
        // Nor does request_change name a card for the host to draw its result with.
        expect(plainTools.find(({ name }) => name === "request_change")?._meta, label).toBeUndefined();
        expect((await plain.listResources()).resources, label).toEqual([]);
        expect((await refusedCall(plain, "confirm_change", {
          changeId: card.changeId, cardToken: card.cardToken, decision: "run", step: 0,
        })).isError, label).toBe(true);
        expect(await plain.readResource({ uri: CHANGE_CARD_URI }).then(() => "read", () => "refused"), label).toBe("refused");
        const result = await requestChange(plain, 360);
        expect(Object.keys(result), label).toEqual(["content"]);
        expect(cardTokenHash(assistantSees(result).changeId ?? ""), label).toBeNull();
      }
      // Even with the right token, a client without cards ran nothing and the drawing client's card still works.
      expect(sent).toEqual([]);
      expect((await press(drawing, card)).structuredContent).toMatchObject({ result: { result: "decided", changeStatus: "succeeded" } });
      expect(sent).toHaveLength(1);
    });

    it("asks a function at every call, and refuses confirm_change without reading the token once it says no", async () => {
      let draws = true;
      const client = await connect({ cards: () => draws }, DRAWS_CARDS);
      const card = confirmCard(await requestChange(client));

      draws = false;
      const pressed = await press(client, card);
      expect(pressed.isError).toBe(true);
      expect(pressed.content).toEqual([{
        type: "text",
        text: "This client shows no change card, so nothing can be confirmed here. Changes are confirmed on their page.",
      }]);
      expect(application.db.prepare("select status, card_failures from change_requests where id = ?").get(card.changeId))
        .toEqual({ status: "pending", card_failures: 0 });
      const later = await requestChange(client, 350);
      expect(Object.keys(later)).toEqual(["content"]);
      expect(cardTokenHash(assistantSees(later).changeId ?? "")).toBeNull();

      // A function that throws says no.
      const throwing = await connect({ cards: () => { throw new Error("unknown client"); } }, DRAWS_CARDS);
      const throwingTools = (await throwing.listTools()).tools;
      expect(throwingTools.map(({ name }) => name)).not.toContain("confirm_change");
      expect(throwingTools.find(({ name }) => name === "request_change")?._meta).toBeUndefined();
      expect(Object.keys(await requestChange(throwing, 351))).toEqual(["content"]);
      expect(sent).toEqual([]);
    });
  });
});
