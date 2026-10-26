import { z } from "zod";

import { effectiveRisk } from "../adapters/risk.js";
import { AdapterDslSchema, type AdapterOperation } from "../adapters/schema.js";
import { registrableDomain, sameRegistrableDomain } from "../discovery/domain.js";
import { discoveryFromAdapter } from "../discovery/registry.js";
import type { CatalogEntry } from "./source.js";

export const EntryIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/u);
// Catalog text reaches the AI, so it is kept short; a longer text is cut rather than refused.
const DescriptionSchema = z.string().max(20_000).transform((value) => value.slice(0, 1_000));

// As many as an adapter may have operations.
const MAX_OPERATION_CHECKS = 200;

const HttpsUrlSchema = z.string().url().max(2_000).refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, { message: "documentation URL must use HTTPS" });

export const CatalogEntrySchema = z.object({
  entryId: EntryIdSchema,
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(200),
  description: DescriptionSchema,
  domain: z.string().min(1).max(253),
  dsl: AdapterDslSchema,
  operationChecks: z.record(z.string().min(1).max(100), z.enum(["verified", "needs_token_rights"]))
    .refine((checks) => Object.keys(checks).length <= MAX_OPERATION_CHECKS, { message: "too many operation checks" }),
  documentation: z.array(z.object({
    url: HttpsUrlSchema,
    sha256: z.string().length(64).nullable(),
  })).max(100),
});

export const CatalogCandidateSchema = z.object({
  entryId: EntryIdSchema,
  displayName: z.string().trim().min(1).max(200),
  description: DescriptionSchema,
  operations: z.number().int().min(0).max(1_000),
});

// What the cloud answers on its lookup address: a lookup without sign_in, which only the local version produces.
export const CatalogAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry"), entry: CatalogEntrySchema }),
  z.object({ kind: z.literal("candidates"), candidates: z.array(CatalogCandidateSchema).max(20) }),
  z.object({ kind: z.literal("none"), reason: z.enum(["not_found", "unavailable", "limited"]) }),
]);

// A character the person can see. Not: white space and separators; controls, format characters, lone surrogates,
// private-use and unassigned code points; combining marks, which need a character before them; the default-ignorable
// characters, among them the Hangul fillers (U+3164 shows as nothing) and variation selectors; and the blank Braille
// pattern U+2800, which is a symbol that draws nothing.
const VISIBLE = /[^\p{White_Space}\p{Z}\p{C}\p{M}\p{Default_Ignorable_Code_Point}\u2800]/u;

// What is wrong with one operation of a catalog entry, or null. An entry with any such operation is refused whole.
// The catalog may publish operations that change data, but never one whose label hides what it does:
// - get_not_read: a GET is a read, and nothing may send one that writes;
// - delete_not_destructive: a DELETE is always a deletion, so it carries the "destructive" label;
// - read_unsafe_method: the runtime lets a "read" run without asking, and its effective risk makes a "read" PUT, PATCH
//   or DELETE a change, so a "read" label on one would let a catalog author act with the person's key. The rule is the
//   runtime's own effectiveRisk, so the two cannot drift apart. POST stays allowed as a read: some services
//   (Wildberries, Ozon) read through POST;
// - undescribed_write_input: the person confirms a change by reading its values on a page, and each value is named by
//   its input's description, so a change with an unnamed value is not shown whole. A description of blanks names nothing.
export type CatalogOperationProblem = "get_not_read" | "delete_not_destructive" | "read_unsafe_method" | "undescribed_write_input";

export function catalogOperationProblem(operation: AdapterOperation): CatalogOperationProblem | null {
  if (operation.method === "GET" && operation.risk !== "read") return "get_not_read";
  if (operation.method === "DELETE" && operation.risk !== "destructive") return "delete_not_destructive";
  if (operation.risk === "read" && effectiveRisk(operation) !== "read") return "read_unsafe_method";
  if (operation.risk !== "read" && Object.values(operation.input).some(({ description }) => !VISIBLE.test(description ?? ""))) {
    return "undescribed_write_input";
  }
  return null;
}

// A catalog entry is used for a link only when the core's own schemas accept it, it is the entry for the link's
// registrable domain, and every destination lies on that domain: keys must never be offered to another service.
export function validateCatalogEntry(value: unknown, documentationUrl: string): CatalogEntry | null {
  const parsed = CatalogEntrySchema.safeParse(value);
  if (!parsed.success) return null;
  const entry: CatalogEntry = parsed.data;
  const domain = registrableDomain(documentationUrl);
  if (domain === null || entry.domain.toLocaleLowerCase("en-US") !== domain) return null;
  const onLinkDomain = (origin: string) => sameRegistrableDomain(origin, documentationUrl);
  if (!entry.dsl.baseOrigins.every(onLinkDomain)) return null;
  // The adapter schema already keeps each operation on a base origin; the check is repeated here so that this
  // function alone vouches for every address a copied adapter can call.
  if (!entry.dsl.operations.every((operation) => operation.origin === undefined || onLinkDomain(operation.origin))) return null;
  // Without key fields there is nothing to enter, and key entry is where the person approves the destinations.
  if (entry.dsl.credentialBindings.length === 0) return null;
  // Operations that change data may come from the catalog; they run only after the person confirms each change, and
  // only on a connection whose switch for changing data the person turned on. A mislabelled one refuses the entry whole.
  if (entry.dsl.operations.some((operation) => catalogOperationProblem(operation) !== null)) return null;
  const operationIds = new Set(entry.dsl.operations.map(({ id }) => id));
  if (!Object.keys(entry.operationChecks).every((id) => operationIds.has(id))) return null;
  // startFromCatalog builds the draft from this very call inside its transaction. An entry it cannot describe falls
  // back to the documentation here instead of failing start_connection there, whatever the reason it throws.
  try {
    discoveryFromAdapter({ slug: "catalog", displayName: entry.displayName, version: entry.version, dsl: entry.dsl }, documentationUrl);
  } catch {
    return null;
  }
  return { ...entry, domain };
}

// What a lookup tells the catalog about the link: its address without the query and the fragment, which can carry the
// person's own tokens or session ids. Null when it is not an address.
export function catalogLookupUrl(documentationUrl: string): string | null {
  try {
    const url = new URL(documentationUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

// "Wildberries Statistics" -> "wildberries-statistics"; a name without Latin letters falls back to the domain.
export function catalogSlug(entry: Pick<CatalogEntry, "displayName" | "domain">): string {
  const slugify = (value: string) =>
    value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-").slice(0, 80).replace(/^-+|-+$/gu, "");
  return slugify(entry.displayName) || slugify(entry.domain) || "catalog-adapter";
}
