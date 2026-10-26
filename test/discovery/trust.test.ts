import { describe, expect, it } from "vitest";

import type { DiscoveryResult } from "../../src/discovery/schema.js";
import { isPreselectedOrigin, mergeTrustedDiscovery } from "../../src/discovery/trust.js";

const LINK = "https://dev.wildberries.ru/docs/openapi/api-information";

function found(origins: Array<[string, "high" | "low"]>, fieldName = "Authorization"): DiscoveryResult {
  return {
    serviceName: "WB",
    suggestedLabel: "WB",
    origins: origins.map(([origin, confidence], index) => ({
      id: `origin-${index}0000000`,
      origin,
      serviceLabel: null,
      confidence,
      evidence: [{ pageUrl: "https://dev.wildberries.ru/a.yaml", kind: "openapi_server" }],
      observationCount: 1,
    })),
    credentials: [{
      id: "credential-auth",
      fieldName,
      kind: "api_key",
      placement: "header",
      humanLabel: "API key",
      confidence: "high",
      evidence: [{ pageUrl: "https://dev.wildberries.ru/a.yaml", kind: "openapi_security" }],
    }],
    unsupportedAuthMethods: [],
  };
}

describe("mergeTrustedDiscovery", () => {
  it("names the connection after the link's domain when documents carry different titles", () => {
    const titled = (title: string): DiscoveryResult => ({ ...found([]), serviceName: title, suggestedLabel: title });
    const merged = mergeTrustedDiscovery(LINK, [
      { provenance: "official", discovery: titled("General") },
      { provenance: "official", discovery: titled("Items") },
    ]);
    expect(merged.result).toMatchObject({ serviceName: "Wildberries", suggestedLabel: "Wildberries" });

    const single = mergeTrustedDiscovery(LINK, [
      { provenance: "official", discovery: titled("Seller API") },
      { provenance: "official", discovery: { ...found([]), serviceName: null, suggestedLabel: null } },
    ]);
    expect(single.result).toMatchObject({ serviceName: "Seller API", suggestedLabel: "Seller API" });
  });

  it("keeps off-domain destinations from official documents but never preselects them", () => {
    const merged = mergeTrustedDiscovery(LINK, [{
      provenance: "official",
      discovery: found([["https://marketplace-api.wildberries.ru", "high"], ["https://partner.example", "high"]]),
    }]);
    expect(merged.result.origins.map(({ origin }) => origin)).toEqual([
      "https://marketplace-api.wildberries.ru",
      "https://partner.example",
    ]);
    expect(merged.result.origins.map((candidate) => isPreselectedOrigin(candidate, LINK))).toEqual([true, false]);
  });

  it("discards off-domain destinations from third-party and AI-supplied documents", () => {
    for (const provenance of ["third_party", "model_content"] as const) {
      const merged = mergeTrustedDiscovery(LINK, [{
        provenance,
        discovery: found([["https://content-api.wildberries.ru", "high"], ["https://evil.example", "high"]]),
      }]);
      expect(merged.result.origins.map(({ origin }) => origin)).toEqual(["https://content-api.wildberries.ru"]);
      expect(merged.discardedOrigins).toEqual([{ origin: "https://evil.example", reason: "outside_link_domain" }]);
    }
  });

  it("merges destinations across documents and keeps the strongest confidence", () => {
    const merged = mergeTrustedDiscovery(LINK, [
      { provenance: "official", discovery: found([["https://a-api.wildberries.ru", "low"]]) },
      { provenance: "official", discovery: found([["https://a-api.wildberries.ru", "high"], ["https://b-api.wildberries.ru", "high"]]) },
    ]);
    expect(merged.result.origins.map(({ origin, confidence }) => [origin, confidence])).toEqual([
      ["https://a-api.wildberries.ru", "high"],
      ["https://b-api.wildberries.ru", "high"],
    ]);
    expect(merged.result.credentials).toHaveLength(1);
  });

  it("counts unsupported authentication only from official documents", () => {
    const withOAuth = (discovery: DiscoveryResult): DiscoveryResult => ({ ...discovery, unsupportedAuthMethods: ["OAuth 2.0"] });
    for (const provenance of ["third_party", "model_content"] as const) {
      const merged = mergeTrustedDiscovery(LINK, [
        { provenance: "official", discovery: found([["https://marketplace-api.wildberries.ru", "high"]]) },
        { provenance, discovery: withOAuth(found([])) },
      ]);
      expect(merged.result.unsupportedAuthMethods).toEqual([]);
    }
    const official = mergeTrustedDiscovery(LINK, [{ provenance: "official", discovery: withOAuth(found([])) }]);
    expect(official.result.unsupportedAuthMethods).toEqual(["OAuth 2.0"]);
  });

  // A person who is not technical should not have to tick the service's own hosts one by one.
  it("preselects every destination on the link's domain, whoever names it and however sure, and none elsewhere", () => {
    const preselected = (documents: Parameters<typeof mergeTrustedDiscovery>[1]) =>
      mergeTrustedDiscovery(LINK, documents).result.origins.map((candidate) => isPreselectedOrigin(candidate, LINK));
    const copy = found([["https://content-api.wildberries.ru", "high"]]);
    for (const provenance of ["third_party", "model_content"] as const) {
      expect(preselected([{ provenance, discovery: copy }])).toEqual([true]);
    }
    expect(preselected([{ provenance: "official", discovery: found([["https://content-api-sandbox.wildberries.ru", "low"]]) }])).toEqual([true]);
    expect(preselected([{ provenance: "official", discovery: found([["https://partner.example", "high"]]) }])).toEqual([false]);
  });
});

describe("trust on a shared documentation host", () => {
  const SHARED_LINK = "https://acme.readme.io/reference/orders";

  it("does not trust another customer's site on the same host, as it would the link's own", () => {
    const merged = mergeTrustedDiscovery(SHARED_LINK, [
      { provenance: "third_party", discovery: found([["https://evil.readme.io", "high"], ["https://acme.readme.io", "high"]]) },
    ]);
    expect(merged.result.origins.map(({ origin }) => origin)).toEqual(["https://acme.readme.io"]);
    expect(merged.discardedOrigins).toEqual([{ origin: "https://evil.readme.io", reason: "outside_link_domain" }]);

    const official = mergeTrustedDiscovery(SHARED_LINK, [
      { provenance: "official", discovery: found([["https://evil.readme.io", "high"], ["https://acme.readme.io", "high"]]) },
    ]);
    expect(official.result.origins.map((candidate) => [candidate.origin, isPreselectedOrigin(candidate, SHARED_LINK)])).toEqual([
      ["https://evil.readme.io", false],
      ["https://acme.readme.io", true],
    ]);
  });
});
