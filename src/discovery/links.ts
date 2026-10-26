import type Database from "better-sqlite3";

import { isLinkToken, newLinkToken, tokenHash } from "../security/one-time-token.js";

export const KEY_ENTRY_LINK_TTL_MS = 30 * 60_000;

export class DraftLinkRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(draftId: string): { token: string; expiresAt: string } {
    const token = newLinkToken();
    const created = this.now();
    const expiresAt = new Date(created.getTime() + KEY_ENTRY_LINK_TTL_MS).toISOString();
    this.db.prepare(
      "insert into connection_draft_links (token_hash, draft_id, expires_at, used_at, created_at) values (?, ?, ?, null, ?)",
    ).run(tokenHash(token), draftId, expiresAt, created.toISOString());
    return { token, expiresAt };
  }

  hasActive(draftId: string): { expiresAt: string } | null {
    const row = this.db.prepare(
      `select expires_at from connection_draft_links
       where draft_id = ? and used_at is null and expires_at > ?
       order by expires_at desc limit 1`,
    ).get(draftId, this.now().toISOString()) as { expires_at: string } | undefined;
    return row ? { expiresAt: row.expires_at } : null;
  }

  verify(draftId: string, token: string): boolean {
    if (!isLinkToken(token)) return false;
    const row = this.db.prepare(
      `select 1 from connection_draft_links
       where token_hash = ? and draft_id = ? and used_at is null and expires_at > ?`,
    ).get(tokenHash(token), draftId, this.now().toISOString());
    return row !== undefined;
  }

  // Once keys are saved, every other link of the draft is spent too: a spare link issued for the first key entry
  // must not stay open as a way to replace the keys later.
  consumeAll(draftId: string): void {
    this.db.prepare("update connection_draft_links set used_at = ? where draft_id = ? and used_at is null")
      .run(this.now().toISOString(), draftId);
  }
}
