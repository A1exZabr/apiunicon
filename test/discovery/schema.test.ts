import { describe, expect, it } from "vitest";

import { DiscoveryResultSchema, emptyDiscoveryResult } from "../../src/discovery/schema.js";

const evidence = {
  pageUrl: "https://docs.ozon.test/openapi.json",
  kind: "openapi_server" as const,
  pointer: "/servers/0",
};

describe("DiscoveryResultSchema", () => {
  it("accepts normalized non-secret origin and credential evidence", () => {
    const parsed = DiscoveryResultSchema.parse({
      ...emptyDiscoveryResult(),
      serviceName: "Ozon Seller API",
      suggestedLabel: "Ozon Seller",
      origins: [{
        id: "origin-api-seller",
        origin: "https://api-seller.ozon.test",
        serviceLabel: "Seller data",
        confidence: "high",
        evidence: [evidence],
        observationCount: 1,
      }],
      credentials: [{
        id: "credential-api-key",
        fieldName: "Api-Key",
        kind: "api_key",
        placement: "header",
        humanLabel: "API key",
        confidence: "high",
        evidence: [{ ...evidence, kind: "openapi_security", pointer: "/components/securitySchemes/apiKey" }],
      }],
    });

    expect(parsed.origins[0]?.origin).toBe("https://api-seller.ozon.test");
    expect(parsed.credentials[0]?.fieldName).toBe("Api-Key");
  });

  it("rejects candidate extensions that could retain example secrets", () => {
    expect(() => DiscoveryResultSchema.parse({
      ...emptyDiscoveryResult(),
      credentials: [{
        id: "credential-api-key",
        fieldName: "Api-Key",
        kind: "api_key",
        placement: "header",
        humanLabel: "API key",
        confidence: "high",
        evidence: [{ ...evidence, kind: "openapi_security" }],
        exampleValue: "must-not-exist",
      }],
    })).toThrow();
  });

  it("rejects an API URL with a path instead of an exact origin", () => {
    expect(() => DiscoveryResultSchema.parse({
      ...emptyDiscoveryResult(),
      origins: [{
        id: "origin-api-seller",
        origin: "https://api-seller.ozon.test/v3",
        serviceLabel: null,
        confidence: "high",
        evidence: [evidence],
        observationCount: 1,
      }],
    })).toThrow(/origin/iu);
  });
});
