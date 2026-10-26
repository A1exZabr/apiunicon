import { describe, expect, it } from "vitest";

import { catalogOrigin } from "../../src/catalog/origin.js";
import { loadConfig } from "../../src/config.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("catalog address", () => {
  it("follows the language of the account the local version runs under", () => {
    expect(catalogOrigin({ LANG: "ru_RU.UTF-8" })).toBe("https://apiunicon.ru");
    expect(catalogOrigin({ LANG: "en_US.UTF-8" })).toBe("https://apiunicon.online");
    expect(catalogOrigin({})).toBe("https://apiunicon.online");
    expect(catalogOrigin({ LC_ALL: "en_GB.UTF-8", LANG: "ru_RU.UTF-8" })).toBe("https://apiunicon.online");
    expect(catalogOrigin({ LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US.UTF-8" })).toBe("https://apiunicon.ru");
  });

  it("takes an explicit HTTPS origin and refuses anything else", () => {
    expect(catalogOrigin({ APIUNICON_CATALOG_ORIGIN: "https://catalog.example.com/", LANG: "ru_RU.UTF-8" }))
      .toBe("https://catalog.example.com");
    expect(() => catalogOrigin({ APIUNICON_CATALOG_ORIGIN: "http://apiunicon.online" })).toThrow(/HTTPS origin/u);
    expect(() => catalogOrigin({ APIUNICON_CATALOG_ORIGIN: "https://apiunicon.online/catalog" })).toThrow(/HTTPS origin/u);
  });

  it("names the setting when the value is not even a URL", () => {
    for (const value of ["apiunicon.online", "not a url", "https://"]) {
      expect(() => catalogOrigin({ APIUNICON_CATALOG_ORIGIN: value })).toThrow(/APIUNICON_CATALOG_ORIGIN must be an HTTPS origin/u);
      expect(() => loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_CATALOG_ORIGIN: value })).toThrow(/APIUNICON_CATALOG_ORIGIN must be an HTTPS origin/u);
    }
  });

  it("is part of the local configuration, by the language unless the setting names the cloud", () => {
    expect(loadConfig({ APIUNICON_MASTER_KEY: key, LANG: "ru_RU.UTF-8" }).catalogOrigin).toBe("https://apiunicon.ru");
    expect(loadConfig({ APIUNICON_MASTER_KEY: key }).catalogOrigin).toBe("https://apiunicon.online");
    expect(loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_CATALOG_ORIGIN: "" }).catalogOrigin).toBe("https://apiunicon.online");
    expect(loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_CATALOG_ORIGIN: "https://apiunicon.ru", LANG: "en_US.UTF-8" }).catalogOrigin)
      .toBe("https://apiunicon.ru");
  });

  it("tells whether the address was chosen explicitly", () => {
    expect(loadConfig({ APIUNICON_MASTER_KEY: key, LANG: "ru_RU.UTF-8" }).catalogOriginExplicit).toBe(false);
    expect(loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_CATALOG_ORIGIN: "" }).catalogOriginExplicit).toBe(false);
    const explicit = loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_CATALOG_ORIGIN: "https://apiunicon.online" });
    expect(explicit.catalogOrigin).toBe("https://apiunicon.online");
    expect(explicit.catalogOriginExplicit).toBe(true);
  });
});
