import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AdapterRepository, VersionConflictError } from "../../src/adapters/repository.js";
import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { validAdapterDsl } from "./schema.test.js";

describe("versioned adapter repository", () => {
  let db: Database.Database;
  let adapters: AdapterRepository;
  let connections: ConnectionRepository;
  let documentationSourceId: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrateDatabase(db);
    adapters = new AdapterRepository(db);
    connections = new ConnectionRepository(db);
    documentationSourceId = connections.createDocumentationSource({
      rootUrl: "https://docs.ozon.ru/api/seller/",
      allowedOrigin: "https://docs.ozon.ru",
    }).id;
  });

  afterEach(() => db.close());

  it("increments versions and rejects a stale patch", () => {
    const created = adapters.create({
      slug: "ozon-seller",
      displayName: "Ozon Seller",
      dsl: validAdapterDsl,
      documentationSourceId,
    });
    const changedDsl = {
      ...validAdapterDsl,
      operations: [
        { ...validAdapterDsl.operations[0]!, description: "List current FBS postings" },
      ],
    };

    const updated = adapters.patch(created.id, 1, changedDsl);

    expect(updated.version).toBe(2);
    expect(updated.dsl.operations[0]?.description).toBe("List current FBS postings");
    expect(() => adapters.patch(created.id, 1, validAdapterDsl)).toThrow(
      VersionConflictError,
    );
  });

  it("keeps loading a stored adapter whose path template has a space", () => {
    const path = "/odata/Catalog_Items?$filter=Posted eq true";
    const created = adapters.create({
      slug: "onec-catalog",
      displayName: "1C catalog",
      dsl: { ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0]!, path }] },
      documentationSourceId,
    });
    // Every read parses the stored adapter again, so a template the schema refused would make the adapter unreadable.
    db.prepare("update adapters set dsl_json = ? where id = ?").run(
      JSON.stringify({ ...validAdapterDsl, operations: [{ ...validAdapterDsl.operations[0]!, path }] }),
      created.id,
    );

    expect(adapters.get(created.id).dsl.operations[0]?.path).toBe(path);
    expect(adapters.search("").map(({ id }) => id)).toContain(created.id);
  });

  it("marks only a working adapter reusable", () => {
    const created = adapters.create({
      slug: "ozon-seller",
      displayName: "Ozon Seller",
      dsl: validAdapterDsl,
      documentationSourceId,
    });

    expect(() => adapters.markReusable(created.id, 1)).toThrow(/working/i);

    const working = adapters.markWorking(created.id, 1);
    const reusable = adapters.markReusable(created.id, working.version);

    expect(reusable.visibility).toBe("reusable");
    expect(reusable.version).toBe(3);
    expect(adapters.search("ozon").map(({ id }) => id)).toContain(created.id);
  });

  it("returns connection credential status without ciphertext", () => {
    db.prepare(
      "insert into credential_sets (id, created_at, updated_at) values (?, ?, ?)",
    ).run("credentials-1", "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    db.prepare(
      "insert into credential_fields (credential_set_id, field_name, ciphertext, nonce, auth_tag) values (?, ?, ?, ?, ?)",
    ).run("credentials-1", "Api-Key", "ciphertext-value", "nonce-value", "tag-value");

    const connection = connections.createConnection({
      label: "Ozon primary",
      documentationSourceId,
      allowedOrigins: ["https://api-seller.ozon.ru"],
      credentialSetId: "credentials-1",
    });

    const read = connections.getConnection(connection.id);
    expect(read.credentials).toEqual([{ fieldName: "Api-Key", configured: true }]);
    expect(JSON.stringify(read)).not.toContain("ciphertext-value");
    expect(JSON.stringify(read)).not.toContain("nonce-value");
  });

  it("finds only an exact working reusable adapter match", () => {
    const created = adapters.create({
      slug: "ozon-seller",
      displayName: "Ozon Seller",
      dsl: validAdapterDsl,
      documentationSourceId,
    });
    const working = adapters.markWorking(created.id, created.version);
    const reusable = adapters.markReusable(working.id, working.version);

    expect(adapters.findReusableMatch({
      origins: ["https://api-seller.ozon.ru"],
      credentialNames: ["Api-Key", "Client-Id"],
    })?.id).toBe(reusable.id);
    expect(adapters.findReusableMatch({
      origins: ["https://api-seller.ozon.ru"],
      credentialNames: ["Api-Key"],
    })).toBeNull();
    expect(adapters.findReusableMatch({
      origins: ["https://other.example.test"],
      credentialNames: ["Api-Key", "Client-Id"],
    })).toBeNull();
  });

  it("reuses an adapter for the documentation of its own site only, also on a shared documentation host", () => {
    const sharedSource = connections.createDocumentationSource({
      rootUrl: "https://acme.readme.io/reference", allowedOrigin: "https://acme.readme.io",
    }).id;
    const created = adapters.create({ slug: "acme", displayName: "Acme", dsl: validAdapterDsl, documentationSourceId: sharedSource });
    const working = adapters.markWorking(created.id, created.version);
    const reusable = adapters.markReusable(working.id, working.version);

    expect(adapters.findReusableForDocumentation("https://acme.readme.io/reference/orders")?.id).toBe(reusable.id);
    expect(adapters.findReusableForDocumentation("https://evil.readme.io/reference")).toBeNull();
    expect(adapters.findReusableForDocumentation("https://readme.io/")).toBeNull();
  });
});
