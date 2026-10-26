import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

import { guardedFetch, type FetchImplementation, type HostResolver } from "../security/network-policy.js";
import type { CatalogSession, IssuedCatalogTokens } from "./session.js";

export const CATALOG_SCOPE = "catalog";
// How long a sign-in that was started waits for the cloud's answer.
export const CATALOG_SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

const RegistrationSchema = z.object({ client_id: z.string().min(1).max(500) });
const OAuthErrorSchema = z.object({ error: z.string().regex(/^[\x21-\x7e]{1,100}$/u) });
const TokenSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  refresh_token: z.string().min(1).max(8_192).optional(),
});

// The cloud answered and refused: a wrong code or verifier, a used or revoked refresh key, an unknown client. The
// OAuth error code, when the answer has one, tells which; it stays out of the message.
export class CatalogRefusedError extends Error {
  constructor(readonly status: number, readonly error: string | null = null) {
    super(`The catalog refused the request with HTTP ${status}`);
    this.name = "CatalogRefusedError";
  }
}

// What signing out did in the cloud: it confirmed the revocation, it was asked and refused (the key then expires there
// on its own), it was asked and did not confirm (no answer, or a busy or failing cloud; the key expires there on its
// own too), or it was not asked at all (this computer held no keys of that cloud, or no client to revoke them as).
export type CatalogSignOut = "revoked" | "refused" | "not_answered" | "not_asked";

// The cloud could not serve the request for now (a 5xx, a timeout or a rate limit). Unlike a refusal it costs nobody
// their keys; the status tells a rate limit from an outage.
export class CatalogUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`The catalog answered HTTP ${status}`);
    this.name = "CatalogUnavailableError";
  }
}

export class CatalogSignInExpiredError extends Error {
  constructor() {
    super("The catalog sign-in has expired or was already used");
    this.name = "CatalogSignInExpiredError";
  }
}

// The cloud this computer talks to changed while the person was signing in (another process signed in or out), so
// the keys of this sign-in are not kept.
export class CatalogSignInInterruptedError extends Error {
  constructor() {
    super("The catalog sign-in did not complete because this computer's catalog changed meanwhile");
    this.name = "CatalogSignInInterruptedError";
  }
}

export type CatalogOAuthOptions = {
  session: CatalogSession;
  // http://127.0.0.1:<port>/catalog/callback
  callbackUrl: string;
  resolver: HostResolver;
  fetchImpl: FetchImplementation;
  now?: () => number;
};

type PendingSignIn = { origin: string; verifier: string; clientId: string; expiresAt: number };

function resourceOf(origin: string): string {
  return `${origin}/catalog`;
}

// The error code of an OAuth refusal, such as invalid_client; null when the answer has none.
async function oauthError(response: Response): Promise<string | null> {
  try {
    const parsed = OAuthErrorSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

// The local version signs in to the cloud's catalog as a public OAuth client: it registers once per cloud, uses PKCE
// for every sign-in, and keeps the verifier and state in this process only.
//
// The session's origin can change while a request is in flight, so it only picks the cloud for a new sign-in. Keys
// already stored are sent to the cloud that issued them, and every answer is recorded under the cloud that gave it.
export class CatalogOAuth {
  private readonly pending = new Map<string, PendingSignIn>();
  private readonly registrations = new Map<string, Promise<string>>();
  private readonly refreshes = new Map<string, Promise<IssuedCatalogTokens | null>>();
  // How many times this process has signed out of each cloud. A sign-in that began before a sign-out is over.
  private readonly signOuts = new Map<string, number>();

  constructor(private readonly options: CatalogOAuthOptions) {}

  // Where to send the person's browser to sign in.
  async start(): Promise<string> {
    // One cloud for the whole sign-in, whatever the session says by the time the person comes back.
    const origin = this.options.session.origin;
    const clientId = await this.clientId(origin);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    this.prune();
    // Opening the sign-in address over and over must not grow the map without end.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(state, { origin, verifier, clientId, expiresAt: this.now() + CATALOG_SIGN_IN_TTL_MS });
    const url = new URL("/oauth/authorize", origin);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: this.options.callbackUrl,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: resourceOf(origin),
      scope: CATALOG_SCOPE,
      state,
      // The person sees what this computer asks for every time, even when a cloud session would let it pass silently.
      prompt: "consent",
    }).toString();
    return url.toString();
  }

  async finish(code: string, state: string): Promise<void> {
    this.prune();
    const pending = this.pending.get(state);
    // A state answers once.
    this.pending.delete(state);
    if (!pending) throw new CatalogSignInExpiredError();
    const { session } = this.options;
    // Keys from this cloud would not be kept any more, so the cloud is not asked to issue them.
    if (session.origin !== pending.origin) throw new CatalogSignInInterruptedError();
    const signedOutBefore = this.signOutsOf(pending.origin);
    let response: Response;
    try {
      response = await this.post(pending.origin, "/oauth/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: this.options.callbackUrl,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
        resource: resourceOf(pending.origin),
      });
    } catch (error) {
      this.forgetUnknownClient(error, pending.origin, pending.clientId);
      throw error;
    }
    const answer = TokenSchema.parse(await response.json());
    // The person signed out while the cloud was answering: the keys are not kept, as the sign-out must stand. Nothing
    // may yield between this check and saving.
    if (this.signOutsOf(pending.origin) !== signedOutBefore) throw new CatalogSignInInterruptedError();
    const saved = session.saveTokens({ accessToken: answer.access_token, refreshToken: answer.refresh_token ?? null }, pending.origin);
    if (!saved) throw new CatalogSignInInterruptedError();
    // The keys can be refreshed and revoked only as the client they were issued to, which a sign-out or a refusal may
    // have dropped while the person was on the cloud's page.
    if (session.clientId(this.options.callbackUrl, pending.origin) === null) {
      session.saveClient(this.options.callbackUrl, pending.clientId, pending.origin);
    }
    // Signing in is a choice to use the catalog.
    session.setDisabled(false);
  }

  forget(state: string): void {
    this.pending.delete(state);
  }

  // The keys to retry with: the refreshed ones, or newer keys of the same cloud that another request stored meanwhile.
  // Null when there is nothing to refresh with, the person signed out meanwhile, or the cloud refused; refused keys
  // never work again, so they are erased unless newer keys replaced them. A network failure or a busy cloud throws
  // instead (a CatalogUnavailableError when the cloud answered) and keeps the keys, so a passing outage does not cost
  // the person their sign-in.
  async refresh(): Promise<IssuedCatalogTokens | null> {
    const current = await this.options.session.tokens();
    if (!current?.refreshToken) return null;
    const { origin, refreshToken } = current;
    // Requests refused at the same moment share one refresh. The cloud rotates refresh keys, so a second request with
    // the same key would be refused, and refusing a refresh key erases it.
    const key = JSON.stringify([origin, refreshToken]);
    let running = this.refreshes.get(key);
    if (!running) {
      running = this.refreshKeys(origin, refreshToken).finally(() => this.refreshes.delete(key));
      this.refreshes.set(key, running);
    }
    return running;
  }

  // The keys are erased on this computer whatever the cloud answers. The client goes too: a cloud that has forgotten
  // it would otherwise refuse every later sign-in, and signing in again registers a new one. Sign-ins begun with this
  // cloud end as well: one that has not come back is forgotten, and one whose code is being exchanged keeps no keys
  // (finish checks the count of sign-outs), since they would be issued to a client that is forgotten and would undo
  // this sign-out. That happens before the cloud is asked, so an answer that arrives during the revocation finds
  // nothing either. Another cloud's client and sign-ins stay.
  async signOut(): Promise<CatalogSignOut> {
    const { session, callbackUrl } = this.options;
    // Before anything yields: reading the keys is asynchronous.
    const named = session.origin;
    this.endSignIns(named);
    const current = await session.tokens();
    const origin = current?.origin ?? session.origin;
    if (origin !== named) this.endSignIns(origin);
    const clientId = current ? session.clientId(callbackUrl, current.origin) : null;
    let result: CatalogSignOut = "not_asked";
    if (current && clientId) {
      try {
        if (current.refreshToken !== null) {
          await this.post(current.origin, "/oauth/revoke", { token: current.refreshToken, token_type_hint: "refresh_token", client_id: clientId });
        }
        await this.post(current.origin, "/oauth/revoke", { token: current.accessToken, token_type_hint: "access_token", client_id: clientId });
        result = "revoked";
      } catch (error) {
        result = error instanceof CatalogRefusedError ? "refused" : "not_answered";
      }
    }
    session.clearTokens();
    session.forgetClient(callbackUrl, origin);
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async refreshKeys(origin: string, refreshToken: string): Promise<IssuedCatalogTokens | null> {
    const { session, callbackUrl } = this.options;
    const clientId = session.clientId(callbackUrl, origin);
    if (!clientId) return null;
    let response: Response;
    try {
      response = await this.post(origin, "/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: resourceOf(origin),
      });
    } catch (error) {
      if (!(error instanceof CatalogRefusedError)) throw error;
      this.forgetUnknownClient(error, origin, clientId);
      await session.replaceTokens(refreshToken, null, origin);
      return this.storedKeysOf(origin);
    }
    const answer = TokenSchema.parse(await response.json());
    // A cloud that does not rotate refresh keys answers without one; the stored one stays good then.
    const next = { accessToken: answer.access_token, refreshToken: answer.refresh_token ?? refreshToken };
    if (await session.replaceTokens(refreshToken, next, origin)) return { origin, ...next };
    return this.storedKeysOf(origin);
  }

  private async storedKeysOf(origin: string): Promise<IssuedCatalogTokens | null> {
    const stored = await this.options.session.tokens();
    return stored?.origin === origin ? stored : null;
  }

  // A cloud that answers invalid_client no longer knows this computer's client (its registrations were reset, say).
  // Asking again as that client could never work, so the next sign-in registers a new one.
  private forgetUnknownClient(error: unknown, origin: string, clientId: string): void {
    if (!(error instanceof CatalogRefusedError) || (error.status !== 400 && error.status !== 401)) return;
    if (error.error === "invalid_client") this.options.session.forgetClient(this.options.callbackUrl, origin, clientId);
  }

  private clientId(origin: string): Promise<string> {
    const known = this.options.session.clientId(this.options.callbackUrl, origin);
    if (known) return Promise.resolve(known);
    // Sign-ins opened at once share one registration: keys issued to a client that was not kept could not be
    // refreshed or revoked later.
    let registration = this.registrations.get(origin);
    if (!registration) {
      registration = this.register(origin).finally(() => this.registrations.delete(origin));
      this.registrations.set(origin, registration);
    }
    return registration;
  }

  private async register(origin: string): Promise<string> {
    const response = await this.send(origin, "/oauth/register", "application/json", JSON.stringify({
      client_name: "APIUniCon on a computer",
      redirect_uris: [this.options.callbackUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }));
    const { client_id: clientId } = RegistrationSchema.parse(await response.json());
    this.options.session.saveClient(this.options.callbackUrl, clientId, origin);
    return clientId;
  }

  private post(origin: string, path: string, form: Record<string, string>): Promise<Response> {
    return this.send(origin, path, "application/x-www-form-urlencoded", new URLSearchParams(form).toString());
  }

  private async send(origin: string, path: string, contentType: string, body: string): Promise<Response> {
    const response = await guardedFetch(new URL(path, origin), {
      method: "POST",
      headers: { "content-type": contentType, accept: "application/json" },
      body,
    }, {
      allowedOrigins: [origin],
      resolver: this.options.resolver,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    // A timeout or a rate limit passes; only a real refusal may cost the person their keys.
    const passing = response.status === 408 || response.status === 429;
    if (response.status >= 400 && response.status < 500 && !passing) throw new CatalogRefusedError(response.status, await oauthError(response));
    if (!response.ok) throw new CatalogUnavailableError(response.status);
    return response;
  }

  private signOutsOf(origin: string): number {
    return this.signOuts.get(origin) ?? 0;
  }

  // Forgets the sign-ins begun with that cloud and counts a sign-out, which ends any whose code exchange is under way.
  private endSignIns(origin: string): void {
    this.signOuts.set(origin, this.signOutsOf(origin) + 1);
    for (const [state, pending] of this.pending) {
      if (pending.origin === origin) this.pending.delete(state);
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}
