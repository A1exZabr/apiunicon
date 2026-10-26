import { describe, expect, it } from "vitest";

import { DiscoveryCollector } from "../../src/discovery/collector.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";

describe("DiscoveryCollector", () => {
  it("discovers an API origin and header credentials from OpenAPI without retaining examples", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.ozon.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({
        openapi: "3.0.3",
        info: { title: "Ozon Seller API" },
        servers: [{ url: "https://api-seller.ozon.test/v3" }],
        components: {
          securitySchemes: {
            clientId: { type: "apiKey", in: "header", name: "Client-Id", example: "discard-client" },
            apiKey: { type: "apiKey", in: "header", name: "Api-Key", example: "discard-key" },
          },
        },
      }),
    });

    const result = collector.result();
    expect(result.serviceName).toBe("Ozon Seller API");
    expect(result.suggestedLabel).toBe("Ozon Seller");
    expect(result.origins).toEqual([
      expect.objectContaining({ origin: "https://api-seller.ozon.test", confidence: "high" }),
    ]);
    expect(result.credentials.map(({ fieldName }) => fieldName).sort()).toEqual(["Api-Key", "Client-Id"]);
    expect(JSON.stringify(result)).not.toContain("discard-client");
    expect(JSON.stringify(result)).not.toContain("discard-key");
  });

  it("promotes a repeated curl API origin and header to high confidence", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/quickstart",
      contentType: "text/plain",
      body: "curl https://api.example.test/v1/items -H 'Api-Key: secret-one'",
    });
    collector.observe({
      url: "https://docs.example.test/items",
      contentType: "text/html",
      body: "<pre>curl -X GET https://api.example.test/v1/items -H \"Api-Key: secret-two\"</pre>",
    });

    const result = collector.result();
    expect(result.origins).toEqual([
      expect.objectContaining({
        origin: "https://api.example.test",
        confidence: "high",
        observationCount: 2,
      }),
    ]);
    expect(result.credentials).toEqual([
      expect.objectContaining({ fieldName: "Api-Key", kind: "api_key", confidence: "high" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-one");
    expect(JSON.stringify(result)).not.toContain("secret-two");
  });

  it("does not infer an API from a single bare documentation link", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/",
      contentType: "text/html",
      body: '<a href="https://docs.example.test/reference">Reference</a>',
    });

    expect(collector.result().origins).toEqual([]);
  });

  it("recognizes bearer authorization without retaining the token", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/auth",
      contentType: "text/plain",
      body: "curl https://api.example.test/me -H 'Authorization: Bearer example-token'",
    });

    const result = collector.result();
    expect(result.credentials).toEqual([
      expect.objectContaining({ fieldName: "Authorization", kind: "bearer_token" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("example-token");
  });

  it("reports OAuth and OpenID Connect instead of treating them as static credentials", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({
        openapi: "3.1.0",
        components: {
          securitySchemes: {
            oauth: { type: "oauth2", flows: {} },
            oidc: { type: "openIdConnect", openIdConnectUrl: "https://id.example.test/config" },
          },
        },
      }),
    });

    expect(collector.result()).toEqual(expect.objectContaining({
      credentials: [],
      unsupportedAuthMethods: ["OAuth 2.0", "OpenID Connect"],
    }));
  });

  it("discards non-HTTPS, credential-bearing, localhost, and private literal API URLs", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/unsafe",
      contentType: "text/plain",
      body: [
        "curl http://api.example.test/items",
        "curl https://user:password@api.example.test/items",
        "curl https://localhost/items",
        "curl https://127.0.0.1/items",
        "curl https://10.1.2.3/items",
        "curl https://[::1]/items",
        "curl https://[fd00::1]/items",
      ].join("\n"),
    });

    expect(collector.result().origins).toEqual([]);
  });

  // The same check as an approved origin's (network-policy.ts). A URL writes [::ffff:127.0.0.1] as [::ffff:7f00:1], and
  // it refuses an IPv6 zone outright.
  const REFUSED_LITERALS = [
    "https://[::ffff:127.0.0.1]/items",
    "https://[::ffff:10.1.2.3]/items",
    "https://[::ffff:7f00:1]/items",
    "https://192.0.2.10/items",
    "https://198.51.100.7/items",
    "https://203.0.113.5/items",
    "https://[2001:db8::1]/items",
    "https://[fe80::1%25en0]/items",
    "https://[2001:4860:4860::8888%25eth0]/items",
  ];

  it("never offers an IPv4-mapped, documentation-range or zoned address from an example", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/unsafe",
      contentType: "text/plain",
      body: REFUSED_LITERALS.map((url) => `curl ${url}`).join("\n"),
    });

    expect(collector.result().origins).toEqual([]);
  });

  it("never offers an IPv4-mapped, documentation-range or zoned address from a spec's servers", () => {
    for (const url of REFUSED_LITERALS) {
      const collector = new DiscoveryCollector();
      collector.observe({
        url: "https://docs.example.test/openapi.json",
        contentType: "application/json",
        body: JSON.stringify({ openapi: "3.0.3", info: { title: "Shop API" }, servers: [{ url }], paths: {} }),
      });

      expect(collector.result().origins, url).toEqual([]);
    }
  });

  it("offers a public address literal, also one in 198.51.x.x outside the documentation range", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.example.test/quickstart",
      contentType: "text/plain",
      body: ["curl https://198.51.7.7/items", "curl https://[2001:4860:4860::8888]/items"].join("\n"),
    });

    expect(collector.result().origins.map(({ origin }) => origin)).toEqual([
      "https://198.51.7.7",
      "https://[2001:4860:4860::8888]",
    ]);
  });
});

describe("DiscoveryCollector with parsed specs", () => {
  it("reads YAML specs with path-level production and sandbox servers", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://dev.wildberries.ru/api/swagger/yaml/ru/03-orders-fbs.yaml",
      contentType: "text/yaml; charset=utf-8",
      body: WB_STYLE_YAML,
    });
    const result = collector.result();
    expect(result.serviceName).toBe("Заказы FBS");
    expect(result.origins).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "https://marketplace-api.wildberries.ru", confidence: "high" }),
      expect.objectContaining({ origin: "https://marketplace-api-sandbox.wildberries.ru", confidence: "low", serviceLabel: "Sandbox" }),
    ]));
    expect(result.credentials).toEqual([
      expect.objectContaining({ fieldName: "Authorization", kind: "api_key", humanLabel: "API key", confidence: "high" }),
    ]);
  });

  it("reads security schemes placed after the first 16 000 characters", () => {
    const padding = "x".repeat(20_000);
    const body = WB_STYLE_YAML.replace("  version: orders-fbs\n", `  version: orders-fbs\n  description: ${padding}\n`);
    const collector = new DiscoveryCollector();
    collector.observe({ url: "https://dev.wildberries.ru/spec.yaml", contentType: "text/yaml", body });
    expect(collector.result().credentials.map(({ fieldName }) => fieldName)).toEqual(["Authorization"]);
  });

  it("keeps up to 40 production destinations", () => {
    const paths = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
      `/v1/r${index}`,
      { servers: [{ url: `https://api${index}.shop.test` }], get: { responses: { "200": { description: "ok" } } } },
    ]));
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.shop.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({ openapi: "3.0.0", info: { title: "Shop" }, paths }),
    });
    expect(collector.result().origins).toHaveLength(25);
  });

  it("caps destinations at exactly 40", () => {
    const paths = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [
      `/v1/r${index}`,
      { servers: [{ url: `https://api${index}.shop.test` }], get: { responses: { "200": { description: "ok" } } } },
    ]));
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.shop.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({ openapi: "3.0.0", info: { title: "Shop" }, paths }),
    });
    expect(collector.result().origins).toHaveLength(40);
  });

  it("keeps a spec sandbox as sandbox when a later page shows it in a curl example", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.shop.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Shop" },
        servers: [{ url: "https://x-sandbox.shop.test", description: "Sandbox environment" }],
      }),
    });
    collector.observe({
      url: "https://docs.shop.test/quickstart",
      contentType: "text/html",
      body: "<pre>curl https://x-sandbox.shop.test/v1/items -H 'Api-Key: secret'</pre>",
    });
    expect(collector.result().origins).toEqual([
      expect.objectContaining({
        origin: "https://x-sandbox.shop.test",
        confidence: "low",
        serviceLabel: "Sandbox",
        observationCount: 2,
      }),
    ]);
  });

  it("marks a sandbox host seen only in curl examples on several pages as sandbox", () => {
    const collector = new DiscoveryCollector();
    for (const page of ["one", "two"]) {
      collector.observe({
        url: `https://docs.shop.test/${page}`,
        contentType: "text/plain",
        body: "curl https://api-sandbox.shop.test/v1/items -H 'Api-Key: secret'",
      });
    }
    expect(collector.result().origins).toEqual([
      expect.objectContaining({
        origin: "https://api-sandbox.shop.test",
        confidence: "low",
        serviceLabel: "Sandbox",
        observationCount: 2,
      }),
    ]);
  });

  it("marks a server as sandbox when only its description says so", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.shop.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Shop" },
        servers: [
          { url: "https://api.shop.test", description: "Production" },
          { url: "https://test-api.shop.test", description: "Sandbox environment" },
        ],
      }),
    });
    expect(collector.result().origins).toEqual([
      expect.objectContaining({ origin: "https://api.shop.test", confidence: "high", serviceLabel: "Shop" }),
      expect.objectContaining({ origin: "https://test-api.shop.test", confidence: "low", serviceLabel: "Sandbox" }),
    ]);
  });
});

describe("DiscoveryCollector keeps every stored value within the discovery schema", () => {
  it("shortens a long spec title for the destination label", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: "https://docs.shop.test/openapi.json",
      contentType: "application/json",
      body: JSON.stringify({ openapi: "3.0.0", info: { title: "A".repeat(150) }, servers: [{ url: "https://api.shop.test" }], paths: {} }),
    });
    const result = collector.result();
    expect(result.serviceName).toBe("A".repeat(150));
    expect(result.origins[0]?.serviceLabel).toBe("A".repeat(120));
  });

  it("shortens the excerpt of an example on a very long host", () => {
    const host = ["a", "b", "c", "d"].map((letter) => letter.repeat(60)).join(".") + ".shop.test";
    const collector = new DiscoveryCollector();
    collector.observe({ url: "https://docs.shop.test/guide", contentType: "text/plain", body: `curl https://${host}/v1/items -H 'X-Api-Key: v'` });
    const [origin] = collector.result().origins;
    expect(origin?.origin).toBe(`https://${host}`);
    expect(origin?.evidence[0]?.excerpt?.length).toBe(240);
  });

  it("ignores a page whose URL is too long to cite as evidence", () => {
    const collector = new DiscoveryCollector();
    collector.observe({
      url: `https://docs.shop.test/guide?${"q".repeat(2_100)}`,
      contentType: "text/plain",
      body: "curl https://api.shop.test/v1/items -H 'X-Api-Key: v'",
    });
    expect(collector.result()).toMatchObject({ origins: [], credentials: [] });
  });

  it("caps how many pages an origin is counted on", () => {
    const collector = new DiscoveryCollector();
    for (let page = 0; page < 1_001; page += 1) {
      collector.observe({ url: `https://docs.shop.test/p${page}`, contentType: "text/plain", body: "curl https://api.shop.test/v1/items" });
    }
    expect(collector.result().origins[0]?.observationCount).toBe(1_000);
  });

  it("trims trailing punctuation from a URL in linear time", () => {
    const collector = new DiscoveryCollector();
    const started = performance.now();
    collector.observe({ url: "https://docs.shop.test/p", contentType: "text/plain", body: `curl https://api.shop.test/${")".repeat(15_900)}x` });
    expect(performance.now() - started).toBeLessThan(100);
    expect(collector.result().origins.map(({ origin }) => origin)).toEqual(["https://api.shop.test"]);
  });
});
