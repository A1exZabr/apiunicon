import type Database from "better-sqlite3";

import { isLinkToken, newLinkToken, tokenHash } from "../security/one-time-token.js";

export const ACTION_LINK_TTL_MS = 30 * 60_000;
// The link that approves reads sent with POST works as long as a change's confirmation link.
export const READ_APPROVAL_LINK_TTL_MS = 15 * 60_000;
// Approval links of one connection that work at once; a newer one ends the oldest.
export const MAX_READ_APPROVAL_LINKS = 10;

// delete: the deletion of the connection. approve_reads: the approval of its reads sent with POST.
export type ConnectionAction = "delete" | "approve_reads";

// How long each action's link works, and whether a new link ends the earlier ones. A deletion has one link at a time.
// Approval links are given in several tool results in a row (a new adapter, then a refused call), so a newer one leaves
// the earlier ones working: the person may already have one of them open.
const ACTIONS: Record<ConnectionAction, { ttlMs: number; keepsEarlier: boolean }> = {
  delete: { ttlMs: ACTION_LINK_TTL_MS, keepsEarlier: false },
  approve_reads: { ttlMs: READ_APPROVAL_LINK_TTL_MS, keepsEarlier: true },
};

// One-time links for actions on an existing connection that the person confirms on a page rather than in the chat,
// because content the AI reads could talk it into them. Only the token's hash is stored.
export class ConnectionActionLinkRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // For a deletion only the newest link works, so a link shown earlier in the chat cannot be used after a new one.
  // Expired links of the connection are cleared on the way.
  issue(connectionId: string, action: ConnectionAction): { token: string; expiresAt: string } {
    const token = newLinkToken();
    const created = this.now();
    const { ttlMs, keepsEarlier } = ACTIONS[action];
    const expiresAt = new Date(created.getTime() + ttlMs).toISOString();
    this.db.transaction(() => {
      this.db.prepare("delete from connection_action_links where connection_id = ? and expires_at <= ?")
        .run(connectionId, created.toISOString());
      // Of the earlier links, as many stay as leave room for this one.
      this.db.prepare(
        `delete from connection_action_links where token_hash in (
           select token_hash from connection_action_links where connection_id = ? and action = ?
           order by created_at desc, rowid desc limit -1 offset ?)`,
      ).run(connectionId, action, keepsEarlier ? MAX_READ_APPROVAL_LINKS - 1 : 0);
      this.db.prepare(
        `insert into connection_action_links (token_hash, connection_id, action, expires_at, created_at)
         values (?, ?, ?, ?, ?)`,
      ).run(tokenHash(token), connectionId, action, expiresAt, created.toISOString());
    })();
    return { token, expiresAt };
  }

  verify(connectionId: string, action: ConnectionAction, token: string): boolean {
    if (!isLinkToken(token)) return false;
    const row = this.db.prepare(
      `select 1 from connection_action_links
       where token_hash = ? and connection_id = ? and action = ? and expires_at > ?`,
    ).get(tokenHash(token), connectionId, action, this.now().toISOString());
    return row !== undefined;
  }

  // Ends a link that still works. Of two concurrent uses of one link, exactly one gets true.
  consume(connectionId: string, action: ConnectionAction, token: string): boolean {
    if (!isLinkToken(token)) return false;
    return this.db.prepare(
      `delete from connection_action_links
       where token_hash = ? and connection_id = ? and action = ? and expires_at > ?`,
    ).run(tokenHash(token), connectionId, action, this.now().toISOString()).changes === 1;
  }
}
