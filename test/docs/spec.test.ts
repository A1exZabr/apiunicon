import { describe, expect, it, vi } from "vitest";

import { parseMachineDocument } from "../../src/docs/spec.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";

describe("parseMachineDocument", () => {
  it("reads OpenAPI 3 YAML with path-level servers and resolves internal references", () => {
    const spec = parseMachineDocument(WB_STYLE_YAML);
    expect(spec).toMatchObject({ format: "openapi3", title: "Заказы FBS" });
    expect(spec?.servers.map(({ url }) => url)).toEqual([
      "https://marketplace-api.wildberries.ru",
      "https://marketplace-api-sandbox.wildberries.ru",
    ]);
    expect(spec?.servers[0]?.pointer).toBe("/paths/~1api~1v3~1orders~1new/servers/0");
    expect(spec?.securitySchemes).toEqual([{
      pointer: "/components/securitySchemes/HeaderApiKey",
      type: "apiKey",
      in: "header",
      name: "Authorization",
      scheme: null,
    }]);
    const operation = spec?.operations[0];
    expect(operation).toMatchObject({ method: "GET", path: "/api/v3/orders/new", operationId: "getOrdersNew" });
    expect(operation?.parameters[0]).toMatchObject({ name: "limit", in: "query", required: true });
    expect(JSON.stringify(operation?.responses["200"])).toContain("orders");
    expect(operation?.responses["401"]).toMatchObject({ description: "Пользователь не авторизован" });
  });

  it("reads Swagger 2 host, base path, body parameters, and security definitions", () => {
    const spec = parseMachineDocument(JSON.stringify({
      swagger: "2.0",
      info: { title: "Legacy API" },
      host: "api.legacy.test",
      basePath: "/v2",
      schemes: ["https"],
      securityDefinitions: {
        key: { type: "apiKey", in: "header", name: "X-Api-Key" },
        oauth: { type: "oauth2", flow: "implicit", authorizationUrl: "https://auth.legacy.test/" },
      },
      paths: {
        "/items": {
          post: {
            summary: "Search items",
            parameters: [
              { name: "body", in: "body", schema: { type: "object" } },
              { name: "page", in: "query", type: "integer" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }));
    expect(spec?.format).toBe("swagger2");
    expect(spec?.servers).toEqual([{ url: "https://api.legacy.test/v2", description: null, pointer: "/host" }]);
    expect(spec?.securitySchemes.map(({ type }) => type)).toEqual(["apiKey", "oauth2"]);
    expect(spec?.operations[0]?.requestBody).toMatchObject({ in: "body" });
    expect(spec?.operations[0]?.parameters).toEqual([{ name: "page", in: "query", type: "integer" }]);
  });

  it("reads a Postman collection with variables and API key auth", () => {
    const spec = parseMachineDocument(JSON.stringify({
      info: { name: "Shop", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      variable: [{ key: "baseUrl", value: "https://api.shop.test" }],
      auth: { type: "apikey", apikey: [{ key: "key", value: "X-Shop-Key" }, { key: "in", value: "header" }] },
      item: [{ name: "Orders", item: [{ name: "List orders", request: { method: "GET", url: { raw: "{{baseUrl}}/orders?limit=10" } } }] }],
    }));
    expect(spec).toMatchObject({ format: "postman", title: "Shop" });
    expect(spec?.servers.map(({ url }) => url)).toEqual(["https://api.shop.test"]);
    expect(spec?.securitySchemes).toEqual([{ pointer: "/auth", type: "apiKey", in: "header", name: "X-Shop-Key", scheme: null }]);
    expect(spec?.operations[0]).toMatchObject({ method: "GET", path: "/orders", summary: "List orders" });
  });

  it.each([
    "plain text about an API",
    "<html><body>docs</body></html>",
    JSON.stringify({ hello: "world" }),
    "title: not a spec\nopenapi_like: false\n",
    "{ not json",
  ])("returns null for content that is not a machine-readable spec: %s", (input) => {
    expect(parseMachineDocument(input)).toBeNull();
  });

  it("reads unquoted YAML versions, which parse as numbers", () => {
    expect(parseMachineDocument("swagger: 2.0\ninfo: { title: Legacy }\nhost: api.legacy.test\npaths: {}\n"))
      .toMatchObject({ format: "swagger2", servers: [{ url: "https://api.legacy.test" }] });
    expect(parseMachineDocument("openapi: 3.0\ninfo: { title: Short }\npaths: {}\n")).toMatchObject({ format: "openapi3", title: "Short" });
    expect(parseMachineDocument("openapi: 3.1\ninfo: { title: Newer }\npaths: {}\n")).toMatchObject({ format: "openapi3" });
    expect(parseMachineDocument("openapi: 2.0\ninfo: { title: Wrong }\npaths: {}\n")).toBeNull();
  });

  it("does not emit process warnings for tags in untrusted YAML", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      expect(parseMachineDocument("openapi: 3.0.0\ninfo: { title: !custom Tagged }\npaths: {}\n")).toMatchObject({ format: "openapi3" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects YAML alias expansion attacks instead of expanding them", () => {
    const aliases = Array.from({ length: 200 }, () => "*base").join(", ");
    expect(parseMachineDocument(`openapi: 3.0.0\nbase: &base x\nitems: [${aliases}]\n`)).toBeNull();
  });

  it("accepts a YAML anchor reused by sibling operations", () => {
    const spec = parseMachineDocument([
      "openapi: 3.0.0",
      "info:",
      "  title: Shared",
      "paths:",
      "  /a:",
      "    get:",
      "      parameters: &limit",
      "        - name: limit",
      "          in: query",
      "      responses:",
      "        '200':",
      "          description: ok",
      "  /b:",
      "    get:",
      "      parameters: *limit",
      "      responses:",
      "        '200':",
      "          description: ok",
      "",
    ].join("\n"));
    expect(spec?.operations.map(({ path, parameters }) => [path, parameters])).toEqual([
      ["/a", [{ name: "limit", in: "query" }]],
      ["/b", [{ name: "limit", in: "query" }]],
    ]);
  });

  it("returns null for recursive YAML aliases instead of overflowing the stack", () => {
    expect(parseMachineDocument("openapi: 3.0.0\npaths:\n  /x:\n    get:\n      responses: &r\n        '200': *r\n")).toBeNull();
  });

  it("returns null for documents nested too deeply for the resolver", () => {
    const nested = "[".repeat(1_000) + "]".repeat(1_000);
    expect(parseMachineDocument(
      `{"openapi":"3.0.0","info":{"title":"x"},"paths":{"/a":{"get":{"responses":{"200":{"description":"d","content":{"x":{"schema":${nested}}}}}}}}}`,
    )).toBeNull();
  });

  it("checks a YAML anchor again where it is reused deeper than before", () => {
    const anchored = `x-a: &deep ${"[".repeat(200)}${"]".repeat(200)}`;
    const reuse = (levels: number) => `x-b: ${"[".repeat(levels)}*deep${"]".repeat(levels)}`;
    const document = (levels: number) => `openapi: 3.0.0\ninfo: {title: Deep}\npaths: {}\n${anchored}\n${reuse(levels)}\n`;
    expect(parseMachineDocument(document(20))).toMatchObject({ title: "Deep" });
    expect(parseMachineDocument(document(100))).toBeNull();
  });

  it("maps scheme types named after Object.prototype members to other", () => {
    const spec = parseMachineDocument(JSON.stringify({
      swagger: "2.0",
      info: { title: "Proto" },
      securityDefinitions: { odd: { type: "constructor" } },
      paths: {},
    }));
    expect(spec?.securitySchemes.map(({ type }) => type)).toEqual(["other"]);
  });

  it("bounds reference expansion for fan-out schemas and leaves refs in place past the budget", () => {
    const schemas: Record<string, unknown> = {};
    for (let level = 0; level < 6; level += 1) {
      const properties: Record<string, unknown> = {};
      for (let index = 0; index < 20; index += 1) {
        properties[`p${index}`] = level < 5 ? { $ref: `#/components/schemas/S${level + 1}` } : { type: "string" };
      }
      schemas[`S${level}`] = { type: "object", properties };
    }
    const response = { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } };
    const spec = parseMachineDocument(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Fan-out" },
      paths: {
        "/a": { get: { responses: { "200": response } } },
        "/b": { get: { responses: { "200": response } } },
      },
      components: { schemas },
    }));
    const serialized = JSON.stringify(spec?.operations);
    expect(spec?.operations).toHaveLength(2);
    expect(serialized.length).toBeLessThan(5_000_000);
    expect(serialized).toContain('"$ref"');
  });

  describe("with a hostile fan-out document", () => {
    // Scaled down from a 930 KB document (3,000 root servers x 40,000 operations) that exhausted the heap.
    const fanOut = (serverCount: number, operationCount: number) => JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Fan-out" },
      servers: Array.from({ length: serverCount }, (_, index) => ({ url: `https://a${index}.shop.test` })),
      paths: Object.fromEntries(Array.from({ length: operationCount }, (_, index) => [`/a${index}`, { get: {} }])),
    });

    it("stores root servers once instead of copying them into every operation", () => {
      const spec = parseMachineDocument(fanOut(300, 1_000))!;
      expect(spec.operations).toHaveLength(1_000);
      expect(spec.operations.every(({ servers }) => servers.length === 0)).toBe(true);
      expect(spec.servers.length).toBeLessThanOrEqual(100);
      expect(spec.servers[0]).toEqual({ url: "https://a0.shop.test", description: null, pointer: "/servers/0" });
    });

    it("caps the operations it reads and says so", () => {
      const spec = parseMachineDocument(fanOut(1, 3_000))!;
      expect(spec.operations).toHaveLength(2_000);
      expect(spec.truncated).toBe(true);
      expect(parseMachineDocument(fanOut(1, 10))!.truncated).toBe(false);
    });

    it("keeps path and operation servers, each listed once for the document", () => {
      const server = (url: string) => ({ url });
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Levels" },
        servers: [server("https://root.shop.test")],
        paths: Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`/p${index}`, {
          servers: [server("https://path.shop.test")],
          get: { servers: [server("https://op.shop.test"), server("https://root.shop.test")] },
          post: {},
        }])),
      }))!;
      expect(spec.servers.map(({ url }) => url)).toEqual(["https://root.shop.test", "https://path.shop.test", "https://op.shop.test"]);
      expect(spec.operations[0]?.servers.map(({ url }) => url)).toEqual(["https://op.shop.test", "https://root.shop.test"]);
      expect(spec.operations[1]?.servers.map(({ url }) => url)).toEqual(["https://path.shop.test"]);
    });

    it("charges the length of an inlined string, so a huge string is inlined only a few times", () => {
      const big = "x".repeat(200_000);
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Hostile" },
        paths: { "/a": { get: { parameters: Array.from({ length: 2_000 }, () => ({ $ref: "#/components/parameters/P" })) } } },
        components: {
          parameters: { P: { name: "p", in: "query", schema: { $ref: "#/components/schemas/Big" } } },
          schemas: { Big: { description: big } },
        },
      }))!;
      const inlined = spec.operations[0]!.parameters
        .filter((parameter) => (parameter as { schema?: { description?: string } }).schema?.description === big);
      expect(inlined.length).toBeGreaterThan(0);
      expect(inlined.length).toBeLessThanOrEqual(50);
    });

    it("charges every inlined value, so a large array of numbers is inlined only a few times", () => {
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Hostile" },
        paths: { "/a": { get: { parameters: Array.from({ length: 1_000 }, () => ({ $ref: "#/components/parameters/P" })) } } },
        components: { parameters: { P: { name: "p", in: "query", schema: { enum: Array.from({ length: 5_000 }, (_, index) => index) } } } },
      }))!;
      const inlined = spec.operations[0]!.parameters.filter((parameter) => "schema" in (parameter as object));
      expect(inlined.length).toBeGreaterThan(0);
      expect(inlined.length).toBeLessThanOrEqual(50);
    });

    it("keeps the first 200 parameters and the first 50 responses of an operation", () => {
      const spec = parseMachineDocument(JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Wide" },
        paths: {
          "/a": {
            parameters: Array.from({ length: 100 }, (_, index) => ({ name: `shared${index}`, in: "query" })),
            get: {
              parameters: Array.from({ length: 200 }, (_, index) => ({ name: `own${index}`, in: "query" })),
              responses: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [String(200 + index), { description: "ok" }])),
            },
          },
        },
      }))!;
      const operation = spec.operations[0]!;
      expect(operation.parameters).toHaveLength(200);
      expect(operation.parameters.at(-1)).toEqual({ name: "own99", in: "query" });
      expect(Object.keys(operation.responses)).toEqual(Array.from({ length: 50 }, (_, index) => String(200 + index)));
    });
  });

  describe("with a YAML anchor reused across operations", () => {
    const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
    const numbers = (count: number) => `[${"1,".repeat(count - 1)}1]`;
    const maps = (count: number) => `[${"{a: 1}, ".repeat(count - 1)}{a: 1}]`;

    // Scaled down from a 900 KB document that exhausts the heap when copied naively: one anchor used as the shared
    // parameters of 99 paths, copied for each of their 8 methods, costs seconds and hundreds of MB.
    it("resolves shared path parameters once and does not copy them for each method", () => {
      const input = [
        "openapi: 3.0.0",
        "info: {title: Anchored}",
        `x-shared: &shared ${maps(7_000)}`,
        "paths:",
        ...Array.from({ length: 99 }, (_, index) =>
          `  /a${index}: {parameters: *shared, ${methods.map((method) => `${method}: {}`).join(", ")}}`),
        "",
      ].join("\n");
      const started = performance.now();
      const spec = parseMachineDocument(input)!;
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(spec.operations).toHaveLength(99 * 8);
      expect(new Set(spec.operations.map(({ path }) => path)).size).toBe(99);
      expect(spec.operations[1]!.parameters).toBe(spec.operations[0]!.parameters);
    });

    it("charges the document's own values to the inlining budget, so a reused anchor stops being copied", () => {
      const spec = parseMachineDocument([
        "openapi: 3.0.0",
        "info: {title: Anchored}",
        `x-body: &body {content: {application/json: {example: ${numbers(20_000)}}}}`,
        "paths:",
        ...Array.from({ length: 99 }, (_, index) => `  /a${index}: {post: {requestBody: *body}}`),
        "",
      ].join("\n"))!;
      expect(spec.operations).toHaveLength(99);
      expect(new Set(spec.operations.map(({ requestBody }) => requestBody)).size).toBeLessThan(10);
    });
  });

  it("does not resolve a $ref to an inherited Object.prototype member", () => {
    const spec = parseMachineDocument(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Proto ref" },
      components: {},
      paths: { "/x": { get: { responses: { "200": { $ref: "#/components/constructor" } } } } },
    }));
    expect(spec?.operations[0]?.responses).toEqual({ "200": { $ref: "#/components/constructor" } });
  });

  it("keeps Postman requests whose placeholders are only in the path or query", () => {
    const spec = parseMachineDocument(JSON.stringify({
      info: { name: "Placeholders", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [
        { name: "By id", request: { method: "GET", url: { raw: "https://api.x.test/orders/{{id}}" } } },
        { name: "Token query", request: { method: "GET", url: { raw: "https://api.x.test/orders?token={{t}}" } } },
        { name: "Host unresolved", request: { method: "GET", url: { raw: "{{baseUrl}}/orders" } } },
      ],
    }));
    expect(spec?.operations.map(({ path, summary }) => [path, summary])).toEqual([
      ["/orders/{{id}}", "By id"],
      ["/orders", "Token query"],
    ]);
  });

  it("returns null for a Postman collection that yields no operations", () => {
    expect(parseMachineDocument(JSON.stringify({
      info: { name: "Unresolved", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ name: "Orders", request: { method: "GET", url: { raw: "{{baseUrl}}/orders" } } }],
    }))).toBeNull();
  });
});
