import { describe, expect, it } from "vitest";

import { AdapterDslSchema, hasDotSegment, HttpsOriginSchema, type AdapterDsl } from "../../src/adapters/schema.js";

export const validAdapterDsl: AdapterDsl = {
  schemaVersion: 1,
  baseOrigins: ["https://api-seller.ozon.ru"],
  credentialBindings: [
    { fieldName: "Client-Id", target: "header", headerName: "Client-Id" },
    { fieldName: "Api-Key", target: "header", headerName: "Api-Key" },
  ],
  operations: [
    {
      id: "list_postings",
      description: "List FBS postings without modifying seller data",
      risk: "read",
      method: "POST",
      path: "/v4/posting/fbs/list",
      input: {
        filter: { type: "object", location: "body", required: true },
        limit: { type: "integer", location: "body", required: false },
      },
      response: { select: ["postings"] },
      documentationRefs: ["doc-chunk-postings"],
    },
  ],
};

describe("AdapterDslSchema", () => {
  it("accepts a POST operation explicitly classified as read-only", () => {
    expect(AdapterDslSchema.parse(validAdapterDsl)).toEqual(validAdapterDsl);
  });

  it.each([
    ["absolute operation URL", { ...validAdapterDsl.operations[0], path: "https://evil.test/x" }],
    ["parent path traversal", { ...validAdapterDsl.operations[0], path: "/v3/../secret" }],
    ["backslash path", { ...validAdapterDsl.operations[0], path: "/v3\\secret" }],
  ])("rejects %s", (_label, operation) => {
    expect(() =>
      AdapterDslSchema.parse({ ...validAdapterDsl, operations: [operation] }),
    ).toThrow();
  });

  // The URL parser resolves a dot segment before it looks at the query or the fragment, and decodes %2e as a dot, so
  // each of these would move the request out of the operation's path.
  it.each([
    "/v3/posting/..?x={id}",
    "/v3/posting/..#x",
    "/v3/posting/..?",
    "/v3/posting/.?x=1",
    "/v3/posting/.#x",
    "/v3/%2e%2e/secret",
    "/v3/%2E%2E/secret",
    "/v3/%2e%2E/secret",
    "/v3/.%2e/secret",
    "/v3/%2E./secret",
    "/v3/posting/%2e%2e?x={id}",
    "/v3/posting/%2E%2E#x",
    "/v3/%2e/secret",
    "/v3/posting/%2e",
    "/v3/./secret",
    // The URL parser strips a trailing space, so these are dot segments to it.
    "/v3/posting/.. ",
    "/v3/posting/. ",
    "/v3/posting/%2e%2e ",
  ])("rejects the dot segment in operation path %s", (path) => {
    expect(() =>
      AdapterDslSchema.parse({ ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0], path }] }),
    ).toThrow(/safe relative path/u);
  });

  // Stored adapters have spaces in their templates, and the repository parses every stored adapter on each read. A dot
  // segment followed by a space is still refused above: hasDotSegment leaves the spaces out before it checks.
  it.each([
    "/odata/Catalog_Items?$filter=Posted eq true",
    "/v3/posting/a b",
    "/v3/posting/ ",
    "/v3/ posting/list",
    "/v3/posting/list ",
  ])("accepts a raw space in operation path %j", (path) => {
    expect(
      AdapterDslSchema.parse({ ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0], path }] }).operations[0]?.path,
    ).toBe(path);
  });

  it.each(["/v3/posting/\u0000x", "/v3/posting/\tx", "/v3/posting/x\n", "/v3/posting/\u001fx", "/v3/posting/\u007fx"])(
    "still rejects a control character in operation path %j",
    (path) => {
      expect(() =>
        AdapterDslSchema.parse({ ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0], path }] }),
      ).toThrow(/safe relative path/u);
    },
  );

  it("finds a dot segment the way the URL parser does, whatever the spelling", () => {
    for (const path of [
      "/v3/..", "/v3/posting/.", "/v3/%2E%2e/x", "/v3/.%2E/x", "/v3/..?x=1", "/v3/.#x", "/v3/%2e%2e?x={id}",
      // The parser strips a space at the end and removes tabs and line breaks anywhere.
      "/v3/posting/.. ", "/v3/posting/. ", "/v3/posting/%2e%2e ", "/v3/.\t./x", "/v3/%2e\n%2e/x", "/v3/..\t?x=1", "/v3/%\t2e%2e/x",
    ]) {
      expect(hasDotSegment(path), path).toBe(true);
    }
    for (const path of [
      "/v3/posting/file.json", "/v3/...", "/v3/a..b/c", "/v3/.well-known/x", "/v3/..x/y", "/v3/%2e%2ex",
      "/v3/%252e%252e/x", "/v3/posting/get?kind=all", "/v3/posting?x=1&y=/", "/", "",
    ]) {
      expect(hasDotSegment(path), path).toBe(false);
    }
  });

  it.each([
    "/v3/posting/file.json",
    "/v3/posting/...",
    "/v3/a..b/c",
    "/v3/.well-known/x",
    "/v3/..x/y",
    "/v3/posting/%2e%2ex",
    "/v3/posting/%2e%2e%2e",
    "/v3/posting/get?kind=all&x={id}",
    "/v3/posting?x=1",
    "/v3/%252e%252e/x",
  ])("keeps accepting operation path %s", (path) => {
    expect(
      AdapterDslSchema.parse({ ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0], path }] }).operations[0]?.path,
    ).toBe(path);
  });

  it.each([
    "http://api.example.com",
    "https://user:password@api.example.com",
    "https://api.example.com/path",
    "https://api.example.com?mode=test",
  ])("rejects unsafe or non-origin base URL %s", (baseOrigin) => {
    expect(() =>
      AdapterDslSchema.parse({ ...validAdapterDsl, baseOrigins: [baseOrigin] }),
    ).toThrow();
  });

  it("rejects arbitrary extension code and unknown fields", () => {
    expect(() =>
      AdapterDslSchema.parse({
        ...validAdapterDsl,
        extensions: [{ code: "process.exit()" }],
      }),
    ).toThrow();
  });

  it("allows structured JSON objects only in request bodies", () => {
    const operation = validAdapterDsl.operations[0]!;
    expect(() => AdapterDslSchema.parse({
      ...validAdapterDsl,
      operations: [{
        ...operation,
        input: { filter: { type: "object", location: "body", required: true } },
      }],
    })).not.toThrow();
    expect(() => AdapterDslSchema.parse({
      ...validAdapterDsl,
      operations: [{
        ...operation,
        input: { filter: { type: "object", location: "query", required: true } },
      }],
    })).toThrow(/object.*body/iu);
  });

  it("allows lists of plain values only in request bodies", () => {
    const operation = validAdapterDsl.operations[0]!;
    const withList = (location: "body" | "query" | "path") => AdapterDslSchema.parse({
      ...validAdapterDsl,
      operations: [{ ...operation, input: { nms: { type: "array", location, required: true } } }],
    });
    expect(() => withList("body")).not.toThrow();
    expect(() => withList("query")).toThrow(/array.*body/iu);
  });

  it("lets an operation target one of the adapter's base origins", () => {
    const operation = validAdapterDsl.operations[0]!;
    const parsed = AdapterDslSchema.parse({
      ...validAdapterDsl,
      baseOrigins: ["https://content-api.example.test", "https://statistics-api.example.test"],
      operations: [{ ...operation, origin: "https://statistics-api.example.test/" }],
    });
    expect(parsed.operations[0]?.origin).toBe("https://statistics-api.example.test");
  });

  it("rejects an operation origin missing from the base origins", () => {
    const operation = validAdapterDsl.operations[0]!;
    expect(() => AdapterDslSchema.parse({
      ...validAdapterDsl,
      operations: [{ ...operation, origin: "https://other-api.example.test" }],
    })).toThrow(/baseOrigins/u);
  });

  it("reports a value that is not a URL as an invalid origin instead of throwing", () => {
    for (const value of ["not a url", "apiunicon.online", "https://"]) {
      expect(() => HttpsOriginSchema.safeParse(value)).not.toThrow();
      expect(HttpsOriginSchema.safeParse(value).success).toBe(false);
    }
    expect(AdapterDslSchema.safeParse({ ...validAdapterDsl, baseOrigins: ["not a url"] }).success).toBe(false);
  });

  it("accepts up to 40 base origins", () => {
    const origins = Array.from({ length: 41 }, (_, index) => `https://api-${index}.example.test`);
    expect(AdapterDslSchema.parse({ ...validAdapterDsl, baseOrigins: origins.slice(0, 40) }).baseOrigins).toHaveLength(40);
    expect(() => AdapterDslSchema.parse({ ...validAdapterDsl, baseOrigins: origins })).toThrow();
  });
});
