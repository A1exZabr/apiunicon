import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type TunnelStatus = "not_configured" | "stopped" | "starting" | "healthy" | "failed";

export type TunnelConfigRecord = {
  tunnelId: string;
  runtimeCredentialSetId: string;
  profileName: string;
  status: TunnelStatus;
  lastErrorCategory: string | null;
  updatedAt: string;
};

export type TunnelEvent = {
  level: "info" | "error";
  message: string;
  createdAt: string;
};

type ConfigRow = {
  tunnel_id: string;
  runtime_credential_set_id: string;
  profile_name: string;
  status: TunnelStatus;
  last_error_category: string | null;
  updated_at: string;
};

export class TunnelRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(): TunnelConfigRecord | null {
    const row = this.db.prepare("select * from tunnel_config where id = 'primary'").get() as ConfigRow | undefined;
    return row ? {
      tunnelId: row.tunnel_id,
      runtimeCredentialSetId: row.runtime_credential_set_id,
      profileName: row.profile_name,
      status: row.status,
      lastErrorCategory: row.last_error_category,
      updatedAt: row.updated_at,
    } : null;
  }

  configure(input: {
    tunnelId: string;
    runtimeCredentialSetId: string;
    profileName: string;
  }): TunnelConfigRecord {
    this.db.prepare(
      `insert into tunnel_config
       (id, tunnel_id, runtime_credential_set_id, profile_name, status, last_error_category, updated_at)
       values ('primary', ?, ?, ?, 'stopped', null, ?)
       on conflict(id) do update set tunnel_id = excluded.tunnel_id,
         runtime_credential_set_id = excluded.runtime_credential_set_id,
         profile_name = excluded.profile_name, status = 'stopped',
         last_error_category = null, updated_at = excluded.updated_at`,
    ).run(
      input.tunnelId, input.runtimeCredentialSetId, input.profileName, this.now().toISOString(),
    );
    return this.get()!;
  }

  setStatus(status: TunnelStatus, errorCategory: string | null = null): TunnelConfigRecord {
    const result = this.db.prepare(
      `update tunnel_config set status = ?, last_error_category = ?, updated_at = ?
       where id = 'primary'`,
    ).run(status, errorCategory, this.now().toISOString());
    if (result.changes === 0) throw new Error("Tunnel is not configured");
    return this.get()!;
  }

  appendEvent(level: "info" | "error", message: string): void {
    this.db.transaction(() => {
      this.db.prepare(
        "insert into tunnel_events (id, level, message, created_at) values (?, ?, ?, ?)",
      ).run(randomUUID(), level, message.slice(0, 4_000), this.now().toISOString());
      this.db.prepare(
        `delete from tunnel_events where id in (
           select id from tunnel_events order by created_at desc, rowid desc limit -1 offset 200
         )`,
      ).run();
    })();
  }

  recentEvents(limit = 30): TunnelEvent[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const rows = this.db.prepare(
      `select level, message, created_at from tunnel_events
       order by created_at desc, rowid desc limit ?`,
    ).all(safeLimit) as Array<{ level: "info" | "error"; message: string; created_at: string }>;
    return rows.map((row) => ({ level: row.level, message: row.message, createdAt: row.created_at }));
  }
}
