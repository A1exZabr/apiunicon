import { describe, expect, it } from "vitest";

import type { AdapterOperation } from "../../src/adapters/schema.js";
import {
  CatalogAnswerSchema,
  catalogLookupUrl,
  catalogOperationProblem,
  catalogSlug,
  validateCatalogEntry,
  type CatalogOperationProblem,
} from "../../src/catalog/entry.js";
import { WB_LINK, wbEntry } from "../fixtures/catalog.js";

// Operations that change data, with every input described: what the person reads on the confirmation page.
const described = (type: "string" | "number" | "integer" | "boolean" | "object", location: "path" | "query" | "body", description: string) =>
  ({ type, location, required: true, description });

function updateCard(patch: Record<string, unknown> = {}): AdapterOperation {
  return {
    id: "update_card",
    description: "Change the price of one card",
    risk: "write",
    method: "PUT",
    path: "/api/v1/cards/{cardId}",
    input: { cardId: described("string", "path", "The card to change"), price: described("number", "body", "The new price") },
    documentationRefs: [],
    ...patch,
  } as AdapterOperation;
}

function deleteCard(patch: Record<string, unknown> = {}): AdapterOperation {
  return {
    id: "delete_card",
    description: "Delete one card for good",
    risk: "destructive",
    method: "DELETE",
    path: "/api/v1/cards/{cardId}",
    input: { cardId: described("string", "path", "The card to delete") },
    documentationRefs: [],
    ...patch,
  } as AdapterOperation;
}

// The fixture's read operation plus the given ones.
function entryWith(...operations: AdapterOperation[]) {
  return wbEntry({ dsl: { ...wbEntry().dsl, operations: [wbEntry().dsl.operations[0]!, ...operations] } });
}

describe("catalog entries", () => {
  it("accepts an entry for the link's domain and normalizes its adapter", () => {
    const entry = wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru/"] } });

    const accepted = validateCatalogEntry(entry, WB_LINK);

    expect(accepted?.entryId).toBe(entry.entryId);
    expect(accepted?.dsl.baseOrigins).toEqual(["https://statistics-api.wildberries.ru"]);
  });

  it("refuses an adapter the core schema rejects", () => {
    const insecure = wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["http://statistics-api.wildberries.ru"] } });
    const unsafePath = wbEntry({
      dsl: { ...wbEntry().dsl, operations: [{ ...wbEntry().dsl.operations[0]!, path: "/../admin" }] },
    });

    expect(validateCatalogEntry(insecure, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(unsafePath, WB_LINK)).toBeNull();
    for (const path of ["/api/v1/cards/{cardId}/..?x=1", "/api/v1/cards/{cardId}/%2E%2e/admin"]) {
      expect(validateCatalogEntry(entryWith(updateCard({ path })), WB_LINK)).toBeNull();
    }
    expect(validateCatalogEntry({ entryId: "x" }, WB_LINK)).toBeNull();
  });

  it("refuses an entry for another service or with a destination elsewhere", () => {
    const otherService = wbEntry({ domain: "ozon.ru" });
    const foreignOrigin = wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru", "https://collector.example.com"] } });

    expect(validateCatalogEntry(otherService, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(foreignOrigin, WB_LINK)).toBeNull();
  });

  it("keys an entry for a shared documentation host to the customer's own site", () => {
    const link = "https://acme.readme.io/reference";
    const onSharedHost = (domain: string, origin: string) =>
      wbEntry({ domain, dsl: { ...wbEntry().dsl, baseOrigins: [origin] } });

    expect(validateCatalogEntry(onSharedHost("acme.readme.io", "https://acme.readme.io"), link)?.domain).toBe("acme.readme.io");
    // The registrable domain alone names every customer of the host, and another customer's site is elsewhere.
    expect(validateCatalogEntry(onSharedHost("readme.io", "https://acme.readme.io"), link)).toBeNull();
    expect(validateCatalogEntry(onSharedHost("acme.readme.io", "https://evil.readme.io"), link)).toBeNull();
  });

  it("refuses an entry whose keys cannot be entered", () => {
    const keyless = wbEntry({ dsl: { ...wbEntry().dsl, credentialBindings: [] } });
    const oddField = wbEntry({ dsl: { ...wbEntry().dsl, credentialBindings: [{ fieldName: "api_key", target: "header", headerName: "X-Api-Key" }] } });

    expect(validateCatalogEntry(keyless, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(oddField, WB_LINK)).toBeNull();
  });

  it("refuses a read operation that changes data, and accepts a read through POST", () => {
    const withOperation = (patch: Record<string, unknown>) =>
      wbEntry({ dsl: { ...wbEntry().dsl, operations: [{ ...wbEntry().dsl.operations[0]!, ...patch }] } });

    for (const method of ["DELETE", "PUT", "PATCH"]) {
      expect(validateCatalogEntry(withOperation({ method, risk: "read" }), WB_LINK)).toBeNull();
    }
    expect(validateCatalogEntry(withOperation({ method: "POST", risk: "read" }), WB_LINK)).not.toBeNull();
    expect(validateCatalogEntry(withOperation({ method: "GET", risk: "read" }), WB_LINK)).not.toBeNull();
  });

  it("accepts write and destructive operations whose every input is described", () => {
    const createCard = updateCard({
      id: "create_card",
      method: "POST",
      path: "/api/v1/cards",
      input: { title: described("string", "body", "The title of the new card"), draft: described("boolean", "query", "Keep it as a draft") },
    });
    const noInput = updateCard({ id: "archive_all", method: "POST", path: "/api/v1/archive", input: {} });
    const entry = entryWith(updateCard(), createCard, deleteCard(), noInput);

    const accepted = validateCatalogEntry(entry, WB_LINK);

    expect(accepted?.dsl.operations.map(({ id, method, risk }) => [id, method, risk])).toEqual([
      ["report_sales", "GET", "read"],
      ["update_card", "PUT", "write"],
      ["create_card", "POST", "write"],
      ["delete_card", "DELETE", "destructive"],
      ["archive_all", "POST", "write"],
    ]);
    // A POST that deletes keeps its own label; only the methods that decide on their own are held to one.
    expect(validateCatalogEntry(entryWith(updateCard({ id: "purge", method: "POST", risk: "destructive" })), WB_LINK)).not.toBeNull();
    expect(validateCatalogEntry(entryWith(updateCard({ id: "bump", method: "PATCH", risk: "destructive" })), WB_LINK)).not.toBeNull();
  });

  it("refuses an entry with a GET that writes, a DELETE not marked destructive, a read PUT, or a write with an undescribed input", () => {
    const refused = (...operations: AdapterOperation[]) => validateCatalogEntry(entryWith(...operations), WB_LINK);
    const getThatWrites = updateCard({ id: "get_that_writes", method: "GET", path: "/api/v1/cards/{cardId}/touch", input: { cardId: described("string", "path", "The card") } });

    expect(refused(getThatWrites)).toBeNull();
    expect(refused({ ...getThatWrites, risk: "destructive" })).toBeNull();
    expect(refused(deleteCard({ risk: "read" }))).toBeNull();
    expect(refused(deleteCard({ risk: "write" }))).toBeNull();
    expect(refused(updateCard({ risk: "read" }))).toBeNull();
    expect(refused(updateCard({ id: "patch_card", method: "PATCH", risk: "read" }))).toBeNull();
    expect(refused(updateCard({ input: { cardId: described("string", "path", "The card to change"), price: { type: "number", location: "body", required: true } } }))).toBeNull();
    expect(refused(deleteCard({ input: { cardId: { type: "string", location: "path", required: true } } }))).toBeNull();
    // Blank is as good as missing: the person would read an empty line.
    expect(refused(updateCard({ input: { cardId: described("string", "path", "  \t\n"), price: described("number", "body", "The new price") } }))).toBeNull();
    // One bad operation refuses the whole entry, however many good ones come with it.
    expect(refused(updateCard(), deleteCard(), deleteCard({ id: "delete_other", risk: "read" }))).toBeNull();
    expect(refused(updateCard(), deleteCard())).not.toBeNull();
  });

  it("counts a description only when it has a character the person can see", () => {
    const withDescription = (description: string): AdapterOperation =>
      updateCard({ input: { cardId: described("string", "path", description) } });
    const blanks = [
      "\u3164", "\u2800", "\u115f\u1160", "\uffa0", "\u200b", "\u200e", "\ufeff", "\u00a0", "\u3000", "\u2028",
      "\u00ad", "\u034f", "\ufe0f", "\u0301", "\ud800", "\u{e0041}", "\u0007", "\ue000", "\u{10ffff}",
      "\u2800\u3164 \t\u200b",
    ];
    for (const description of blanks) {
      expect([description, catalogOperationProblem(withDescription(description))]).toEqual([description, "undescribed_write_input"]);
      expect(validateCatalogEntry(entryWith(withDescription(description)), WB_LINK), JSON.stringify(description)).toBeNull();
    }
    for (const description of ["The card", "\u3164Card", "Card\u2800", "Цена", "价格", "€", "\u{1f4b0}", "a\u0301", "1"]) {
      expect([description, catalogOperationProblem(withDescription(description))]).toEqual([description, null]);
    }
  });

  it("names the first rule an operation breaks, and checks every method against every label", () => {
    const operation = (method: AdapterOperation["method"], risk: AdapterOperation["risk"], input: AdapterOperation["input"] = {}): AdapterOperation =>
      ({ id: "op", description: "Operation", risk, method, path: "/api/v1/op", input, documentationRefs: [] });
    const table: Array<[AdapterOperation["method"], AdapterOperation["risk"], CatalogOperationProblem | null]> = [
      ["GET", "read", null], ["GET", "write", "get_not_read"], ["GET", "destructive", "get_not_read"],
      ["POST", "read", null], ["POST", "write", null], ["POST", "destructive", null],
      ["PUT", "read", "read_unsafe_method"], ["PUT", "write", null], ["PUT", "destructive", null],
      ["PATCH", "read", "read_unsafe_method"], ["PATCH", "write", null], ["PATCH", "destructive", null],
      ["DELETE", "read", "delete_not_destructive"], ["DELETE", "write", "delete_not_destructive"], ["DELETE", "destructive", null],
    ];

    for (const [method, risk, problem] of table) {
      expect([method, risk, catalogOperationProblem(operation(method, risk))]).toEqual([method, risk, problem]);
    }
    const undescribed = { cardId: { type: "string", location: "path", required: true } } as const;
    expect(catalogOperationProblem(operation("POST", "write", undescribed))).toBe("undescribed_write_input");
    expect(catalogOperationProblem(operation("DELETE", "destructive", undescribed))).toBe("undescribed_write_input");
    // A read is not held to descriptions: the person is never asked to confirm one.
    expect(catalogOperationProblem(operation("GET", "read", undescribed))).toBeNull();
    expect(catalogOperationProblem(operation("POST", "read", undescribed))).toBeNull();
  });

  it.each([
    ["a host that ends with another domain", "https://statistics-api.wildberries.ru.evil.com"],
    ["a domain that only ends with the name", "https://evilwildberries.ru"],
    ["the bare lookalike domain", "https://wildberries.ru.evil.com"],
  ])("refuses %s as a destination", (_case, origin) => {
    const base = wbEntry().dsl.operations[0]!;
    const asBase = wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: [origin] } });
    const besideBase = wbEntry({ dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru", origin] } });
    const onOperation = wbEntry({
      dsl: { ...wbEntry().dsl, baseOrigins: ["https://statistics-api.wildberries.ru", origin], operations: [{ ...base, origin }] },
    });

    expect(validateCatalogEntry(asBase, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(besideBase, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(onOperation, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(wbEntry({ domain: new URL(origin).hostname }), WB_LINK)).toBeNull();
  });

  it("accepts an operation on another host of the link's domain, and returns the domain in lower case", () => {
    const base = wbEntry().dsl.operations[0]!;
    const entry = wbEntry({
      domain: "WildBerries.RU",
      dsl: {
        ...wbEntry().dsl,
        baseOrigins: ["https://statistics-api.wildberries.ru", "https://content-api.wildberries.ru"],
        operations: [base, { ...base, id: "cards", origin: "https://content-api.wildberries.ru", path: "/content/v2/cards" }],
      },
    });

    expect(validateCatalogEntry(entry, WB_LINK)?.domain).toBe("wildberries.ru");
  });

  it("refuses documentation that is not served over HTTPS", () => {
    const entry = wbEntry({ documentation: [{ url: "http://dev.wildberries.ru/openapi/reports.yaml", sha256: null }] });

    expect(validateCatalogEntry(entry, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(wbEntry({ documentation: [{ url: "javascript:alert(1)", sha256: null }] }), WB_LINK)).toBeNull();
  });

  it("refuses checks of operations the adapter does not have, and too many checks", () => {
    const stray = wbEntry({ operationChecks: { report_sales: "verified", drop_everything: "verified" } });
    const tooMany = wbEntry({
      operationChecks: Object.fromEntries(Array.from({ length: 201 }, (_value, index) => [`op_${index}`, "verified" as const])),
    });

    expect(validateCatalogEntry(stray, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(tooMany, WB_LINK)).toBeNull();
    expect(validateCatalogEntry(wbEntry({ operationChecks: {} }), WB_LINK)).not.toBeNull();
  });

  it("refuses an entry when only one of several operations is a mislabelled read", () => {
    const base = wbEntry().dsl.operations[0]!;
    const entry = wbEntry({
      dsl: {
        ...wbEntry().dsl,
        operations: [base, { ...base, id: "drop_card", method: "DELETE", risk: "read" }],
      },
    });

    expect(validateCatalogEntry(entry, WB_LINK)).toBeNull();
  });

  it("cuts long catalog text instead of passing it on whole", () => {
    const accepted = validateCatalogEntry(wbEntry({ description: "x".repeat(5_000) }), WB_LINK);

    expect(accepted?.description).toHaveLength(1_000);
  });

  it("reads the cloud's answers and never a sign-in from it", () => {
    expect(CatalogAnswerSchema.safeParse({ kind: "entry", entry: wbEntry() }).success).toBe(true);
    expect(CatalogAnswerSchema.safeParse({
      kind: "candidates",
      candidates: [{ entryId: "a1", displayName: "Statistics", description: "Reports", operations: 4 }],
    }).success).toBe(true);
    expect(CatalogAnswerSchema.safeParse({ kind: "none", reason: "limited" }).success).toBe(true);
    expect(CatalogAnswerSchema.safeParse({ kind: "sign_in", url: "https://evil.example/" }).success).toBe(false);
  });

  it("looks an IDN link up by its punycode address and accepts an entry keyed by the punycode domain", () => {
    expect(catalogLookupUrl("https://docs.сайт.рф/api?x=1#y")).toBe("https://docs.xn--80aswg.xn--p1ai/api");
    const entry = wbEntry({ domain: "xn--80aswg.xn--p1ai", dsl: { ...wbEntry().dsl, baseOrigins: ["https://api.xn--80aswg.xn--p1ai"] } });

    expect(validateCatalogEntry(entry, "https://docs.сайт.рф/api")?.domain).toBe("xn--80aswg.xn--p1ai");
  });

  it("derives a slug from the name, or from the domain when the name has no Latin letters", () => {
    expect(catalogSlug({ displayName: "Wildberries Statistics", domain: "wildberries.ru" })).toBe("wildberries-statistics");
    expect(catalogSlug({ displayName: "Вайлдберриз", domain: "wildberries.ru" })).toBe("wildberries-ru");
  });
});
