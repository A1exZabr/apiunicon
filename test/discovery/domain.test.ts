import { describe, expect, it } from "vitest";

import { registrableDomain, sameRegistrableDomain, serviceNameFromDomain, SHARED_DOCUMENTATION_HOSTS } from "../../src/discovery/domain.js";

describe("registrable domain", () => {
  it("groups subdomains under the public-suffix-aware registrable domain", () => {
    expect(registrableDomain("https://dev.wildberries.ru/docs/openapi/api-information")).toBe("wildberries.ru");
    expect(registrableDomain("https://marketplace-api.wildberries.ru")).toBe("wildberries.ru");
    expect(registrableDomain("https://api.example.co.uk/v1")).toBe("example.co.uk");
    expect(registrableDomain("https://alice.github.io/api")).toBe("alice.github.io");
    expect(registrableDomain("https://docs.shop.test/api")).toBe("shop.test");
  });

  it("returns null for addresses without a registrable domain", () => {
    expect(registrableDomain("https://127.0.0.1/")).toBeNull();
    expect(registrableDomain("https://localhost/")).toBeNull();
    expect(registrableDomain("not a url")).toBeNull();
  });

  it("compares by registrable domain, never by suffix text", () => {
    expect(sameRegistrableDomain("https://dev.wildberries.ru/x", "https://content-api.wildberries.ru")).toBe(true);
    expect(sameRegistrableDomain("https://dev.wildberries.ru/x", "https://wildberries.ru.evil.example")).toBe(false);
    expect(sameRegistrableDomain("https://alice.github.io/", "https://bob.github.io/")).toBe(false);
    expect(sameRegistrableDomain("https://localhost/", "https://localhost/")).toBe(false);
  });

  it("takes the whole host name on a host that gives every customer a subdomain for its documentation", () => {
    for (const shared of ["readme.io", "stoplight.io", "apiary.io", "redoc.ly", "postman.co", "bump.sh", "mintlify.app", "gitbook.io"]) {
      expect(SHARED_DOCUMENTATION_HOSTS.has(shared), shared).toBe(true);
      expect(registrableDomain(`https://acme.${shared}/reference`), shared).toBe(`acme.${shared}`);
      expect(sameRegistrableDomain(`https://acme.${shared}/reference`, `https://evil.${shared}/`), shared).toBe(false);
      expect(sameRegistrableDomain(`https://acme.${shared}/reference`, `https://ACME.${shared}./other`), shared).toBe(true);
    }
    expect(registrableDomain("https://readme.io/")).toBe("readme.io");
    // A deeper name on the same host is another site too.
    expect(sameRegistrableDomain("https://acme.readme.io/", "https://docs.acme.readme.io/")).toBe(false);
    expect(serviceNameFromDomain("https://acme.readme.io/reference")).toBe("Acme");
    // Other hosts keep their registrable domain.
    expect(registrableDomain("https://docs.readme.com/main/reference")).toBe("readme.com");
  });
});
