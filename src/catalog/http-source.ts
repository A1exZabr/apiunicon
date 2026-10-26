import { guardedFetch, type FetchImplementation, type HostResolver } from "../security/network-policy.js";
import { CatalogAnswerSchema, CatalogEntrySchema, catalogLookupUrl, EntryIdSchema } from "./entry.js";
import { CatalogUnavailableError, type CatalogOAuth } from "./oauth.js";
import type { CatalogSession, IssuedCatalogTokens } from "./session.js";
import type { CatalogLookup, CatalogSource } from "./source.js";

export const CATALOG_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export type HttpCatalogSourceOptions = {
  session: CatalogSession;
  oauth: Pick<CatalogOAuth, "refresh">;
  signInUrl: string;
  resolver: HostResolver;
  fetchImpl: FetchImplementation;
  timeoutMs?: number;
};

function none(reason: "not_found" | "unavailable" | "limited"): CatalogLookup {
  return { kind: "none", reason };
}

// The local version's catalog: the cloud's catalog addresses, asked with this computer's catalog key. Any failure is an
// answer the core can work with, so connecting never stops because of the catalog.
//
// The key goes to the cloud that issued it and nowhere else: every request is built from the origin that came with the
// key, never from the session's current address, which can change while a request is in flight.
export class HttpCatalogSource implements CatalogSource {
  constructor(private readonly options: HttpCatalogSourceOptions) {}

  lookup(documentationUrl: string): Promise<CatalogLookup> {
    const url = catalogLookupUrl(documentationUrl);
    if (url === null) return Promise.resolve(none("not_found"));
    return this.ask(`/api/catalog/v1/lookup?${new URLSearchParams({ url }).toString()}`, "lookup");
  }

  entry(entryId: string): Promise<CatalogLookup> {
    // An id the catalog could never have issued is not sent anywhere: it could also be a dot segment that leaves the path.
    if (!EntryIdSchema.safeParse(entryId).success) return Promise.resolve(none("not_found"));
    return this.ask(`/api/catalog/v1/entries/${entryId}`, "entry");
  }

  private async ask(path: string, kind: "lookup" | "entry"): Promise<CatalogLookup> {
    const { session, signInUrl } = this.options;
    const signIn: CatalogLookup = { kind: "sign_in", url: signInUrl };
    // The person chose to build connections from documentation; the catalog is not mentioned again.
    if (session.disabled()) return none("not_found");
    try {
      const held = await session.tokens();
      if (!held) return signIn;
      let response = await this.get(path, held);
      if (response.status === 401) {
        // One new key per request. Without one the sign-in is over: refresh() has erased the keys the cloud refused.
        const fresh = await this.newerKeys(held);
        if (!fresh) return signIn;
        response = await this.get(path, fresh);
        if (response.status === 401) {
          // A key the cloud refuses even when new means the sign-in has ended.
          await this.forget(fresh);
          return signIn;
        }
      }
      return await this.answerOf(response, kind);
    } catch (error) {
      // A rate limit on the key refresh counts like one on the request itself.
      return error instanceof CatalogUnavailableError && error.status === 429 ? none("limited") : none("unavailable");
    }
  }

  // Keys that replaced the refused ones meanwhile (another request already refreshed, or another process signed in) are
  // used as they are: refreshing again would only rotate a key that was just issued. Otherwise the cloud issues new ones.
  private async newerKeys(refused: IssuedCatalogTokens): Promise<IssuedCatalogTokens | null> {
    const stored = await this.options.session.tokens();
    if (stored && (stored.origin !== refused.origin || stored.accessToken !== refused.accessToken)) return stored;
    return this.options.oauth.refresh();
  }

  // Erases exactly these keys: keys stored since, by this or another process, are not theirs to lose.
  private async forget(keys: IssuedCatalogTokens): Promise<void> {
    const { session } = this.options;
    if (keys.refreshToken === null) session.clearTokens(keys.origin);
    else await session.replaceTokens(keys.refreshToken, null, keys.origin);
  }

  private async answerOf(response: Response, kind: "lookup" | "entry"): Promise<CatalogLookup> {
    if (response.status === 429) return none("limited");
    if (response.status === 404) return none("not_found");
    if (!response.ok) return none("unavailable");
    const body: unknown = await response.json();
    if (kind === "entry") {
      const entry = CatalogEntrySchema.safeParse(body);
      return entry.success ? { kind: "entry", entry: entry.data } : none("unavailable");
    }
    // The cloud's answer never asks for a sign-in: only this computer knows whether it has signed in.
    const answer = CatalogAnswerSchema.safeParse(body);
    return answer.success ? answer.data : none("unavailable");
  }

  private get(path: string, keys: IssuedCatalogTokens): Promise<Response> {
    return guardedFetch(new URL(path, keys.origin), {
      method: "GET",
      headers: { authorization: `Bearer ${keys.accessToken}`, accept: "application/json" },
    }, {
      allowedOrigins: [keys.origin],
      resolver: this.options.resolver,
      fetchImpl: this.options.fetchImpl,
      timeoutMs: this.options.timeoutMs ?? CATALOG_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
  }
}
