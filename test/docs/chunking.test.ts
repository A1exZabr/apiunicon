import { describe, expect, it } from "vitest";

import { chunkSpec, describeOperation } from "../../src/docs/chunking.js";
import { parseMachineDocument, type ParsedSpec, type SpecOperation } from "../../src/docs/spec.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";

describe("chunkSpec", () => {
  it("writes an overview and one self-contained chunk per operation", () => {
    const spec = parseMachineDocument(WB_STYLE_YAML)!;
    const chunks = chunkSpec(spec, "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml");
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.body).toContain("Servers: https://marketplace-api.wildberries.ru");
    expect(chunks[0]?.body).toContain("apiKey header Authorization");
    expect(chunks[1]?.heading).toBe("GET /api/v3/orders/new — Получить список новых сборочных заданий");
    expect(chunks[1]?.body).toContain("- limit (query, required)");
    expect(chunks[1]?.body).toContain("orders");
    expect(new Set(chunks.map(({ contentHash }) => contentHash)).size).toBe(2);
  });

  it("splits a long operation and repeats method and path in every part", () => {
    const spec = parseMachineDocument(WB_STYLE_YAML)!;
    spec.operations[0]!.description = "Подробное описание. ".repeat(80);
    const chunks = chunkSpec(spec, "https://dev.wildberries.ru/spec.yaml", 400).slice(1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.body.length).toBeLessThanOrEqual(400);
      expect(chunk.body.startsWith(`GET /api/v3/orders/new (part ${index + 1}/${chunks.length})`)).toBe(true);
    }
  });

  it("does not repeat the method and path line inside a split part", () => {
    const spec = parseMachineDocument(WB_STYLE_YAML)!;
    spec.operations[0]!.description = "Подробное описание. ".repeat(80);
    const chunks = chunkSpec(spec, "https://dev.wildberries.ru/spec.yaml", 400).slice(1);
    for (const chunk of chunks) {
      expect(chunk.body.split("GET /api/v3/orders/new")).toHaveLength(2);
    }
  });

  describe("with a hostile spec", () => {
    // Paths come from the untrusted document unchanged, so a path can be longer than a whole part.
    const hostileSpec = (path: string, description: string) =>
      parseMachineDocument(JSON.stringify({
        openapi: "3.0.1",
        info: { title: "Hostile" },
        paths: { [path]: { get: { summary: "Long path", description, responses: { 200: { description: "OK" } } } } },
      }))!;

    it.each([
      [7_980, 8_000],
      [8_000, 8_000],
      [12_000, 8_000],
      [8_000, 400],
      [8_000, 200],
    ])("splits a %i-character path at maxChars %i without exceeding it or losing text", (pathLength, maxChars) => {
      const spec = hostileSpec(`/${"a".repeat(pathLength - 1)}`, "word ".repeat(2_000));
      const operation = spec.operations[0]!;
      const chunks = chunkSpec(spec, "https://docs.shop.test/spec.json", maxChars).slice(1);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) expect(chunk.body.length).toBeLessThanOrEqual(maxChars);
      const header = `${operation.method} ${operation.path}`;
      const rest = describeOperation(operation).slice(header.length + 1);
      expect(chunks.map(({ body }) => body.slice(body.indexOf("\n") + 1)).join("")).toBe(rest);
    });

    it("rejects a maxChars too small to hold a part prefix", () => {
      const spec = parseMachineDocument(WB_STYLE_YAML)!;
      expect(() => chunkSpec(spec, "https://dev.wildberries.ru/spec.yaml", 199)).toThrow(RangeError);
      expect(() => chunkSpec(spec, "https://dev.wildberries.ru/spec.yaml", 200)).not.toThrow();
    });

    it("lists inherited root servers once in the overview, not in every operation", () => {
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Fan-out" },
        servers: Array.from({ length: 300 }, (_, index) => ({ url: `https://a${index}.shop.test` })),
        paths: Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [`/a${index}`, { get: {} }])),
      }))!;
      const chunks = chunkSpec(spec, "https://docs.shop.test/spec.json");
      expect(chunks[0]?.body).toContain("Servers: https://a0.shop.test, https://a1.shop.test");
      expect(chunks.slice(1).some(({ body }) => body.includes("Servers:"))).toBe(false);
      expect(chunks.reduce((total, { body }) => total + body.length, 0)).toBeLessThan(200_000);
    });

    it("stops adding operation chunks once the document's text budget is spent", () => {
      const operation = (index: number): SpecOperation => ({
        method: "GET",
        path: `/a${index}`,
        operationId: null,
        summary: null,
        description: "d".repeat(4_000),
        parameters: [],
        requestBody: null,
        responses: {},
        servers: [],
      });
      const spec: ParsedSpec = {
        format: "openapi3",
        title: "Large",
        servers: [],
        securitySchemes: [],
        operations: Array.from({ length: 2_000 }, (_, index) => operation(index)),
        truncated: false,
      };
      const chunks = chunkSpec(spec, "https://docs.shop.test/spec.json");
      expect(chunks.length).toBeLessThan(2_001);
      expect(chunks.reduce((total, { body }) => total + body.length, 0)).toBeLessThanOrEqual(5_000_000);
    });

    it("bounds a document whose parameters all reference one huge string", () => {
      const big = "x".repeat(500_000);
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Hostile" },
        paths: { "/a": { get: { parameters: Array.from({ length: 3_000 }, () => ({ $ref: "#/components/parameters/P" })) } } },
        components: {
          parameters: { P: { name: "p", in: "query", schema: { $ref: "#/components/schemas/Big" } } },
          schemas: { Big: { description: big } },
        },
      }))!;
      const chunks = chunkSpec(spec, "https://docs.shop.test/spec.json");
      expect(chunks.reduce((total, { body }) => total + body.length, 0)).toBeLessThan(500_000);
    });
  });

  describe("describeOperation", () => {
    const base: SpecOperation = {
      method: "POST",
      path: "/orders",
      operationId: null,
      summary: null,
      description: null,
      parameters: [],
      requestBody: null,
      responses: {},
      servers: [],
    };

    it("serializes small schemas exactly like JSON", () => {
      const requestBody = { a: [1, "x\n\"é", null, true, { b: 2.5 }, undefined], c: undefined, d: { e: [] }, f: Number.NaN };
      expect(describeOperation({ ...base, requestBody })).toBe(`POST /orders\nRequest body: ${JSON.stringify(requestBody)}`);
    });

    it("stops serializing a large schema at the section limit instead of reading all of it", () => {
      let reads = 0;
      const schema: Record<string, unknown> = {};
      for (let index = 0; index < 100_000; index += 1) {
        Object.defineProperty(schema, `property${index}`, {
          enumerable: true,
          get: () => {
            reads += 1;
            return { type: "string" };
          },
        });
      }
      const text = describeOperation({ ...base, parameters: [{ name: "q", in: "query", schema }] });
      expect(text).toContain("…[truncated]");
      expect(text.length).toBeLessThan(3_200);
      expect(reads).toBeLessThan(1_000);
    });
  });
});
