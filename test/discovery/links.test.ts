import { describe, expect, it } from "vitest";

import { ConnectionRepository } from "../../src/connections/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { DraftLinkRepository } from "../../src/discovery/links.js";
import { ConnectionDraftRepository } from "../../src/discovery/repository.js";

describe("DraftLinkRepository", () => {
  it("issues hashed single-use tokens bound to one draft that expire after 30 minutes", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);
    const source = new ConnectionRepository(db).createDocumentationSource({ rootUrl: "https://docs.shop.test/", allowedOrigin: "https://docs.shop.test" });
    const drafts = new ConnectionDraftRepository(db);
    const draft = drafts.create({ documentationSourceId: source.id });
    const other = drafts.create({ documentationSourceId: new ConnectionRepository(db).createDocumentationSource({ rootUrl: "https://docs.shop.test/b", allowedOrigin: "https://docs.shop.test" }).id });
    let now = new Date("2026-10-12T10:00:00Z");
    const links = new DraftLinkRepository(db, () => now);

    const { token, expiresAt } = links.issue(draft.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expiresAt).toBe("2026-10-12T10:30:00.000Z");
    expect(JSON.stringify(db.prepare("select * from connection_draft_links").all())).not.toContain(token);
    expect(links.verify(draft.id, token)).toBe(true);
    expect(links.verify(other.id, token)).toBe(false);
    expect(links.hasActive(draft.id)).toEqual({ expiresAt });

    now = new Date("2026-10-12T10:31:00Z");
    expect(links.verify(draft.id, token)).toBe(false);
    expect(links.hasActive(draft.id)).toBeNull();

    now = new Date("2026-10-12T10:00:00Z");
    const spare = links.issue(draft.id);
    const elsewhere = links.issue(other.id);
    links.consumeAll(draft.id);
    expect(links.verify(draft.id, token)).toBe(false);
    expect(links.verify(draft.id, spare.token)).toBe(false);
    expect(links.verify(other.id, elsewhere.token)).toBe(true);
    db.close();
  });
});
