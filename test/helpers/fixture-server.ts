import type { FetchImplementation } from "../../src/security/network-policy.js";

export type FixtureApi = {
  fetchImpl: FetchImplementation;
  apiCalls: Array<{ url: string; apiKey: string | null }>;
};

export function createFixtureApi(): FixtureApi {
  const apiCalls: Array<{ url: string; apiKey: string | null }> = [];
  const fetchImpl: FetchImplementation = async (input, init = {}) => {
    const url = new URL(input.toString());
    if (url.origin === "https://docs.example.test") {
      if (url.pathname === "/openapi.json") {
        return new Response(JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Fixture Orders API" },
          servers: [{ url: "https://api.example.test" }],
          components: {
            securitySchemes: {
              apiKey: { type: "apiKey", in: "header", name: "Api-Key" },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        `<html><body><h1>Orders API</h1><p>GET /orders lists recent orders.</p><a href="/openapi.json">OpenAPI</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    if (url.origin === "https://api.example.test") {
      const headers = new Headers(init.headers);
      apiCalls.push({ url: url.toString(), apiKey: headers.get("Api-Key") });
      if (url.pathname === "/orders-stale") {
        return new Response(JSON.stringify({ error: "unknown route" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/orders") {
        return new Response(JSON.stringify({ orders: [{ id: "order-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ error: "unexpected fixture URL" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, apiCalls };
}
