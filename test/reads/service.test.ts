import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository, type AdapterRecord } from "../../src/adapters/repository.js";
import type { AdapterDsl, AdapterOperation } from "../../src/adapters/schema.js";
import {
  ConnectionActionLinkRepository, MAX_READ_APPROVAL_LINKS, READ_APPROVAL_LINK_TTL_MS,
} from "../../src/connections/action-links.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { catalogApprovedForms, readForm, ReadApprovalRepository } from "../../src/reads/repository.js";
import { ReadApprovalService } from "../../src/reads/service.js";

const BASE = "http://127.0.0.1:3210";
const ORIGIN = "https://api.shop.test";

const operation = (overrides: Partial<AdapterOperation> & Pick<AdapterOperation, "id">): AdapterOperation => ({
  description: "List orders", risk: "read", method: "POST", path: "/orders/list", input: {}, documentationRefs: [], ...overrides,
});

// Two reads sent with POST, a GET read, a write sent with POST and a read-labelled PUT, which the method makes a write.
const dsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: [ORIGIN, "https://stats.shop.test"],
  credentialBindings: [{ fieldName: "X-Shop-Key", target: "header", headerName: "X-Shop-Key" }],
  operations: [
    operation({ id: "list_orders" }),
    operation({
      id: "sales_report", description: "Sales for a period", path: "/v1/sales/{shop}", origin: "https://stats.shop.test",
      input: {
        shop: { type: "string", location: "path", required: true },
        from: { type: "string", location: "query", required: true },
        limit: { type: "integer", location: "body", required: false },
        filter: { type: "object", location: "body", required: false },
        ids: { type: "array", location: "body", required: false },
        archived: { type: "boolean", location: "query", required: false },
      },
    }),
    operation({ id: "get_order", method: "GET", path: "/orders/{id}", input: { id: { type: "string", location: "path", required: true } } }),
    operation({ id: "ship_order", risk: "write", path: "/orders/ship" }),
    operation({ id: "replace_order", method: "PUT", path: "/orders/replace" }),
  ],
};

describe("approving reads sent with POST", () => {
  let db: Database.Database;
  let now: Date;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let approvals: ReadApprovalRepository;
  let links: ConnectionActionLinkRepository;
  let service: ReadApprovalService;
  let adapter: AdapterRecord;
  let connectionId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    now = new Date("2026-10-26T10:00:00.000Z");
    const clock = () => now;
    adapters = new AdapterRepository(db, clock);
    connections = new ConnectionRepository(db, clock);
    approvals = new ReadApprovalRepository(db, clock);
    links = new ConnectionActionLinkRepository(db, clock);
    service = new ReadApprovalService({ db, adapters, connections, approvals, links });
    const credentialSet = db.prepare("insert into credential_sets (id, created_at, updated_at) values (?, ?, ?)");
    for (const id of ["keys-1", "keys-2", "keys-3"]) credentialSet.run(id, now.toISOString(), now.toISOString());
    const source = connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    adapter = adapters.create({ slug: "shop", displayName: "Shop", documentationSourceId: source.id, dsl });
    connectionId = connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: [ORIGIN, "https://stats.shop.test"], credentialSetId: "keys-1",
      adapterId: adapter.id,
    }).id;
  });

  afterEach(() => db.close());

  const tokenOf = (url: string) => new URL(url).searchParams.get("t") ?? "";

  function secondConnection(): string {
    const { documentationSourceId } = connections.getConnection(connectionId);
    return connections.createConnection({
      label: "Shop 2", documentationSourceId, allowedOrigins: [ORIGIN], credentialSetId: "keys-2", adapterId: adapter.id,
    }).id;
  }

  it("lists only the reads sent with POST, of a draft adapter too, with the host and path they go to and their inputs", () => {
    expect(adapter.status).toBe("draft");
    expect(service.pending(connectionId)).toEqual([
      { operationId: "list_orders", method: "POST", url: "https://api.shop.test/orders/list", description: "List orders", inputs: [] },
      {
        operationId: "sales_report", method: "POST", url: "https://stats.shop.test/v1/sales/{shop}", description: "Sales for a period",
        // Text anywhere, and an object or a list in the body, can carry anything: those are marked free-form.
        inputs: [
          { name: "shop", type: "string", location: "path", required: true, freeForm: false },
          { name: "from", type: "string", location: "query", required: true, freeForm: true },
          { name: "limit", type: "integer", location: "body", required: false, freeForm: false },
          { name: "filter", type: "object", location: "body", required: false, freeForm: true },
          { name: "ids", type: "array", location: "body", required: false, freeForm: true },
          { name: "archived", type: "boolean", location: "query", required: false, freeForm: false },
        ],
      },
    ]);
    expect(service.pendingCount(connectionId)).toBe(2);

    const { documentationSourceId } = connections.getConnection(connectionId);
    const bare = connections.createConnection({ label: "Bare", documentationSourceId, allowedOrigins: [ORIGIN], credentialSetId: "keys-3" });
    expect(service.pending(bare.id)).toEqual([]);
    expect(service.link(bare.id, BASE)).toBeNull();
  });

  it("gives a link that opens the list and approves exactly it, once", () => {
    const link = service.link(connectionId, `${BASE}/`)!;
    expect(link.url).toMatch(new RegExp(`^${BASE}/confirm/reads/${connectionId}\\?t=[A-Za-z0-9_-]{43}$`, "u"));
    expect(link).toMatchObject({ connectionId, operationIds: ["list_orders", "sales_report"] });
    expect(Date.parse(link.expiresAt) - now.getTime()).toBe(READ_APPROVAL_LINK_TTL_MS);

    const token = tokenOf(link.url);
    const view = service.open(connectionId, token)!;
    expect(view).toMatchObject({ connectionId, connectionLabel: "Shop" });
    expect(view.reads.map(({ operationId }) => operationId)).toEqual(["list_orders", "sales_report"]);
    expect(service.open(connectionId, token)?.fingerprint).toBe(view.fingerprint);

    expect(service.approve(connectionId, token, "another list")).toEqual({ kind: "changed" });
    expect(service.approve(connectionId, token, view.fingerprint)).toEqual({ kind: "approved", operationIds: ["list_orders", "sales_report"] });
    expect(service.pending(connectionId)).toEqual([]);
    expect(approvals.approves(connectionId, dsl, dsl.operations[0]!)).toBe(true);
    expect(db.prepare("select source, approved_at from read_approvals where connection_id = ?").all(connectionId)).toEqual([
      { source: "person", approved_at: now.toISOString() },
      { source: "person", approved_at: now.toISOString() },
    ]);

    // One time only: the used link opens nothing, approves nothing and declines nothing.
    expect(service.open(connectionId, token)).toBeNull();
    expect(service.approve(connectionId, token, view.fingerprint)).toEqual({ kind: "invalid" });
    expect(service.decline(connectionId, token)).toBe(false);
    expect(service.link(connectionId, BASE)).toBeNull();
  });

  it("approves nothing when the list changed after the page opened, and keeps the link working", () => {
    const token = tokenOf(service.link(connectionId, BASE)!.url);
    const shown = service.open(connectionId, token)!;
    const edited = adapters.patch(adapter.id, adapter.version, {
      ...dsl,
      operations: dsl.operations.map((item) => (item.id === "list_orders" ? { ...item, description: "List orders and archive old ones" } : item)),
    });

    expect(service.approve(connectionId, token, shown.fingerprint)).toEqual({ kind: "changed" });
    expect(approvals.approvedForms(connectionId).size).toBe(0);
    const again = service.open(connectionId, token)!;
    expect(again.reads[0]?.description).toBe("List orders and archive old ones");
    expect(service.approve(connectionId, token, again.fingerprint)).toMatchObject({ kind: "approved" });
    expect(approvals.approves(connectionId, edited.dsl, edited.dsl.operations[0]!)).toBe(true);
    expect(approvals.approves(connectionId, dsl, dsl.operations[0]!)).toBe(false);
  });

  it("approves nothing on decline, and uses the link", () => {
    const token = tokenOf(service.link(connectionId, BASE)!.url);
    const { fingerprint } = service.open(connectionId, token)!;

    expect(service.decline(connectionId, token)).toBe(true);
    expect(service.decline(connectionId, token)).toBe(false);
    expect(service.approve(connectionId, token, fingerprint)).toEqual({ kind: "invalid" });
    expect(service.pendingCount(connectionId)).toBe(2);
  });

  it("refuses an expired link, another connection's link, and a token of the wrong shape", () => {
    const second = secondConnection();
    const token = tokenOf(service.link(connectionId, BASE)!.url);
    const { fingerprint } = service.open(connectionId, token)!;

    expect(service.open(second, token)).toBeNull();
    expect(service.approve(second, token, fingerprint)).toEqual({ kind: "invalid" });
    expect(service.open(connectionId, "short")).toBeNull();
    now = new Date(now.getTime() + READ_APPROVAL_LINK_TTL_MS);
    expect(service.open(connectionId, token)).toBeNull();
    expect(service.approve(connectionId, token, fingerprint)).toEqual({ kind: "invalid" });
    expect(service.decline(connectionId, token)).toBe(false);
    expect(service.pendingCount(connectionId)).toBe(2);
  });

  it("applies an approval to its own connection only", () => {
    const second = secondConnection();
    const token = tokenOf(service.link(connectionId, BASE)!.url);
    service.approve(connectionId, token, service.open(connectionId, token)!.fingerprint);

    expect(service.pendingCount(connectionId)).toBe(0);
    expect(service.pendingCount(second)).toBe(2);
    expect(approvals.approves(second, dsl, dsl.operations[0]!)).toBe(false);
  });

  it("keeps earlier approval links working, up to a limit, while a deletion link still replaces the last one", () => {
    const tokens = Array.from({ length: MAX_READ_APPROVAL_LINKS + 1 }, () => tokenOf(service.link(connectionId, BASE)!.url));

    expect(service.open(connectionId, tokens[0]!)).toBeNull();
    for (const token of tokens.slice(1)) expect(service.open(connectionId, token)).not.toBeNull();
    const deletion = links.issue(connectionId, "delete");
    expect(links.issue(connectionId, "delete").token).not.toBe(deletion.token);
    expect(links.verify(connectionId, "delete", deletion.token)).toBe(false);
    expect(service.open(connectionId, tokens[1]!)).not.toBeNull();
    // An approval token is not a deletion's, nor the other way round.
    expect(links.verify(connectionId, "delete", tokens[1]!)).toBe(false);
  });

  it("gives links for every connection an edited adapter serves whose reads wait", () => {
    const second = secondConnection();
    const token = tokenOf(service.link(connectionId, BASE)!.url);
    service.approve(connectionId, token, service.open(connectionId, token)!.fingerprint);

    expect(service.linksForAdapter(adapter.id, BASE).map((link) => link.connectionId)).toEqual([second]);
  });

  it("names a read's form by the operation and the host it goes to", () => {
    const [list] = dsl.operations;
    expect(readForm(dsl, list!)).toMatch(/^[0-9a-f]{64}$/u);
    expect(readForm(dsl, { ...list!, risk: "write" })).not.toBe(readForm(dsl, list!));
    expect(readForm({ baseOrigins: ["https://stats.shop.test"] }, list!)).not.toBe(readForm(dsl, list!));
    // Keys in another order are the same form.
    const reordered = Object.fromEntries(Object.entries(list!).reverse()) as AdapterOperation;
    expect(readForm(dsl, reordered)).toBe(readForm(dsl, list!));
  });

  it("brings the catalog's approval only for a copy still at version 1", () => {
    const copy = { catalogEntryId: "entry-1", version: 1, dsl };
    expect(catalogApprovedForms(copy)).toEqual([readForm(dsl, dsl.operations[0]!), readForm(dsl, dsl.operations[1]!)]);
    expect(catalogApprovedForms({ ...copy, version: 2 })).toEqual([]);
    expect(catalogApprovedForms({ ...copy, catalogEntryId: null })).toEqual([]);
  });
});
