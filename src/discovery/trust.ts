import type { DocumentRecord } from "../docs/documents.js";
import { sameRegistrableDomain, serviceNameFromDomain } from "./domain.js";
import {
  type ApiOriginCandidate,
  type CredentialCandidate,
  DiscoveryResultSchema,
  type DiscoveryResult,
} from "./schema.js";

export type DiscardedOrigin = { origin: string; reason: "outside_link_domain" };

const RANK = { low: 0, medium: 1, high: 2 } as const;

// Copies and AI-supplied text can propose a destination but never vouch for it, so on their own they cannot
// make it high confidence.
function trustedConfidence(candidate: ApiOriginCandidate, provenance: DocumentRecord["provenance"]): ApiOriginCandidate {
  return provenance !== "official" && candidate.confidence === "high" ? { ...candidate, confidence: "medium" } : candidate;
}

export function mergeTrustedDiscovery(
  linkUrl: string,
  documents: ReadonlyArray<Pick<DocumentRecord, "provenance" | "discovery">>,
): { result: DiscoveryResult; discardedOrigins: DiscardedOrigin[] } {
  const origins = new Map<string, ApiOriginCandidate>();
  const credentials = new Map<string, CredentialCandidate>();
  const unsupported = new Set<string>();
  const discarded = new Set<string>();
  const serviceNames = new Set<string>();
  const labels = new Set<string>();
  for (const document of documents) {
    if (document.discovery.serviceName) serviceNames.add(document.discovery.serviceName);
    if (document.discovery.suggestedLabel) labels.add(document.discovery.suggestedLabel);
    for (const found of document.discovery.origins) {
      if (document.provenance !== "official" && !sameRegistrableDomain(found.origin, linkUrl)) {
        discarded.add(found.origin);
        continue;
      }
      const candidate = trustedConfidence(found, document.provenance);
      const existing = origins.get(candidate.origin);
      if (!existing) {
        origins.set(candidate.origin, candidate);
        continue;
      }
      origins.set(candidate.origin, {
        ...existing,
        confidence: RANK[candidate.confidence] > RANK[existing.confidence] ? candidate.confidence : existing.confidence,
        serviceLabel: existing.serviceLabel ?? candidate.serviceLabel,
        evidence: [...existing.evidence, ...candidate.evidence].slice(0, 5),
        observationCount: Math.min(existing.observationCount + candidate.observationCount, 1_000),
      });
    }
    for (const candidate of document.discovery.credentials) {
      const key = candidate.fieldName.toLocaleLowerCase("en-US");
      const existing = credentials.get(key);
      if (!existing || RANK[candidate.confidence] > RANK[existing.confidence]) credentials.set(key, candidate);
    }
    // Only official documentation can say that the service itself requires an unsupported method. A copy or
    // AI-supplied text must not be able to stop a connection.
    if (document.provenance === "official") {
      for (const method of document.discovery.unsupportedAuthMethods) unsupported.add(method);
    }
  }
  for (const origin of origins.keys()) discarded.delete(origin);
  // A service split into several files titles each file by its section ("General", "Items"), so no single title
  // names the service; the link's domain does.
  const domainName = serviceNameFromDomain(linkUrl);
  const pick = (names: Set<string>) => (names.size > 1 && domainName ? domainName : [...names][0] ?? null);
  return {
    result: DiscoveryResultSchema.parse({
      serviceName: pick(serviceNames),
      suggestedLabel: pick(labels),
      origins: [...origins.values()].slice(0, 40),
      credentials: [...credentials.values()].slice(0, 20),
      unsupportedAuthMethods: [...unsupported].slice(0, 20),
    }),
    discardedOrigins: [...discarded].slice(0, 40).map((origin) => ({ origin, reason: "outside_link_domain" })),
  };
}

// Every destination on the documentation link's own domain is preselected, however sure the documents are of it and
// whoever named it: the key goes to the service that issued it either way, and a person who is not technical should not
// have to tick the service's own hosts one by one. A destination on another domain, which only official documentation
// can name, is never preselected: the person ticks it knowingly.
export function isPreselectedOrigin(candidate: ApiOriginCandidate, linkUrl: string): boolean {
  return sameRegistrableDomain(candidate.origin, linkUrl);
}
