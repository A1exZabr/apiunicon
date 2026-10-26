import { createHash } from "node:crypto";

import type { FetchedDocumentationPage } from "../docs/crawler.js";
import { removeHiddenElements, stripTags } from "../docs/html.js";
import { parseMachineDocument, type ParsedSpec } from "../docs/spec.js";
import { assertPublicHttpsOriginLiteral } from "../security/network-policy.js";
import {
  type ApiOriginCandidate,
  type Confidence,
  type CredentialCandidate,
  type CredentialKind,
  type DiscoveryEvidence,
  type DiscoveryResult,
  DiscoveryResultSchema,
} from "./schema.js";

type OriginObservation = {
  origin: string;
  serviceLabel: string | null;
  evidence: DiscoveryEvidence[];
  pages: Set<string>;
  authoritative: boolean;
  sandbox: boolean;
};

type CredentialObservation = {
  fieldName: string;
  kind: CredentialKind;
  evidence: DiscoveryEvidence[];
  pages: Set<string>;
  authoritative: boolean;
};

const MAX_SCAN_LENGTH = 16_000;
const MAX_CANDIDATES = 20;
const MAX_ORIGIN_CANDIDATES = 40;
const MAX_EVIDENCE = 5;
// Limits of the discovery schema. Values come from untrusted documents, so they are cut to fit instead of
// letting one long value fail the whole result.
const MAX_LABEL_CHARS = 120;
const MAX_EXCERPT_CHARS = 240;
const MAX_PAGE_URL_CHARS = 2_000;
const MAX_OBSERVATIONS = 1_000;

const IGNORED_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "user-agent",
]);

export function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value.toLocaleLowerCase()).digest("hex").slice(0, 16)}`;
}

// An API address found in documentation becomes a candidate only if it passes the same check as an approved origin:
// HTTPS, a public host, no private or reserved address literal. The origin drops a user and password, so a link that
// carries them is refused before it is reduced to its origin.
function safeHttpsOrigin(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (url.username !== "" || url.password !== "") return null;
    return assertPublicHttpsOriginLiteral(url.origin);
  } catch {
    return null;
  }
}

// Evidence cites the page URL, so a page whose URL the schema cannot store contributes nothing.
function isCitablePageUrl(pageUrl: string): boolean {
  if (pageUrl.length > MAX_PAGE_URL_CHARS) return false;
  try {
    return new URL(pageUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeLabel(title: string): string | null {
  const normalized = title.replace(/\s+/gu, " ").trim();
  if (normalized === "") return null;
  const withoutApi = normalized.replace(/\s+API$/iu, "").trim();
  return withoutApi === "" ? normalized.slice(0, 200) : withoutApi.slice(0, 200);
}

export function credentialKind(fieldName: string, bearer = false): CredentialKind {
  const normalized = fieldName.toLocaleLowerCase();
  if (bearer || normalized === "authorization") return "bearer_token";
  if (normalized.includes("client") && normalized.includes("id")) return "client_id";
  if (normalized.includes("key") || normalized.includes("token")) return "api_key";
  return "static_header";
}

export function credentialLabel(kind: CredentialKind, fieldName: string): string {
  if (kind === "api_key") return "API key";
  if (kind === "client_id") return "Client ID";
  if (kind === "bearer_token") return "Bearer token";
  return fieldName;
}

function cleanHtml(value: string): string {
  return stripTags(removeHiddenElements(value))
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

// Like value.replace(/[),.;]+$/u, ""), which retries from every character of a long run and is quadratic.
function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && "),.;".includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function confidence(authoritative: boolean, observations: number): Confidence {
  if (authoritative || observations >= 2) return "high";
  return "medium";
}

export class DiscoveryCollector {
  private serviceName: string | null = null;
  private suggestedLabel: string | null = null;
  private readonly origins = new Map<string, OriginObservation>();
  private readonly credentials = new Map<string, CredentialObservation>();
  private readonly unsupportedAuthMethods = new Set<string>();

  observe(page: FetchedDocumentationPage): void {
    if (!isCitablePageUrl(page.url)) return;
    const spec = parseMachineDocument(page.body);
    if (spec) {
      this.observeSpec(spec, page.url);
      return;
    }
    this.observeText(page);
  }

  // For a page already known not to be a machine-readable spec, so that its body is not parsed again.
  observeText(page: FetchedDocumentationPage): void {
    if (!isCitablePageUrl(page.url)) return;
    this.observeHttpExamples({ ...page, body: page.body.slice(0, MAX_SCAN_LENGTH) });
  }

  observeSpec(spec: ParsedSpec, pageUrl: string): void {
    if (!isCitablePageUrl(pageUrl)) return;
    if (spec.title) {
      this.serviceName ??= spec.title.replace(/\s+/gu, " ").trim().slice(0, 200);
      this.suggestedLabel ??= normalizeLabel(spec.title);
    }
    for (const server of spec.servers) {
      const origin = safeHttpsOrigin(server.url, pageUrl);
      if (!origin) continue;
      this.addOrigin(origin, pageUrl, {
        pageUrl,
        kind: "openapi_server",
        pointer: server.pointer.slice(0, 500),
      }, true, /sandbox/iu.test(server.description ?? ""));
    }
    for (const scheme of spec.securitySchemes) {
      if (scheme.type === "oauth2") {
        this.unsupportedAuthMethods.add("OAuth 2.0");
        continue;
      }
      if (scheme.type === "openIdConnect") {
        this.unsupportedAuthMethods.add("OpenID Connect");
        continue;
      }
      const evidence: DiscoveryEvidence = { pageUrl, kind: "openapi_security", pointer: scheme.pointer.slice(0, 500) };
      if (scheme.type === "apiKey" && scheme.in === "header" && scheme.name) {
        const kind = scheme.name.toLocaleLowerCase("en-US") === "authorization" ? "api_key" : credentialKind(scheme.name);
        this.addCredential(scheme.name, kind, pageUrl, evidence, true);
      } else if (scheme.type === "http" && scheme.scheme?.toLocaleLowerCase("en-US") === "bearer") {
        this.addCredential("Authorization", "bearer_token", pageUrl, evidence, true);
      }
    }
  }

  result(): DiscoveryResult {
    const origins: ApiOriginCandidate[] = [...this.origins.values()]
      .slice(0, MAX_ORIGIN_CANDIDATES)
      .map((candidate) => ({
        id: stableId("origin", candidate.origin),
        origin: candidate.origin,
        serviceLabel: candidate.sandbox ? "Sandbox" : candidate.serviceLabel,
        confidence: candidate.sandbox ? "low" : confidence(candidate.authoritative, candidate.pages.size),
        evidence: candidate.evidence,
        observationCount: Math.min(candidate.pages.size, MAX_OBSERVATIONS),
      }));
    const credentials: CredentialCandidate[] = [...this.credentials.values()]
      .slice(0, MAX_CANDIDATES)
      .map((candidate) => ({
        id: stableId("credential", candidate.fieldName),
        fieldName: candidate.fieldName,
        kind: candidate.kind,
        placement: "header",
        humanLabel: credentialLabel(candidate.kind, candidate.fieldName),
        confidence: confidence(candidate.authoritative, candidate.pages.size),
        evidence: candidate.evidence,
      }));

    return DiscoveryResultSchema.parse({
      serviceName: this.serviceName,
      suggestedLabel: this.suggestedLabel,
      origins,
      credentials,
      unsupportedAuthMethods: [...this.unsupportedAuthMethods].slice(0, MAX_CANDIDATES),
    });
  }

  private observeHttpExamples(page: FetchedDocumentationPage): void {
    const text = page.contentType.toLocaleLowerCase().includes("html") ? cleanHtml(page.body) : page.body;
    const urlPattern = /https?:\/\/[^\s'"<>]+/giu;
    for (const match of text.matchAll(urlPattern)) {
      const rawUrl = trimTrailingPunctuation(match[0]);
      const index = match.index ?? 0;
      const context = text.slice(Math.max(0, index - 300), Math.min(text.length, index + rawUrl.length + 300));
      if (!/(?:\bcurl\b|\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+https?:\/\/|\bbase\s+url\b)/iu.test(context)) {
        continue;
      }
      const origin = safeHttpsOrigin(rawUrl, page.url);
      if (!origin) continue;
      this.addOrigin(origin, page.url, {
        pageUrl: page.url,
        kind: "http_example",
        excerpt: origin.slice(0, MAX_EXCERPT_CHARS),
      }, false);

      const headerPattern = /(?:-H|--header)?\s*["']?([A-Za-z][A-Za-z0-9-]{0,99})\s*:\s*([^\s"']+(?:\s+[^\s"']+)*)["']?/giu;
      for (const headerMatch of context.matchAll(headerPattern)) {
        const fieldName = headerMatch[1];
        const value = headerMatch[2] ?? "";
        if (!fieldName || IGNORED_HEADERS.has(fieldName.toLocaleLowerCase())) continue;
        const normalizedName = fieldName.toLocaleLowerCase();
        const recognized = normalizedName === "authorization" || normalizedName.includes("key") ||
          (normalizedName.includes("client") && normalizedName.includes("id")) || normalizedName.startsWith("x-");
        if (!recognized) continue;
        const bearer = normalizedName === "authorization" && /^bearer\b/iu.test(value);
        this.addCredential(fieldName, credentialKind(fieldName, bearer), page.url, {
          pageUrl: page.url,
          kind: "http_example",
          excerpt: `${fieldName}: [value]`,
        }, false);
      }
    }
  }

  private addOrigin(
    origin: string,
    pageUrl: string,
    evidence: DiscoveryEvidence,
    authoritative: boolean,
    sandboxHint = false,
  ): void {
    const sandbox = sandboxHint || /sandbox/iu.test(origin);
    const existing = this.origins.get(origin);
    if (existing) {
      existing.pages.add(pageUrl);
      existing.authoritative ||= authoritative;
      existing.sandbox ||= sandbox;
      if (existing.evidence.length < MAX_EVIDENCE && !existing.evidence.some((item) => item.pageUrl === pageUrl && item.kind === evidence.kind)) {
        existing.evidence.push(evidence);
      }
      return;
    }
    if (this.origins.size >= MAX_ORIGIN_CANDIDATES) return;
    this.origins.set(origin, {
      origin,
      serviceLabel: this.suggestedLabel?.slice(0, MAX_LABEL_CHARS) ?? null,
      evidence: [evidence],
      pages: new Set([pageUrl]),
      authoritative,
      sandbox,
    });
  }

  private addCredential(
    fieldName: string,
    kind: CredentialKind,
    pageUrl: string,
    evidence: DiscoveryEvidence,
    authoritative: boolean,
  ): void {
    if (!/^[A-Za-z0-9-]{1,100}$/u.test(fieldName)) return;
    const key = fieldName.toLocaleLowerCase();
    const existing = this.credentials.get(key);
    if (existing) {
      existing.pages.add(pageUrl);
      existing.authoritative ||= authoritative;
      if (existing.evidence.length < MAX_EVIDENCE && !existing.evidence.some((item) => item.pageUrl === pageUrl && item.kind === evidence.kind)) {
        existing.evidence.push(evidence);
      }
      return;
    }
    if (this.credentials.size >= MAX_CANDIDATES) return;
    this.credentials.set(key, {
      fieldName,
      kind,
      evidence: [evidence],
      pages: new Set([pageUrl]),
      authoritative,
    });
  }
}
