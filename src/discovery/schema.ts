import { z } from "zod";

import { HttpsOriginSchema } from "../adapters/schema.js";

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const EvidenceKindSchema = z.enum([
  "openapi_server",
  "openapi_security",
  "http_example",
  "repeated_url",
  "prose_label",
  "registry_adapter",
  "model_proposal",
]);
export const CredentialKindSchema = z.enum([
  "api_key",
  "client_id",
  "bearer_token",
  "static_header",
]);

const HttpsDocumentationUrlSchema = z.string().url().max(2_000).superRefine((value, context) => {
  if (new URL(value).protocol !== "https:") {
    context.addIssue({ code: "custom", message: "evidence page URL must use HTTPS" });
  }
});

export const DiscoveryEvidenceSchema = z.object({
  pageUrl: HttpsDocumentationUrlSchema,
  kind: EvidenceKindSchema,
  pointer: z.string().min(1).max(500).optional(),
  excerpt: z.string().min(1).max(240).optional(),
}).strict();

const CandidateIdSchema = z.string().min(8).max(80).regex(/^[a-z0-9-]+$/u);

export const ApiOriginCandidateSchema = z.object({
  id: CandidateIdSchema,
  origin: HttpsOriginSchema,
  serviceLabel: z.string().min(1).max(120).nullable(),
  confidence: ConfidenceSchema,
  evidence: z.array(DiscoveryEvidenceSchema).min(1).max(5),
  observationCount: z.number().int().min(1).max(1_000),
}).strict();

export const CredentialCandidateSchema = z.object({
  id: CandidateIdSchema,
  fieldName: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/u),
  kind: CredentialKindSchema,
  placement: z.literal("header"),
  humanLabel: z.string().min(1).max(120),
  confidence: ConfidenceSchema,
  evidence: z.array(DiscoveryEvidenceSchema).min(1).max(5),
}).strict();

export const DiscoveryResultSchema = z.object({
  serviceName: z.string().min(1).max(200).nullable(),
  suggestedLabel: z.string().min(1).max(200).nullable(),
  origins: z.array(ApiOriginCandidateSchema).max(40),
  credentials: z.array(CredentialCandidateSchema).max(20),
  unsupportedAuthMethods: z.array(z.string().min(1).max(120)).max(20),
}).strict();

export type DiscoveryEvidence = z.infer<typeof DiscoveryEvidenceSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type CredentialKind = z.infer<typeof CredentialKindSchema>;
export type ApiOriginCandidate = z.infer<typeof ApiOriginCandidateSchema>;
export type CredentialCandidate = z.infer<typeof CredentialCandidateSchema>;
export type DiscoveryResult = z.infer<typeof DiscoveryResultSchema>;

export function emptyDiscoveryResult(): DiscoveryResult {
  return {
    serviceName: null,
    suggestedLabel: null,
    origins: [],
    credentials: [],
    unsupportedAuthMethods: [],
  };
}

export const ProvenanceSummarySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("documents"),
    documents: z.array(z.object({
      url: z.string().max(2_000),
      kind: z.enum(["html", "openapi", "postman", "text"]),
      provenance: z.enum(["official", "third_party", "model_content"]),
      fetchedAt: z.string().max(40),
      sha256: z.string().length(64),
    }).strict()).max(40),
    discardedOrigins: z.array(z.object({
      origin: z.string().max(300),
      reason: z.literal("outside_link_domain"),
    }).strict()).max(40),
  }).strict(),
  z.object({
    kind: z.literal("registry"),
    adapterId: z.string().uuid(),
    adapterSlug: z.string().min(1).max(100),
    adapterVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("model_settings"),
    rationale: z.string().max(1_000),
  }).strict(),
  z.object({
    kind: z.literal("catalog"),
    entryId: z.string().min(1).max(100),
    version: z.number().int().positive(),
  }).strict(),
]);

export type ProvenanceSummary = z.infer<typeof ProvenanceSummarySchema>;
