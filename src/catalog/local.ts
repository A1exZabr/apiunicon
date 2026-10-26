import type Database from "better-sqlite3";

import type { FetchImplementation, HostResolver } from "../security/network-policy.js";
import type { Vault } from "../vault/vault.js";
import { HttpCatalogSource } from "./http-source.js";
import { CatalogOAuth } from "./oauth.js";
import { CatalogSession } from "./session.js";

// The local version's link to the shared catalog: what it remembers and how it signs in.
export type LocalCatalog = {
  // The cloud this computer talks to now (session.origin): the one it is signed in to, or the one a sign-in starts with.
  readonly origin: string;
  // The local page that starts signing in, shown to the person by the AI.
  signInUrl: string;
  session: CatalogSession;
  oauth: CatalogOAuth;
  // The shared catalog, asked with the keys of this sign-in.
  source: HttpCatalogSource;
};

export function createLocalCatalog(input: {
  db: Database.Database;
  vault: Vault;
  // The configured address: APIUNICON_CATALOG_ORIGIN, or the language default.
  origin: string;
  // True when the address is only the language default: the cloud that issued the stored keys then wins.
  followStoredOrigin: boolean;
  // http://127.0.0.1:<port>
  baseUrl: string;
  resolver: HostResolver;
  fetchImpl: FetchImplementation;
}): LocalCatalog {
  const session = new CatalogSession(input.db, input.vault, input.origin, undefined, {
    followStoredOrigin: input.followStoredOrigin,
  });
  const oauth = new CatalogOAuth({
    session,
    callbackUrl: `${input.baseUrl}/catalog/callback`,
    resolver: input.resolver,
    fetchImpl: input.fetchImpl,
  });
  const signInUrl = `${input.baseUrl}/catalog/connect`;
  const source = new HttpCatalogSource({ session, oauth, signInUrl, resolver: input.resolver, fetchImpl: input.fetchImpl });
  return {
    get origin() {
      return session.origin;
    },
    signInUrl,
    session,
    oauth,
    source,
  };
}
