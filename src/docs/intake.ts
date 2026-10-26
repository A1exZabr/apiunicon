import { createHash } from "node:crypto";

import type { DocumentationSourceRecord } from "../connections/repository.js";
import { DiscoveryCollector } from "../discovery/collector.js";
import { sameRegistrableDomain } from "../discovery/domain.js";
import {
  guardedFetch,
  ResponseByteLimitError,
  type FetchImplementation,
  type HostResolver,
} from "../security/network-policy.js";
import { unlimitedUsage, UsageLimitError, type UsageGate } from "../usage/gate.js";
import { chunkSpec } from "./chunking.js";
import { splitIntoChunks } from "./crawler.js";
import {
  DOCUMENT_LIMITS,
  DocumentLimitError,
  type DocumentKind,
  type DocumentProvenance,
  type DocumentRepository,
} from "./documents.js";
import type { DocumentationChunkInput } from "./repository.js";
import { extractSpecLinks } from "./spec-links.js";
import { parseMachineDocument } from "./spec.js";

export const DEFAULT_MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_CONTENT_PART_CHARS = 100_000;
const MAX_CONTENT_PARTS = 60;
const MAX_URLS_PER_CALL = 30;
// Discovery evidence stores the page URL and the schema caps it, so longer URLs cannot be stored.
const MAX_URL_LENGTH = 2_000;
const MIN_HTML_TEXT_CHARS = 200;
const PART_TTL_MS = 30 * 60_000;

export type AttachOutcome = "attached" | "duplicate" | "blocked" | "rejected";
export type AttachResult = {
  url: string;
  outcome: AttachOutcome;
  documentId?: string;
  kind?: DocumentKind;
  provenance?: DocumentProvenance;
  reason?: string;
};
export type ContentMediaType = "openapi-yaml" | "openapi-json" | "postman-json" | "html" | "markdown" | "text";
export type ContentPart = {
  sourceUrl: string;
  mediaType: ContentMediaType;
  partIndex: number;
  partCount: number;
  text: string;
};
export type ContentPartResult =
  | { complete: false; received: number; expected: number }
  | { complete: true; result: AttachResult };

export type DocumentationIntakeDependencies = {
  documents: DocumentRepository;
  resolver: HostResolver;
  fetchImpl: FetchImplementation;
  timeoutMs: number;
  maxDocumentBytes: number;
  usage?: UsageGate;
};

// Documents, discovery evidence, and chunks keep the URL, and secret values must never reach them,
// so a URL with a username or password (userinfo) is never accepted.
function isStorableHttpsUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// admitted is the gate's answer for the whole document, shared by every part that arrives while it is pending.
type PendingParts = {
  parts: Array<string | undefined>;
  mediaType: ContentMediaType;
  createdAt: number;
  admitted: Promise<boolean>;
};

// How one fetched document may be stored. A spec link found in a page is only worth storing when it is a
// machine-readable spec, and documents the crawl stores itself leave room for the ones the AI attaches.
type StorePolicy = { specOnly: boolean; maxDocuments: number };
const REQUESTED: StorePolicy = { specOnly: false, maxDocuments: DOCUMENT_LIMITS.maxDocuments };
const FOLLOW_UP: StorePolicy = { specOnly: true, maxDocuments: DOCUMENT_LIMITS.maxDocuments };
const CRAWL_FOLLOW_UP: StorePolicy = { specOnly: true, maxDocuments: DOCUMENT_LIMITS.maxCrawlDocuments };

export class DocumentationIntake {
  private readonly pendingParts = new Map<string, PendingParts>();

  private readonly usage: UsageGate;

  constructor(private readonly dependencies: DocumentationIntakeDependencies) {
    this.usage = dependencies.usage ?? unlimitedUsage;
  }

  async attachUrls(source: DocumentationSourceRecord, urls: readonly string[]): Promise<AttachResult[]> {
    const requested = [...new Set(urls)].slice(0, MAX_URLS_PER_CALL);
    const followUps: string[] = [];
    const results: AttachResult[] = [];
    for (const url of requested) results.push(await this.attachOne(source, url, REQUESTED, followUps));
    const extra = [...new Set(followUps)].filter((url) => !requested.includes(url));
    for (const url of extra.slice(0, MAX_URLS_PER_CALL - requested.length)) {
      results.push(await this.attachOne(source, url, FOLLOW_UP, []));
    }
    return results;
  }

  // Spec links the crawl found in documentation pages.
  async attachCrawlSpecLinks(source: DocumentationSourceRecord, urls: readonly string[]): Promise<AttachResult[]> {
    const results: AttachResult[] = [];
    for (const url of [...new Set(urls)].slice(0, MAX_URLS_PER_CALL)) {
      results.push(await this.attachOne(source, url, CRAWL_FOLLOW_UP, []));
    }
    return results;
  }

  async attachContentPart(source: DocumentationSourceRecord, draftId: string, part: ContentPart): Promise<ContentPartResult> {
    if (!isStorableHttpsUrl(part.sourceUrl)) {
      throw new Error(`sourceUrl must be an HTTPS URL of at most ${MAX_URL_LENGTH} characters, without a username or password`);
    }
    if (part.text.length > MAX_CONTENT_PART_CHARS) throw new Error(`Each part may contain at most ${MAX_CONTENT_PART_CHARS} characters`);
    if (!Number.isInteger(part.partCount) || part.partCount < 1 || part.partCount > MAX_CONTENT_PARTS ||
      !Number.isInteger(part.partIndex) || part.partIndex < 0 || part.partIndex >= part.partCount) {
      throw new Error("Invalid part numbering");
    }
    this.expireParts();
    const key = `${draftId}\n${part.sourceUrl}`;
    let pending = this.pendingParts.get(key);
    if (!pending || pending.parts.length !== part.partCount || pending.mediaType !== part.mediaType) {
      pending = {
        parts: Array.from({ length: part.partCount }, () => undefined),
        mediaType: part.mediaType,
        createdAt: Date.now(),
        admitted: this.admit(),
      };
      this.pendingParts.set(key, pending);
    }
    // Parts may arrive in parallel calls, so the part that completes the document claims it before any await.
    pending.parts[part.partIndex] = part.text;
    const received = pending.parts.filter((value) => value !== undefined).length;
    const complete = received === part.partCount;
    if (complete) this.pendingParts.delete(key);
    let admitted: boolean;
    try {
      admitted = await pending.admitted;
    } catch (error) {
      this.dropPending(key, pending);
      throw error;
    }
    if (!admitted) {
      this.dropPending(key, pending);
      return { complete: true, result: { url: part.sourceUrl, outcome: "rejected", reason: "daily_limit" } };
    }
    if (!complete) return { complete: false, received, expected: part.partCount };
    const body = pending.parts.join("");
    const bytes = Buffer.byteLength(body);
    const result: AttachResult = bytes > this.dependencies.maxDocumentBytes
      ? { url: part.sourceUrl, outcome: "rejected", reason: "too_large" }
      : this.store(source, {
        url: part.sourceUrl,
        body,
        contentType: part.mediaType === "html" ? "text/html" : "text/plain",
        provenance: "model_content",
        mediaType: part.mediaType,
      }, REQUESTED, []);
    // Text over the limit is rejected; like a download cut off at the limit, it costs at most the limit.
    await this.usage.afterDocumentation(Math.min(bytes, this.dependencies.maxDocumentBytes));
    return { complete: true, result };
  }

  // False when the host refuses for now; any other failure of the gate propagates.
  private async admit(): Promise<boolean> {
    try {
      await this.usage.beforeDocumentation();
      return true;
    } catch (error) {
      if (error instanceof UsageLimitError) return false;
      throw error;
    }
  }

  private dropPending(key: string, pending: PendingParts): void {
    if (this.pendingParts.get(key) === pending) this.pendingParts.delete(key);
  }

  private async attachOne(
    source: DocumentationSourceRecord,
    url: string,
    policy: StorePolicy,
    followUps: string[],
  ): Promise<AttachResult> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { url, outcome: "rejected", reason: "invalid_url" };
    }
    // The echoed URL never carries the credentials the caller sent.
    const hadCredentials = target.username !== "" || target.password !== "";
    target.username = "";
    target.password = "";
    target.hash = "";
    if (hadCredentials || target.toString().length > MAX_URL_LENGTH) {
      return { url: target.toString().slice(0, MAX_URL_LENGTH), outcome: "rejected", reason: "invalid_url" };
    }
    if (!(await this.admit())) return { url: target.toString(), outcome: "rejected", reason: "daily_limit" };
    let response: Response;
    try {
      response = await guardedFetch(target, {
        method: "GET",
        headers: { accept: "application/json, application/yaml, text/yaml, text/html;q=0.8, */*;q=0.5" },
      }, {
        allowedOrigins: [target.origin],
        resolver: this.dependencies.resolver,
        fetchImpl: this.dependencies.fetchImpl,
        timeoutMs: this.dependencies.timeoutMs,
        maxResponseBytes: this.dependencies.maxDocumentBytes,
      });
    } catch (error) {
      if (error instanceof ResponseByteLimitError) {
        // The body was read up to the limit before the download was cut off.
        await this.usage.afterDocumentation(this.dependencies.maxDocumentBytes);
        return { url: target.toString(), outcome: "rejected", reason: "too_large" };
      }
      return { url: target.toString(), outcome: "blocked", reason: "unreachable" };
    }
    if (response.status !== 200) return { url: target.toString(), outcome: "blocked", reason: `http_${response.status}` };
    const body = await response.arrayBuffer();
    // Charged for what was downloaded, whether or not the document is stored below.
    await this.usage.afterDocumentation(body.byteLength);
    const provenance: DocumentProvenance = sameRegistrableDomain(target.toString(), source.rootUrl) ? "official" : "third_party";
    return this.store(source, {
      url: target.toString(),
      body: new TextDecoder().decode(body),
      contentType: response.headers.get("content-type") ?? "",
      provenance,
    }, policy, followUps);
  }

  // One document that cannot be read or stored is rejected on its own, so it never aborts the rest of a batch.
  private store(
    source: DocumentationSourceRecord,
    input: { url: string; body: string; contentType: string; provenance: DocumentProvenance; mediaType?: ContentMediaType },
    policy: StorePolicy,
    followUps: string[],
  ): AttachResult {
    try {
      return this.storeDocument(source, input, policy, followUps);
    } catch (error) {
      if (error instanceof DocumentLimitError) return { url: input.url, outcome: "rejected", reason: "limit_reached" };
      return { url: input.url, outcome: "rejected", reason: "invalid_document" };
    }
  }

  private storeDocument(
    source: DocumentationSourceRecord,
    input: { url: string; body: string; contentType: string; provenance: DocumentProvenance; mediaType?: ContentMediaType },
    policy: StorePolicy,
    followUps: string[],
  ): AttachResult {
    const collector = new DiscoveryCollector();
    const spec = parseMachineDocument(input.body);
    let kind: DocumentKind;
    let chunks: DocumentationChunkInput[];
    if (spec) {
      kind = spec.format === "postman" ? "postman" : "openapi";
      collector.observeSpec(spec, input.url);
      chunks = chunkSpec(spec, input.url);
    } else {
      if (policy.specOnly || input.mediaType === "openapi-yaml" || input.mediaType === "openapi-json" ||
        input.mediaType === "postman-json") {
        return { url: input.url, outcome: "rejected", reason: "not_a_specification" };
      }
      const isHtml = input.mediaType === "html" || input.contentType.toLocaleLowerCase("en-US").includes("html") ||
        /^\s*<(?:!doctype|html)/iu.test(input.body);
      kind = isHtml ? "html" : "text";
      const page = { url: input.url, contentType: isHtml ? "text/html" : "text/plain", body: input.body };
      chunks = splitIntoChunks(page).chunks;
      const textLength = chunks.reduce((total, chunk) => total + chunk.body.length, 0);
      if (isHtml && textLength < MIN_HTML_TEXT_CHARS) {
        return { url: input.url, outcome: "blocked", reason: "empty_or_challenge_page" };
      }
      collector.observeText(page);
      if (isHtml) followUps.push(...extractSpecLinks(input.body, input.url));
    }
    const { document, duplicate } = this.dependencies.documents.add({
      sourceId: source.id,
      url: input.url,
      kind,
      provenance: input.provenance,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      byteSize: Buffer.byteLength(input.body),
      discovery: collector.result(),
      chunks,
    }, policy.maxDocuments);
    // A duplicate describes the document already stored, whose url, kind, and provenance may differ
    // from this input. The stored provenance is never upgraded.
    return {
      url: document.url,
      outcome: duplicate ? "duplicate" : "attached",
      documentId: document.id,
      kind: document.kind,
      provenance: document.provenance,
    };
  }

  private expireParts(): void {
    const cutoff = Date.now() - PART_TTL_MS;
    for (const [key, pending] of this.pendingParts) {
      if (pending.createdAt < cutoff) this.pendingParts.delete(key);
    }
  }
}
