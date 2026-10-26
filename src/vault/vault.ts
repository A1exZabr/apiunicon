import type Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { NotFoundError } from "../domain/types.js";

type CredentialFieldRow = {
  field_name: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
};

function blank(fields: Record<string, string>): void {
  for (const key of Object.keys(fields)) fields[key] = "";
}

export class Vault {
  constructor(
    private readonly db: Database.Database,
    private readonly masterKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (masterKey.length !== 32) {
      throw new Error("Vault master key must contain exactly 32 bytes");
    }
  }

  storeFields(credentialSetId: string, fields: Readonly<Record<string, string>>): void {
    if (Object.keys(fields).length === 0) {
      throw new Error("At least one credential field is required");
    }
    const timestamp = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `insert into credential_sets (id, created_at, updated_at) values (?, ?, ?)
           on conflict(id) do update set updated_at = excluded.updated_at`,
        )
        .run(credentialSetId, timestamp, timestamp);
      const statement = this.db.prepare(
        `insert into credential_fields
          (credential_set_id, field_name, ciphertext, nonce, auth_tag)
         values (?, ?, ?, ?, ?)
         on conflict(credential_set_id, field_name) do update set
           ciphertext = excluded.ciphertext,
           nonce = excluded.nonce,
           auth_tag = excluded.auth_tag`,
      );

      for (const [fieldName, value] of Object.entries(fields)) {
        if (!fieldName || /[\u0000-\u001f\u007f]/u.test(fieldName)) {
          throw new Error("Credential field names cannot be empty or contain control characters");
        }
        const encrypted = this.encrypt(value);
        statement.run(
          credentialSetId,
          fieldName,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
        );
      }
    })();
  }

  async withCredentials<T>(
    credentialSetId: string,
    callback: (fields: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    const fields = this.decryptSet(credentialSetId);
    try {
      return await callback(fields);
    } finally {
      blank(fields);
    }
  }

  // The same fields for a caller that cannot wait, such as one masking keys in an error's text on the answer path. They
  // are blanked as soon as the callback returns, so a callback that hands them to a promise leaves it only blanks.
  withCredentialsSync<T>(
    credentialSetId: string,
    callback: (fields: Readonly<Record<string, string>>) => T,
  ): T {
    const fields = this.decryptSet(credentialSetId);
    try {
      return callback(fields);
    } finally {
      blank(fields);
    }
  }

  // Every field of the set in plain text, for the callers above to blank. A field that fails to decrypt blanks the ones
  // already read before the error goes on.
  private decryptSet(credentialSetId: string): Record<string, string> {
    const exists = this.db
      .prepare("select 1 from credential_sets where id = ?")
      .get(credentialSetId);
    if (!exists) throw new NotFoundError("Credential set", credentialSetId);

    const rows = this.db
      .prepare(
        `select field_name, ciphertext, nonce, auth_tag
         from credential_fields where credential_set_id = ? order by field_name`,
      )
      .all(credentialSetId) as CredentialFieldRow[];
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    try {
      for (const row of rows) fields[row.field_name] = this.decrypt(row);
    } catch (error) {
      blank(fields);
      throw error;
    }
    return fields;
  }

  private encrypt(value: string): {
    ciphertext: string;
    nonce: string;
    authTag: string;
  } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  private decrypt(row: CredentialFieldRow): string {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.masterKey,
      Buffer.from(row.nonce, "base64"),
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }
}
