import { describe, expect, it } from "vitest";

import { extractSpecLinks } from "../../src/docs/spec-links.js";

describe("extractSpecLinks", () => {
  it("finds Redoc, Swagger UI, and anchor links to machine-readable specs", () => {
    const html = `
      <redoc spec-url="/api/swagger/yaml/ru/01-general.yaml?region=ru"></redoc>
      <script>SwaggerUIBundle({ url: "https://docs.shop.test/openapi.json", urls: [{ url: "/v2/swagger.yaml", name: "v2" }] })</script>
      <a href="downloads/collection.json#top">Postman</a>
      <a href="/guide.html">Guide</a>
      <a href="http://docs.shop.test/insecure.yaml">Insecure</a>`;
    expect(extractSpecLinks(html, "https://docs.shop.test/docs/api")).toEqual([
      "https://docs.shop.test/api/swagger/yaml/ru/01-general.yaml?region=ru",
      "https://docs.shop.test/openapi.json",
      "https://docs.shop.test/v2/swagger.yaml",
      "https://docs.shop.test/docs/downloads/collection.json",
    ]);
  });

  it("does not take documentation pages under an openapi or swagger path for spec files", () => {
    const html = `
      <a href="/docs/openapi/page-1">Page</a>
      <a href="/docs/openapi/">Index</a>
      <a href="/swagger-ui/index.html">UI</a>
      <script>SwaggerUIBundle({ url: "/docs/openapi/orders" })</script>`;
    expect(extractSpecLinks(html, "https://docs.shop.test/docs/openapi/")).toEqual([]);
  });

  it("finds well-known specification endpoints and keeps an explicit Redoc spec-url", () => {
    const html = `
      <redoc spec-url="/docs/openapi/orders"></redoc>
      <a href="/v3/api-docs">Spring</a>
      <a href="/shop/v2/api-docs">Springfox</a>
      <a href="/swagger/v1/swagger.json">ASP.NET</a>
      <a href="/openapi.json">Spec</a>`;
    expect(extractSpecLinks(html, "https://docs.shop.test/")).toEqual([
      "https://docs.shop.test/docs/openapi/orders",
      "https://docs.shop.test/v3/api-docs",
      "https://docs.shop.test/shop/v2/api-docs",
      "https://docs.shop.test/swagger/v1/swagger.json",
      "https://docs.shop.test/openapi.json",
    ]);
  });

  it("scans about 200 KB of unclosed anchors in well under a second", () => {
    const html = "<a ".repeat(66_667);
    const started = performance.now();
    expect(extractSpecLinks(html, "https://docs.shop.test/")).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stops at the limit", () => {
    const html = Array.from({ length: 50 }, (_, index) => `<a href="/spec-${index}.yaml">s</a>`).join("");
    expect(extractSpecLinks(html, "https://docs.shop.test/", 30)).toHaveLength(30);
  });
});
