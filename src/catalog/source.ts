import type { AdapterDsl } from "../adapters/schema.js";

// Where ready-made adapters come from. The cloud reads its own database; the local version asks the cloud over HTTPS.
// Whatever a source returns is data from outside, and the core checks it before using it.
export type CatalogOperationCheck = "verified" | "needs_token_rights";

export type CatalogEntry = {
  entryId: string;
  version: number;
  displayName: string;
  description: string;
  // The registrable domain, for example allegro.pl.
  domain: string;
  // Already without the operations dropped on publication.
  dsl: AdapterDsl;
  operationChecks: Record<string, CatalogOperationCheck>;
  documentation: Array<{ url: string; sha256: string | null }>;
};

export type CatalogCandidate = { entryId: string; displayName: string; description: string; operations: number };

export type CatalogLookup =
  | { kind: "entry"; entry: CatalogEntry }
  | { kind: "candidates"; candidates: CatalogCandidate[] }
  | { kind: "none"; reason: "not_found" | "unavailable" | "limited" }
  // Only the local version, before it has signed in to the catalog.
  | { kind: "sign_in"; url: string };

export interface CatalogSource {
  lookup(documentationUrl: string): Promise<CatalogLookup>;
  // Answers "entry" or "none".
  entry(entryId: string): Promise<CatalogLookup>;
}
