import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { HttpsOriginSchema } from "../adapters/schema.js";
import { flushErasedData } from "../db/database.js";
import type { Vault } from "../vault/vault.js";

const CLIENT = "catalog.client";
const TOKENS = "catalog.tokens";
const DISABLED = "catalog.disabled";

const ClientSchema = z.object({ origin: z.string(), redirectUri: z.string(), clientId: z.string().min(1) });
const ClientsSchema = z.array(ClientSchema);
const TokensSchema = z.object({ origin: z.string(), credentialSetId: z.string().uuid() });

// A computer talks to a few clouds at most; past this, the oldest registration goes first.
const MAX_CLIENTS = 8;

export type CatalogTokens = { accessToken: string; refreshToken: string | null };
// The keys together with the cloud that issued them: they may be sent to that cloud only.
export type IssuedCatalogTokens = CatalogTokens & { origin: string };

export type CatalogSessionOptions = {
  // The origin given to the constructor is only the language default (AppConfig.catalogOriginExplicit is false): while
  // keys are stored, the cloud that issued them is the origin. Left out, the origin given is the only one ever used.
  followStoredOrigin?: boolean;
};

function normalOrigin(origin: string): string | null {
  const parsed = HttpsOriginSchema.safeParse(origin);
  return parsed.success ? parsed.data : null;
}

// What the local version remembers about the shared catalog. Settings live in app_settings; the keys are sealed in the
// vault with the master key, like a service's keys, and belong to the cloud that issued them: after the catalog
// address changes they are never sent anywhere.
//
// Everything that comes from a cloud is recorded under the origin the caller actually talked to, which it passes in.
// The origin getter can change while a request is in flight (another process signs in, the person signs out), so it
// only says which cloud to start something new with.
export class CatalogSession {
  private readonly defaultOrigin: string;

  constructor(
    private readonly db: Database.Database,
    private readonly vault: Pick<Vault, "storeFields" | "withCredentials">,
    defaultOrigin: string,
    private readonly now: () => Date = () => new Date(),
    private readonly options: CatalogSessionOptions = {},
  ) {
    this.defaultOrigin = normalOrigin(defaultOrigin) ?? defaultOrigin;
  }

  // The service gets its locale from the launch agent, an MCP process from whatever its client passes, so two
  // processes of one person can have different defaults. Without this, the one that cannot see the locale would ask
  // for a sign-in the other has already completed, forever.
  get origin(): string {
    if (!this.options.followStoredOrigin) return this.defaultOrigin;
    // Keys are sent to what is stored here, so it has to be a well-formed HTTPS origin.
    const stored = this.read(TOKENS, TokensSchema)?.origin;
    return (stored === undefined ? null : normalOrigin(stored)) ?? this.defaultOrigin;
  }

  disabled(): boolean {
    return this.read(DISABLED, z.boolean()) ?? false;
  }

  setDisabled(disabled: boolean): void {
    this.write(DISABLED, disabled);
  }

  // The client this computer registered with the given cloud for this callback address, if any.
  clientId(redirectUri: string, origin: string): string | null {
    const wanted = normalOrigin(origin);
    if (wanted === null) return null;
    const client = this.clients().find((entry) => entry.origin === wanted && entry.redirectUri === redirectUri);
    return client ? client.clientId : null;
  }

  // Records the client the given cloud issued; false when it stored nothing. A session bound to one cloud takes nothing
  // from another.
  saveClient(redirectUri: string, clientId: string, issuedBy: string): boolean {
    const origin = normalOrigin(issuedBy);
    if (origin === null || (!this.options.followStoredOrigin && origin !== this.origin)) return false;
    this.db.transaction(() => {
      const others = this.clients().filter((entry) => entry.origin !== origin);
      this.write(CLIENT, [...others, { origin, redirectUri, clientId }].slice(-MAX_CLIENTS));
    }).immediate();
    return true;
  }

  // Drops the client registered with that cloud for this callback address, so that the next sign-in registers anew:
  // after a sign-out, or when the cloud no longer knows the client. Given a client id, only while it is still that one,
  // so a registration made meanwhile stays.
  forgetClient(redirectUri: string, origin: string, clientId?: string): void {
    const wanted = normalOrigin(origin);
    if (wanted === null) return;
    this.db.transaction(() => {
      const clients = this.clients();
      const kept = clients.filter((entry) =>
        entry.origin !== wanted || entry.redirectUri !== redirectUri || (clientId !== undefined && entry.clientId !== clientId));
      if (kept.length !== clients.length) this.write(CLIENT, kept);
    }).immediate();
  }

  signedIn(): boolean {
    return this.ownTokens() !== null;
  }

  // The keys of the cloud this session talks to, with that cloud's origin: send them there and nowhere else.
  async tokens(): Promise<IssuedCatalogTokens | null> {
    const stored = this.ownTokens();
    if (!stored) return null;
    const tokens = await this.unseal(stored.credentialSetId);
    return tokens ? { origin: stored.origin, ...tokens } : null;
  }

  // Keys are recorded only while the cloud that issued them is still the one this session talks to; false when they
  // were not. An answer that arrives after another process signed in to a different cloud is dropped, so it does not
  // end up under another cloud's name. This does not look at sign-outs: it never tells that keys were erased since the
  // sign-in began, so the caller has to refuse an answer that a sign-out overtook (CatalogOAuth.finish does).
  saveTokens(tokens: CatalogTokens, issuedBy: string): boolean {
    const origin = normalOrigin(issuedBy);
    if (origin === null) return false;
    const saved = this.db.transaction(() => {
      if (origin !== this.origin) return false;
      // The keys of an earlier sign-in go first.
      this.eraseTokens();
      this.seal(tokens, origin);
      return true;
    }).immediate();
    flushErasedData(this.db);
    return saved;
  }

  // Swaps keys read earlier for their successors, or erases them when there are none, but only while the stored keys
  // are still those very keys of that cloud; false when nothing changed. A refresh answer that arrives after the
  // person signed out, or after another request already stored newer keys, must not replace what is there now.
  async replaceTokens(expectedRefreshToken: string, next: CatalogTokens | null, issuedBy: string): Promise<boolean> {
    const origin = normalOrigin(issuedBy);
    const seen = this.read(TOKENS, TokensSchema);
    if (origin === null || seen?.origin !== origin || origin !== this.origin) return false;
    // Reading the vault is asynchronous, so the comparison cannot sit inside the write transaction. Every save seals
    // the keys under a new credential set, so finding the same set there still means finding the keys compared here.
    if ((await this.unseal(seen.credentialSetId))?.refreshToken !== expectedRefreshToken) return false;
    const replaced = this.db.transaction(() => {
      const current = this.read(TOKENS, TokensSchema);
      if (current?.credentialSetId !== seen.credentialSetId || current.origin !== origin || origin !== this.origin) return false;
      this.eraseTokens();
      if (next) this.seal(next, origin);
      return true;
    }).immediate();
    flushErasedData(this.db);
    return replaced;
  }

  // Erases the stored keys. Given a cloud, only keys that cloud issued: a refusal from one cloud must not erase a newer
  // sign-in to another.
  clearTokens(expectedOrigin?: string): void {
    this.db.transaction(() => {
      if (expectedOrigin !== undefined) {
        const stored = this.read(TOKENS, TokensSchema);
        if (!stored || stored.origin !== normalOrigin(expectedOrigin)) return;
      }
      this.eraseTokens();
    }).immediate();
    flushErasedData(this.db);
  }

  private clients(): z.infer<typeof ClientsSchema> {
    return this.read(CLIENT, ClientsSchema) ?? [];
  }

  private ownTokens(): z.infer<typeof TokensSchema> | null {
    const stored = this.read(TOKENS, TokensSchema);
    return stored && stored.origin === this.origin ? stored : null;
  }

  private seal(tokens: CatalogTokens, origin: string): void {
    const credentialSetId = randomUUID();
    const fields: Record<string, string> = { access_token: tokens.accessToken };
    if (tokens.refreshToken !== null) fields.refresh_token = tokens.refreshToken;
    this.vault.storeFields(credentialSetId, fields);
    this.write(TOKENS, { origin, credentialSetId });
  }

  private async unseal(credentialSetId: string): Promise<CatalogTokens | null> {
    try {
      return await this.vault.withCredentials(credentialSetId, async (fields) => {
        const accessToken = fields.access_token;
        if (!accessToken) return null;
        return { accessToken, refreshToken: fields.refresh_token ?? null };
      });
    } catch {
      return null;
    }
  }

  private eraseTokens(): void {
    const stored = this.read(TOKENS, TokensSchema);
    if (stored) this.db.prepare("delete from credential_sets where id = ?").run(stored.credentialSetId);
    this.db.prepare("delete from app_settings where key = ?").run(TOKENS);
  }

  private read<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db.prepare("select value_json from app_settings where key = ?").get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(row.value_json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    this.db.prepare(
      `insert into app_settings (key, value_json, updated_at) values (?, ?, ?)
       on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(value), this.now().toISOString());
  }
}
