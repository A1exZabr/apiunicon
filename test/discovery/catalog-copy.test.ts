import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../src/config.js";
import type { ConnectionDraftRecord } from "../../src/discovery/repository.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application } from "../../src/index.js";
import { WB_ENTRY_ID, WB_LINK, wbEntry } from "../fixtures/catalog.js";
import { cookieHeader } from "../http/helpers.js";

const config: AppConfig = {
  stateDir: ".", binDir: ".", dbPath: ":memory:", masterKey: Buffer.alloc(32, 31),
  httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768,
  requestTimeoutMs: 1_000, maxCrawlPages: 5,
};

describe("copying a catalog entry", () => {
  let application: Application | undefined;

  afterEach(() => application?.db.close());

  function app(fetchImpl: typeof fetch = async () => new Response("", { status: 498 })): Application {
    application = buildApplication(config, { resolver: async () => ["8.8.8.8"], fetchImpl });
    return application;
  }

  function count(target: Application, table: string): number {
    return (target.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  }

  it("copies the entry as a private working adapter and goes straight to key entry", () => {
    const target = app();

    const draft = target.discovery.startFromCatalog(WB_LINK, wbEntry());

    expect(draft).toMatchObject({
      status: "needs_review",
      serviceName: "Wildberries Statistics",
      provenanceSummary: { kind: "catalog", entryId: WB_ENTRY_ID, version: 3 },
    });
    expect(draft.discovery.origins.map(({ origin, confidence }) => ({ origin, confidence })))
      .toEqual([{ origin: "https://statistics-api.wildberries.ru", confidence: "high" }]);
    expect(draft.discovery.credentials.map(({ fieldName }) => fieldName)).toEqual(["Authorization"]);
    const copy = target.adapters.findCatalogCopy(draft.documentationSourceId, WB_ENTRY_ID);
    expect(copy).toMatchObject({
      slug: "wildberries-statistics",
      displayName: "Wildberries Statistics",
      visibility: "private",
      status: "working",
      version: 1,
      catalogEntryId: WB_ENTRY_ID,
      catalogVersion: 3,
      dsl: wbEntry().dsl,
    });
    // No documentation is read for a catalog draft.
    expect(count(target, "jobs")).toBe(0);
  });

  it("copies an entry with write operations, with changing data off on the new connection", async () => {
    const calls: string[] = [];
    const target = app(async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const base = wbEntry().dsl.operations[0]!;
    const entry = wbEntry({
      dsl: {
        ...wbEntry().dsl,
        operations: [
          base,
          {
            id: "update_price", description: "Change the price of one card", risk: "write", method: "PUT", path: "/api/v1/cards/{cardId}",
            input: {
              cardId: { type: "string", location: "path", required: true, description: "The card to change" },
              price: { type: "number", location: "body", required: true, description: "The new price" },
            },
            documentationRefs: [],
          },
          {
            id: "delete_card", description: "Delete one card for good", risk: "destructive", method: "DELETE", path: "/api/v1/cards/{cardId}",
            input: { cardId: { type: "string", location: "path", required: true, description: "The card to delete" } },
            documentationRefs: [],
          },
        ],
      },
    });
    const draft = target.discovery.startFromCatalog(WB_LINK, entry);
    const copy = target.adapters.findCatalogCopy(draft.documentationSourceId, WB_ENTRY_ID)!;

    // The copy keeps the operations as published, with their labels.
    expect(copy.dsl).toEqual(entry.dsl);
    expect(copy.dsl.operations.map(({ id, risk }) => [id, risk])).toEqual([
      ["report_sales", "read"], ["update_price", "write"], ["delete_card", "destructive"],
    ]);
    const connection = target.discovery.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "wb-token" },
    });

    expect(connection.adapterId).toBe(copy.id);
    expect(connection.writesEnabled).toBe(false);
    expect(target.connections.getConnection(connection.id).writesEnabled).toBe(false);
    // Off means off: no request for the change is taken, and nothing is sent to the service.
    const ask = (operationId: string, args: Record<string, unknown>) =>
      target.changes.request({ connectionId: connection.id, operationId, args, summary: "Change a card", baseUrl: "http://127.0.0.1:3210", requestedVia: "Claude" });
    await expect(ask("update_price", { cardId: "c1", price: 10 })).resolves.toMatchObject({ status: "refused", reason: "writes_off" });
    await expect(ask("delete_card", { cardId: "c1" })).resolves.toMatchObject({ status: "refused", reason: "writes_off" });
    expect(calls).toEqual([]);
    // Only the person's own switch turns it on; then the copy's writes wait for their confirmation.
    target.changes.setWrites(connection.id, true);
    await expect(ask("update_price", { cardId: "c1", price: 10 })).resolves.toMatchObject({ status: "pending", risk: "write" });
    await expect(ask("delete_card", { cardId: "c1" })).resolves.toMatchObject({ status: "pending", risk: "destructive" });
    expect(calls).toEqual([]);
  });

  it("adds a number to a slug this database already uses", () => {
    const target = app();
    const source = target.connections.createDocumentationSource({ rootUrl: "https://dev.wildberries.ru/docs/own", allowedOrigin: "https://dev.wildberries.ru" });
    target.adapters.create({ slug: "wildberries-statistics", displayName: "Own", documentationSourceId: source.id, dsl: wbEntry().dsl });

    const first = target.discovery.startFromCatalog(WB_LINK, wbEntry());
    const second = target.discovery.startFromCatalog("https://dev.wildberries.ru/docs/openapi/finance", wbEntry());

    expect(target.adapters.findCatalogCopy(first.documentationSourceId, WB_ENTRY_ID)?.slug).toBe("wildberries-statistics-2");
    expect(target.adapters.findCatalogCopy(second.documentationSourceId, WB_ENTRY_ID)?.slug).toBe("wildberries-statistics-3");
  });

  it("binds the copy when the keys are entered and erases it with the connection", () => {
    const target = app();
    const draft = target.discovery.startFromCatalog(WB_LINK, wbEntry());
    const copy = target.adapters.findCatalogCopy(draft.documentationSourceId, WB_ENTRY_ID)!;

    const connection = target.discovery.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "wb-token" },
    });

    expect(connection.adapterId).toBe(copy.id);
    expect(target.connections.adapterOnDelete(connection.id)).toBe("erased");
    target.connections.delete(connection.id);
    expect(() => target.adapters.get(copy.id)).toThrow(/not found/u);
    expect(count(target, "documentation_sources")).toBe(0);
  });

  it("binds each of two drafts of one entry to its own copy", () => {
    const target = app();
    const keys = (draft: ConnectionDraftRecord) => ({
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: draft.discovery.credentials.map(({ id }) => id),
      credentialValues: { [draft.discovery.credentials[0]!.id]: "wb-token" },
    });
    const first = target.discovery.startFromCatalog(WB_LINK, wbEntry());
    const second = target.discovery.startFromCatalog("https://dev.wildberries.ru/docs/openapi/finance", wbEntry());
    const firstCopy = target.adapters.findCatalogCopy(first.documentationSourceId, WB_ENTRY_ID)!;
    const secondCopy = target.adapters.findCatalogCopy(second.documentationSourceId, WB_ENTRY_ID)!;

    // Finished in the other order, so neither can pick up the most recent copy by chance.
    const secondConnection = target.discovery.completeWithSelection(second.id, keys(second));
    const firstConnection = target.discovery.completeWithSelection(first.id, keys(first));

    expect(firstCopy.id).not.toBe(secondCopy.id);
    expect(firstConnection.adapterId).toBe(firstCopy.id);
    expect(secondConnection.adapterId).toBe(secondCopy.id);
    target.connections.delete(firstConnection.id);
    expect(() => target.adapters.get(firstCopy.id)).toThrow(/not found/u);
    expect(target.adapters.get(secondCopy.id).id).toBe(secondCopy.id);
  });

  // What attach_documentation does to a catalog draft: the documents it reads replace the catalog as the draft's origin.
  function replaceByDocuments(target: Application, draft: ConnectionDraftRecord): ConnectionDraftRecord {
    target.documents.add({
      sourceId: draft.documentationSourceId,
      url: "https://dev.wildberries.ru/openapi/reports.yaml",
      kind: "openapi",
      provenance: "official",
      sha256: "a".repeat(64),
      byteSize: 100,
      discovery: draft.discovery,
      chunks: [],
    });
    return target.discovery.refreshFromDocuments(draft.id);
  }

  it("drops the copy at once when documentation replaces the catalog as the draft's origin, and frees its name", () => {
    const target = app();
    const draft = target.discovery.startFromCatalog(WB_LINK, wbEntry());
    expect(count(target, "adapters")).toBe(1);

    const refreshed = replaceByDocuments(target, draft);

    expect(refreshed.provenanceSummary).toMatchObject({ kind: "documents" });
    expect(target.adapters.findCatalogCopy(draft.documentationSourceId, WB_ENTRY_ID)).toBeNull();
    expect(count(target, "adapters")).toBe(0);
    const next = target.discovery.startFromCatalog("https://dev.wildberries.ru/docs/openapi/finance", wbEntry());
    expect(target.adapters.findCatalogCopy(next.documentationSourceId, WB_ENTRY_ID)?.slug).toBe("wildberries-statistics");
  });

  it("leaves nothing behind when a draft that lost its catalog copy to documentation is finished and deleted", () => {
    const target = app();
    const refreshed = replaceByDocuments(target, target.discovery.startFromCatalog(WB_LINK, wbEntry()));

    const connection = target.discovery.completeWithSelection(refreshed.id, {
      originIds: refreshed.discovery.origins.map(({ id }) => id),
      credentialIds: refreshed.discovery.credentials.map(({ id }) => id),
      credentialValues: { [refreshed.discovery.credentials[0]!.id]: "wb-token" },
    });

    expect(connection.adapterId).toBeNull();
    target.connections.delete(connection.id);
    expect([count(target, "adapters"), count(target, "documentation_sources")]).toEqual([0, 0]);
  });

  it("refuses an entry that does not fit the link and leaves nothing behind", () => {
    const target = app();

    expect(() => target.discovery.startFromCatalog(WB_LINK, wbEntry({ domain: "ozon.ru" }))).toThrow(/does not fit/u);

    expect([count(target, "adapters"), count(target, "connection_drafts"), count(target, "documentation_sources")]).toEqual([0, 0, 0]);
  });

  it.each([
    ["a destination on another domain", wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru", "https://collector.example.com"] } })],
    ["a destination on a lookalike domain", wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru.evil.com"] } })],
    ["a read that deletes", wbEntry({ dsl: { ...wbEntry().dsl, operations: [{ ...wbEntry().dsl.operations[0]!, method: "DELETE" }] } })],
    ["a GET that writes", wbEntry({ dsl: { ...wbEntry().dsl, operations: [{ ...wbEntry().dsl.operations[0]!, risk: "write" }] } })],
    ["a write with an undescribed input", wbEntry({ dsl: { ...wbEntry().dsl, operations: [{ ...wbEntry().dsl.operations[0]!, method: "POST", risk: "write" }] } })],
  ])("refuses an entry with %s and leaves nothing behind", (_case, entry) => {
    const target = app();

    expect(() => target.discovery.startFromCatalog(WB_LINK, entry)).toThrow(/does not fit/u);

    expect([count(target, "adapters"), count(target, "connection_drafts"), count(target, "documentation_sources")]).toEqual([0, 0, 0]);
  });

  it("knows when the link already has an own reusable adapter", () => {
    const target = app();
    expect(target.discovery.hasReusableAdapter(WB_LINK)).toBe(false);
    const source = target.connections.createDocumentationSource({ rootUrl: "https://dev.wildberries.ru/docs/own", allowedOrigin: "https://dev.wildberries.ru" });
    const created = target.adapters.create({ slug: "wb-own", displayName: "WB", documentationSourceId: source.id, dsl: wbEntry().dsl });
    const working = target.adapters.markWorking(created.id, created.version);
    target.adapters.markReusable(working.id, working.version);

    expect(target.discovery.hasReusableAdapter(WB_LINK)).toBe(true);
  });

  it("shows the catalog origin and every destination on the key-entry page", async () => {
    const target = app();
    const server = buildHttpServer(target);
    const draft = target.discovery.startFromCatalog(WB_LINK, wbEntry());
    const { token } = target.links.issue(draft.id);
    const headers = { host: "127.0.0.1:3210" };

    const opened = await server.inject({ method: "GET", url: `/connect/${draft.id}?t=${token}`, headers });
    const page = await server.inject({ method: "GET", url: `/connect/${draft.id}`, headers: { ...headers, cookie: cookieHeader(opened) } });

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("A ready-made adapter from the shared catalog, version 3.");
    expect(page.body).toContain("statistics-api.wildberries.ru");
    expect(page.body).toMatch(/name="originId" value="[^"]+" checked/u);
    await server.close();
  });
});
