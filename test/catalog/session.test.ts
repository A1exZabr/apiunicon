import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CatalogSession } from "../../src/catalog/session.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { findKeyFragment } from "../../src/verification/export.js";
import { Vault } from "../../src/vault/vault.js";

const RU = "https://apiunicon.ru";
const ONLINE = "https://apiunicon.online";
const CALLBACK = "http://127.0.0.1:3210/catalog/callback";

describe("catalog sign-in on this computer", () => {
  let directory: string;
  let dbPath: string;
  let db: Database.Database;
  let vault: Vault;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "apiunicon-catalog-"));
    dbPath = join(directory, "state.sqlite");
    db = openDatabase(dbPath);
    migrateDatabase(db);
    vault = new Vault(db, Buffer.alloc(32, 35));
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("seals the keys with the master key and never writes them in plain text", async () => {
    const session = new CatalogSession(db, vault, ONLINE);

    session.saveTokens({ accessToken: "catalog-access-secret", refreshToken: "catalog-refresh-secret" }, ONLINE);

    expect(session.signedIn()).toBe(true);
    expect(await session.tokens()).toEqual({
      origin: ONLINE,
      accessToken: "catalog-access-secret",
      refreshToken: "catalog-refresh-secret",
    });
    expect(findKeyFragment(db, "catalog-access-secret")).toEqual([]);
    expect(findKeyFragment(db, "catalog-refresh-secret")).toEqual([]);
    db.close();
    const onDisk = [dbPath, `${dbPath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path).toString("latin1")).join("");
    expect(onDisk).not.toContain("catalog-access-secret");
    expect(onDisk).not.toContain("catalog-refresh-secret");
  });

  it("erases the keys on sign-out", async () => {
    const session = new CatalogSession(db, vault, ONLINE);
    session.saveTokens({ accessToken: "access-1", refreshToken: null }, ONLINE);

    session.clearTokens();

    expect(await session.tokens()).toBeNull();
    expect(session.signedIn()).toBe(false);
    expect((db.prepare("select count(*) as n from credential_fields").get() as { n: number }).n).toBe(0);
  });

  it("hands keys and the client only to the cloud that issued them", async () => {
    const ru = new CatalogSession(db, vault, RU);
    ru.saveClient(CALLBACK, "client-ru", RU);
    ru.saveTokens({ accessToken: "ru-access", refreshToken: "ru-refresh" }, RU);

    const online = new CatalogSession(db, vault, ONLINE);

    expect(online.signedIn()).toBe(false);
    expect(await online.tokens()).toBeNull();
    expect(online.clientId(CALLBACK, ONLINE)).toBeNull();
    expect(ru.clientId("http://127.0.0.1:4000/catalog/callback", RU)).toBeNull();
    online.saveTokens({ accessToken: "online-access", refreshToken: null }, ONLINE);
    expect(await ru.tokens()).toBeNull();
    expect((db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n).toBe(1);
  });

  it("follows the cloud that issued the stored keys when the address was not chosen explicitly", async () => {
    new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: "ru-refresh" }, RU);
    const following = () => new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });

    expect(following().origin).toBe(RU);
    expect(following().signedIn()).toBe(true);
    expect(await following().tokens()).toEqual({ origin: RU, accessToken: "ru-access", refreshToken: "ru-refresh" });
  });

  it("keeps an explicitly chosen cloud away from keys issued by another one", async () => {
    new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
    const explicit = new CatalogSession(db, vault, ONLINE);

    expect(explicit.origin).toBe(ONLINE);
    expect(explicit.signedIn()).toBe(false);
    expect(await explicit.tokens()).toBeNull();
  });

  it("goes back to the language default once the keys are gone", async () => {
    new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
    const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });
    expect(following.origin).toBe(RU);

    following.clearTokens();

    expect(following.origin).toBe(ONLINE);
    expect(following.signedIn()).toBe(false);
    expect(await following.tokens()).toBeNull();
  });

  it("replaces the keys in the cloud that issued them, not in the language default", async () => {
    new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access-1", refreshToken: "ru-refresh-1" }, RU);
    const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });
    const held = await following.tokens();

    following.saveTokens({ accessToken: "ru-access-2", refreshToken: null }, held!.origin);

    expect(following.origin).toBe(RU);
    expect(await following.tokens()).toEqual({ origin: RU, accessToken: "ru-access-2", refreshToken: null });
    expect(await new CatalogSession(db, vault, RU).tokens()).toEqual({ origin: RU, accessToken: "ru-access-2", refreshToken: null });
    expect((db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n).toBe(1);
  });

  it("looks the client up for the cloud the caller is about to talk to", () => {
    const first = new CatalogSession(db, vault, RU);
    first.saveClient(CALLBACK, "client-ru", RU);
    first.saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
    const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });

    expect(following.clientId(CALLBACK, following.origin)).toBe("client-ru");
    following.clearTokens();
    expect(following.clientId(CALLBACK, following.origin)).toBeNull();
    expect(following.clientId(CALLBACK, ONLINE)).toBeNull();
    expect(following.clientId(CALLBACK, RU)).toBe("client-ru");
  });

  it("does not adopt a stored address that is not an HTTPS origin", async () => {
    new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
    const stored = JSON.parse((db.prepare("select value_json from app_settings where key = 'catalog.tokens'").get() as { value_json: string }).value_json) as Record<string, string>;
    db.prepare("update app_settings set value_json = ? where key = 'catalog.tokens'")
      .run(JSON.stringify({ ...stored, origin: "http://evil.example" }));
    const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });

    expect(following.origin).toBe(ONLINE);
    expect(following.signedIn()).toBe(false);
    expect(await following.tokens()).toBeNull();
  });

  describe("when the cloud changes between asking it and recording its answer", () => {
    const nothingStored = async (session: CatalogSession) => {
      expect(session.signedIn()).toBe(false);
      expect(await session.tokens()).toBeNull();
      expect((db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n).toBe(0);
      expect((db.prepare("select count(*) as n from credential_fields").get() as { n: number }).n).toBe(0);
      expect(db.prepare("select key from app_settings where key = 'catalog.tokens'").all()).toEqual([]);
    };

    it("lets the sign-out stand when a refresh answer arrives after it", async () => {
      new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: "ru-refresh" }, RU);
      const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });
      const held = await following.tokens();
      expect(held?.origin).toBe(RU);

      following.clearTokens();
      expect(following.origin).toBe(ONLINE);
      following.saveTokens({ accessToken: "ru-access-2", refreshToken: "ru-refresh-2" }, held!.origin);

      await nothingStored(following);
      await nothingStored(new CatalogSession(db, vault, RU));
      expect(following.origin).toBe(ONLINE);
    });

    it("does not record the keys of one cloud as another cloud's", async () => {
      const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });

      following.saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);

      await nothingStored(following);
    });

    it("does not overwrite another cloud's keys with a late answer", async () => {
      new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: "ru-refresh" }, RU);
      const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });
      const held = await following.tokens();

      new CatalogSession(db, vault, ONLINE).saveTokens({ accessToken: "online-access", refreshToken: null }, ONLINE);
      following.saveTokens({ accessToken: "ru-access-2", refreshToken: "ru-refresh-2" }, held!.origin);

      expect(await following.tokens()).toEqual({ origin: ONLINE, accessToken: "online-access", refreshToken: null });
      expect((db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n).toBe(1);
    });

    it("records a client id for the cloud that issued it, whatever another process signed in to meanwhile", async () => {
      const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });
      const registeredAt = following.origin;
      expect(registeredAt).toBe(ONLINE);

      const other = new CatalogSession(db, vault, RU);
      other.saveClient(CALLBACK, "client-ru", RU);
      other.saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
      following.saveClient(CALLBACK, "client-online", registeredAt);
      following.saveTokens({ accessToken: "online-access", refreshToken: null }, registeredAt);

      expect(following.clientId(CALLBACK, ONLINE)).toBe("client-online");
      expect(following.clientId(CALLBACK, RU)).toBe("client-ru");
      expect(following.origin).toBe(RU);
      expect(await following.tokens()).toEqual({ origin: RU, accessToken: "ru-access", refreshToken: null });
    });

    it("ignores a write for a cloud other than the one a strict session is bound to", async () => {
      const strict = new CatalogSession(db, vault, ONLINE);

      strict.saveTokens({ accessToken: "ru-access", refreshToken: null }, RU);
      strict.saveClient(CALLBACK, "client-ru", RU);

      await nothingStored(strict);
      expect(strict.clientId(CALLBACK, RU)).toBeNull();
      expect(strict.clientId(CALLBACK, ONLINE)).toBeNull();
      expect(db.prepare("select key from app_settings where key = 'catalog.client'").all()).toEqual([]);
    });

    it("ignores a write that names something other than an HTTPS origin", async () => {
      const strict = new CatalogSession(db, vault, ONLINE);

      strict.saveTokens({ accessToken: "access", refreshToken: null }, "http://apiunicon.online");
      strict.saveTokens({ accessToken: "access", refreshToken: null }, "apiunicon.online");
      strict.saveClient(CALLBACK, "client", "http://apiunicon.online");

      await nothingStored(strict);
      expect(db.prepare("select key from app_settings where key = 'catalog.client'").all()).toEqual([]);
    });

    it("stores the issuing cloud in its normal form", async () => {
      const session = new CatalogSession(db, vault, ONLINE);

      session.saveTokens({ accessToken: "access", refreshToken: null }, `${ONLINE}/`);
      session.saveClient(CALLBACK, "client", `${ONLINE}/`);

      expect(await session.tokens()).toEqual({ origin: ONLINE, accessToken: "access", refreshToken: null });
      expect(session.clientId(CALLBACK, ONLINE)).toBe("client");
      expect(session.clientId(CALLBACK, `${ONLINE}/`)).toBe("client");
    });
  });

  describe("replacing keys that were read earlier", () => {
    const credentialSets = () => (db.prepare("select count(*) as n from credential_sets").get() as { n: number }).n;

    it("says whether it stored the keys and the client", () => {
      const strict = new CatalogSession(db, vault, ONLINE);

      expect(strict.saveTokens({ accessToken: "online-access", refreshToken: null }, ONLINE)).toBe(true);
      expect(strict.saveTokens({ accessToken: "ru-access", refreshToken: null }, RU)).toBe(false);
      expect(strict.saveClient(CALLBACK, "client-online", ONLINE)).toBe(true);
      expect(strict.saveClient(CALLBACK, "client-ru", RU)).toBe(false);
    });

    it("stores the successor while the same keys are still stored", async () => {
      const session = new CatalogSession(db, vault, ONLINE);
      session.saveTokens({ accessToken: "access-1", refreshToken: "refresh-1" }, ONLINE);

      const replaced = await session.replaceTokens("refresh-1", { accessToken: "access-2", refreshToken: "refresh-2" }, ONLINE);

      expect(replaced).toBe(true);
      expect(await session.tokens()).toEqual({ origin: ONLINE, accessToken: "access-2", refreshToken: "refresh-2" });
      expect(credentialSets()).toBe(1);
    });

    it("stores nothing after the person signed out, or once newer keys replaced the ones read", async () => {
      const session = new CatalogSession(db, vault, ONLINE);
      session.saveTokens({ accessToken: "access-1", refreshToken: "refresh-1" }, ONLINE);
      session.clearTokens();

      expect(await session.replaceTokens("refresh-1", { accessToken: "access-2", refreshToken: "refresh-2" }, ONLINE)).toBe(false);
      expect(await session.tokens()).toBeNull();
      expect(credentialSets()).toBe(0);

      session.saveTokens({ accessToken: "access-3", refreshToken: "refresh-3" }, ONLINE);
      expect(await session.replaceTokens("refresh-1", { accessToken: "access-2", refreshToken: "refresh-2" }, ONLINE)).toBe(false);
      expect(await session.tokens()).toEqual({ origin: ONLINE, accessToken: "access-3", refreshToken: "refresh-3" });
    });

    it("leaves keys of another cloud alone, even with the same refresh key", async () => {
      new CatalogSession(db, vault, RU).saveTokens({ accessToken: "ru-access", refreshToken: "shared-refresh" }, RU);
      const following = new CatalogSession(db, vault, ONLINE, undefined, { followStoredOrigin: true });

      expect(await following.replaceTokens("shared-refresh", { accessToken: "x", refreshToken: null }, ONLINE)).toBe(false);
      expect(await following.replaceTokens("shared-refresh", null, ONLINE)).toBe(false);
      expect(await new CatalogSession(db, vault, ONLINE).replaceTokens("shared-refresh", null, RU)).toBe(false);
      expect(await following.tokens()).toEqual({ origin: RU, accessToken: "ru-access", refreshToken: "shared-refresh" });
    });

    it("erases the keys read earlier when there is nothing to replace them with", async () => {
      const session = new CatalogSession(db, vault, ONLINE);
      session.saveTokens({ accessToken: "access-1", refreshToken: "refresh-1" }, ONLINE);

      expect(await session.replaceTokens("refresh-other", null, ONLINE)).toBe(false);
      expect(session.signedIn()).toBe(true);
      expect(await session.replaceTokens("refresh-1", null, ONLINE)).toBe(true);

      expect(await session.tokens()).toBeNull();
      expect(credentialSets()).toBe(0);
    });

    it("checks the stored keys again at the moment it writes", async () => {
      // Another process stores keys between the read of the old keys and the write of their successor. A cloud that
      // does not rotate refresh keys hands out the same refresh key again, so only the stored set itself tells.
      let meanwhile: (() => void) | undefined;
      const racingVault: Pick<Vault, "storeFields" | "withCredentials"> = {
        storeFields: (id, fields) => vault.storeFields(id, fields),
        withCredentials: async (id, callback) => {
          const result = await vault.withCredentials(id, callback);
          const run = meanwhile;
          meanwhile = undefined;
          run?.();
          return result;
        },
      };
      const session = new CatalogSession(db, racingVault, ONLINE);
      session.saveTokens({ accessToken: "access-1", refreshToken: "refresh-1" }, ONLINE);
      meanwhile = () => new CatalogSession(db, vault, ONLINE).saveTokens({ accessToken: "access-other", refreshToken: "refresh-1" }, ONLINE);

      const replaced = await session.replaceTokens("refresh-1", { accessToken: "access-2", refreshToken: "refresh-2" }, ONLINE);

      expect(replaced).toBe(false);
      expect(await session.tokens()).toEqual({ origin: ONLINE, accessToken: "access-other", refreshToken: "refresh-1" });
    });

    it("erases only the keys of the cloud it is told about", async () => {
      new CatalogSession(db, vault, ONLINE).saveTokens({ accessToken: "online-access", refreshToken: null }, ONLINE);
      const following = new CatalogSession(db, vault, RU, undefined, { followStoredOrigin: true });

      following.clearTokens(RU);
      following.clearTokens("not an origin");
      expect(await following.tokens()).toEqual({ origin: ONLINE, accessToken: "online-access", refreshToken: null });

      following.clearTokens(`${ONLINE}/`);
      expect(await following.tokens()).toBeNull();
      expect(credentialSets()).toBe(0);
    });
  });

  it("remembers that the person turned the catalog off", () => {
    new CatalogSession(db, vault, ONLINE).setDisabled(true);

    expect(new CatalogSession(db, vault, ONLINE).disabled()).toBe(true);
  });
});
