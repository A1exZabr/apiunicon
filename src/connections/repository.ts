import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { HttpsOriginSchema } from "../adapters/schema.js";
import { flushErasedData } from "../db/database.js";
import { NotFoundError, type CredentialStatus } from "../domain/types.js";

export type DocumentationSourceRecord = {
  id: string;
  rootUrl: string;
  allowedOrigin: string;
  status: "pending" | "crawling" | "ready" | "failed";
  contentFingerprint: string | null;
  errorCategory: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConnectionRecord = {
  id: string;
  label: string;
  adapterId: string | null;
  documentationSourceId: string;
  allowedOrigins: string[];
  credentialSetId: string;
  credentials: CredentialStatus[];
  // Whether an assistant may ask to change data through this connection. Off until the person turns it on.
  writesEnabled: boolean;
  // Whether a change through this connection waits for the person to confirm it on a page. On until the person turns
  // it off; the account-wide setting can skip it too, so this alone is not the mode in effect.
  confirmChanges: boolean;
  createdAt: string;
  updatedAt: string;
};

type DocumentationSourceRow = {
  id: string;
  root_url: string;
  allowed_origin: string;
  status: DocumentationSourceRecord["status"];
  content_fingerprint: string | null;
  error_category: string | null;
  created_at: string;
  updated_at: string;
};

type ConnectionRow = {
  id: string;
  label: string;
  adapter_id: string | null;
  documentation_source_id: string;
  allowed_origins_json: string;
  credential_set_id: string;
  writes_enabled: number;
  confirm_changes: number;
  created_at: string;
  updated_at: string;
};

export class ConnectionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createDocumentationSource(input: {
    rootUrl: string;
    allowedOrigin: string;
  }): DocumentationSourceRecord {
    const rootUrl = new URL(input.rootUrl);
    if (rootUrl.protocol !== "https:") throw new Error("Documentation URL must use HTTPS");
    const allowedOrigin = HttpsOriginSchema.parse(input.allowedOrigin);
    if (rootUrl.origin !== allowedOrigin) {
      throw new Error("Documentation URL must match its allowed origin");
    }

    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `insert into documentation_sources
          (id, root_url, allowed_origin, status, created_at, updated_at)
         values (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, rootUrl.toString(), allowedOrigin, timestamp, timestamp);
    return this.getDocumentationSource(id);
  }

  getDocumentationSource(id: string): DocumentationSourceRecord {
    const row = this.db
      .prepare("select * from documentation_sources where id = ?")
      .get(id) as DocumentationSourceRow | undefined;
    if (!row) throw new NotFoundError("Documentation source", id);
    return {
      id: row.id,
      rootUrl: row.root_url,
      allowedOrigin: row.allowed_origin,
      status: row.status,
      contentFingerprint: row.content_fingerprint,
      errorCategory: row.error_category,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createConnection(input: {
    label: string;
    documentationSourceId: string;
    allowedOrigins: string[];
    credentialSetId: string;
    adapterId?: string;
  }): ConnectionRecord {
    const allowedOrigins = input.allowedOrigins.map((origin) => HttpsOriginSchema.parse(origin));
    const id = randomUUID();
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `insert into connections
          (id, label, adapter_id, documentation_source_id, allowed_origins_json,
           credential_set_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label,
        input.adapterId ?? null,
        input.documentationSourceId,
        JSON.stringify(allowedOrigins),
        input.credentialSetId,
        timestamp,
        timestamp,
      );
    return this.getConnection(id);
  }

  getConnection(id: string): ConnectionRecord {
    const row = this.db.prepare("select * from connections where id = ?").get(id) as
      | ConnectionRow
      | undefined;
    if (!row) throw new NotFoundError("Connection", id);
    const credentialRows = this.db
      .prepare(
        "select field_name from credential_fields where credential_set_id = ? order by field_name",
      )
      .all(row.credential_set_id) as Array<{ field_name: string }>;
    return {
      id: row.id,
      label: row.label,
      adapterId: row.adapter_id,
      documentationSourceId: row.documentation_source_id,
      allowedOrigins: JSON.parse(row.allowed_origins_json) as string[],
      credentialSetId: row.credential_set_id,
      credentials: credentialRows.map(({ field_name }) => ({
        fieldName: field_name,
        configured: true,
      })),
      writesEnabled: row.writes_enabled === 1,
      // Only an explicit 0 turns confirmation off; any other value, however it got there, keeps asking the person.
      confirmChanges: row.confirm_changes !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listConnections(): ConnectionRecord[] {
    const rows = this.db.prepare("select id from connections order by created_at, rowid").all() as Array<{
      id: string;
    }>;
    return rows.map(({ id }) => this.getConnection(id));
  }

  // The connections an adapter serves, oldest first.
  listIdsByAdapter(adapterId: string): string[] {
    const rows = this.db.prepare("select id from connections where adapter_id = ? order by created_at, rowid").all(adapterId) as Array<{
      id: string;
    }>;
    return rows.map(({ id }) => id);
  }

  bindAdapter(connectionId: string, adapterId: string): ConnectionRecord {
    const result = this.db
      .prepare("update connections set adapter_id = ?, updated_at = ? where id = ?")
      .run(adapterId, this.now().toISOString(), connectionId);
    if (result.changes === 0) throw new NotFoundError("Connection", connectionId);
    return this.getConnection(connectionId);
  }

  // Binds another adapter in place of the current one, erasing a private adapter the connection leaves behind. Binding
  // the adapter that is already bound changes nothing.
  replaceAdapter(connectionId: string, adapterId: string): ConnectionRecord {
    return this.db.transaction(() => {
      if (this.getConnection(connectionId).adapterId !== adapterId) this.detachPrivateAdapter(connectionId);
      return this.bindAdapter(connectionId, adapterId);
    })();
  }

  rename(id: string, label: string): ConnectionRecord {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new Error("A connection name must contain 1 to 200 characters");
    }
    const result = this.db
      .prepare("update connections set label = ?, updated_at = ? where id = ?")
      .run(trimmed, this.now().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError("Connection", id);
    return this.getConnection(id);
  }

  // The person's switch for changing data through the connection. Turning it off does not cancel the changes that
  // wait for the person; the change service does that.
  setWritesEnabled(id: string, enabled: boolean): ConnectionRecord {
    const result = this.db
      .prepare("update connections set writes_enabled = ?, updated_at = ? where id = ?")
      .run(enabled ? 1 : 0, this.now().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError("Connection", id);
    return this.getConnection(id);
  }

  // The person's setting for confirming changes through the connection. Turning it off leaves the changes that already
  // wait for the person as they are.
  setConfirmChanges(id: string, required: boolean): ConnectionRecord {
    const result = this.db
      .prepare("update connections set confirm_changes = ?, updated_at = ? where id = ?")
      .run(required ? 1 : 0, this.now().toISOString(), id);
    if (result.changes === 0) throw new NotFoundError("Connection", id);
    return this.getConnection(id);
  }

  // What deleting the connection does to its adapter. A private adapter that no other connection uses is erased with
  // it, because nothing could reach it again; a reusable or shared one stays.
  adapterOnDelete(id: string): "erased" | "kept" | "none" {
    const connection = this.getConnection(id);
    if (connection.adapterId === null) return "none";
    const erased = this.db.prepare(
      `select 1 from adapters where id = ? and visibility = 'private'
       and not exists (select 1 from connections where adapter_id = ? and id <> ?)`,
    ).get(connection.adapterId, connection.adapterId, id);
    return erased ? "erased" : "kept";
  }

  // Before a connection gets a new adapter: a private adapter only this connection used would become unreachable,
  // so it is erased now rather than left holding its slug and documentation.
  detachPrivateAdapter(id: string): void {
    const connection = this.getConnection(id);
    if (this.adapterOnDelete(id) !== "erased") return;
    this.db.prepare("update connections set adapter_id = null, updated_at = ? where id = ?").run(this.now().toISOString(), id);
    // Knowledge events, test outcomes, and audits go with the adapter by cascade.
    this.db.prepare("delete from adapters where id = ?").run(connection.adapterId);
  }

  // Erases the connection with its keys, history, and confirmation links, and its adapter when adapterOnDelete says
  // so. The documentation goes too unless an adapter or another connection still relies on it.
  delete(id: string): void {
    const connection = this.getConnection(id);
    this.db.transaction(() => {
      const eraseAdapter = this.adapterOnDelete(id) === "erased";
      this.db.prepare("delete from connection_drafts where completed_connection_id = ?").run(id);
      this.db.prepare("delete from connections where id = ?").run(id);
      // Knowledge events, test outcomes, and audits go with the adapter by cascade.
      if (eraseAdapter) this.db.prepare("delete from adapters where id = ?").run(connection.adapterId);
      const credentialsInUse = this.db.prepare(
        `select 1 from connections where credential_set_id = ?
         union all select 1 from tunnel_config where runtime_credential_set_id = ? limit 1`,
      ).get(connection.credentialSetId, connection.credentialSetId);
      if (!credentialsInUse) {
        this.db.prepare("delete from credential_sets where id = ?").run(connection.credentialSetId);
      }
      const sourceInUse = this.db.prepare(
        `select 1 from adapters where documentation_source_id = ?
         union all select 1 from connections where documentation_source_id = ? limit 1`,
      ).get(connection.documentationSourceId, connection.documentationSourceId);
      if (!sourceInUse) {
        // The full-text index is a virtual table and jobs name their subject without a foreign key, so their rows
        // go explicitly. A crawl that is running keeps its row so the runner can record how it ended.
        this.db.prepare("delete from documentation_chunks_fts where source_id = ?").run(connection.documentationSourceId);
        this.db.prepare("delete from jobs where subject_id = ? and status <> 'running'").run(connection.documentationSourceId);
        this.db.prepare("delete from documentation_sources where id = ?").run(connection.documentationSourceId);
      }
    })();
    flushErasedData(this.db);
  }
}
