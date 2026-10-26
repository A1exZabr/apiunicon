import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { NotFoundError } from "../../src/domain/types.js";
import { Vault } from "../../src/vault/vault.js";

describe("credential vault", () => {
  let db: Database.Database;
  let vault: Vault;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    vault = new Vault(db, Buffer.alloc(32, 9));
  });

  afterEach(() => db.close());

  it("stores authenticated ciphertext with an independent nonce per field", () => {
    vault.storeFields("credentials-1", {
      "Api-Key": "super-secret",
      "Client-Id": "123456",
    });

    const rows = db
      .prepare(
        "select field_name, ciphertext, nonce, auth_tag from credential_fields order by field_name",
      )
      .all() as Array<{
      field_name: string;
      ciphertext: string;
      nonce: string;
      auth_tag: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("super-secret");
    expect(JSON.stringify(rows)).not.toContain("123456");
    expect(new Set(rows.map(({ nonce }) => nonce)).size).toBe(2);
    expect(rows.every(({ auth_tag }) => Buffer.from(auth_tag, "base64").length === 16)).toBe(true);
  });

  it("reveals fields only inside a request-scoped callback", async () => {
    vault.storeFields("credentials-1", { "Api-Key": "super-secret" });

    const observed = await vault.withCredentials("credentials-1", async (fields) => ({
      fieldNames: Object.keys(fields),
      apiKey: fields["Api-Key"],
    }));

    expect(observed).toEqual({ fieldNames: ["Api-Key"], apiKey: "super-secret" });
    expect(Object.keys(vault)).not.toContain("getCredentials");
  });

  it("reads the same fields synchronously, blanks them afterwards and refuses an unknown set", () => {
    vault.storeFields("set-1", { "Api-Key": "v1" });

    expect(vault.withCredentialsSync("set-1", (fields) => ({ ...fields }))).toEqual({ "Api-Key": "v1" });
    let kept: Readonly<Record<string, string>> = {};
    vault.withCredentialsSync("set-1", (fields) => {
      kept = fields;
    });
    expect(kept["Api-Key"]).toBe("");
    expect(() => vault.withCredentialsSync("missing", () => 1)).toThrow(NotFoundError);
  });

  it("detects ciphertext tampering instead of returning corrupted plaintext", async () => {
    vault.storeFields("credentials-1", { "Api-Key": "super-secret" });
    db.prepare(
      "update credential_fields set auth_tag = ? where credential_set_id = ?",
    ).run(Buffer.alloc(16, 1).toString("base64"), "credentials-1");

    await expect(
      vault.withCredentials("credentials-1", async (fields) => fields["Api-Key"]),
    ).rejects.toThrow();
  });
});
