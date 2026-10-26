import { createHash, randomUUID } from "node:crypto";

import type { DocumentationSourceRecord } from "../connections/repository.js";
import { UsageLimitError } from "../usage/gate.js";
import { anchorHrefs } from "./anchors.js";
import { firstHeadingHtml, removeHiddenElements, stripTags } from "./html.js";
import { type DocumentationChunkInput, type DocsRepository } from "./repository.js";

// A page's text is stored in chunks of at most this many characters; read_docs returns one chunk.
const PAGE_CHUNK_CHARS = 8_000;

export type FetchedDocumentationPage = {
  url: string;
  contentType: string;
  body: string;
};

export type DocumentationCrawlerDependencies = {
  maxPages: number;
  fetchPage: (url: string) => Promise<FetchedDocumentationPage>;
  repository: DocsRepository;
  observePage?: (page: FetchedDocumentationPage) => void;
};

export type CrawlResult = {
  pageCount: number;
  chunkCount: number;
  contentFingerprint: string;
  byteSize: number;
};

function decodeEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractHtml(html: string, pageUrl: string): {
  heading: string;
  text: string;
  links: string[];
} {
  const headingHtml = firstHeadingHtml(html);
  const text = decodeEntities(stripTags(removeHiddenElements(html))).replace(/\s+/gu, " ").trim();
  const heading = headingHtml === null
    ? new URL(pageUrl).pathname
    : decodeEntities(stripTags(headingHtml)).replace(/\s+/gu, " ").trim();
  const links: string[] = [];
  for (const href of anchorHrefs(html)) {
    try {
      links.push(new URL(href, pageUrl).toString());
    } catch {
      // Ignore malformed documentation links.
    }
  }
  return { heading, text, links };
}

export function splitIntoChunks(page: FetchedDocumentationPage): {
  chunks: DocumentationChunkInput[];
  links: string[];
} {
  const isHtml = page.contentType.toLocaleLowerCase().includes("html");
  const extracted = isHtml
    ? extractHtml(page.body, page.url)
    : { heading: new URL(page.url).pathname, text: page.body.replace(/\s+/gu, " ").trim(), links: [] };
  const chunks: DocumentationChunkInput[] = [];
  for (let offset = 0; offset < extracted.text.length; offset += PAGE_CHUNK_CHARS) {
    const body = extracted.text.slice(offset, offset + PAGE_CHUNK_CHARS);
    const contentHash = createHash("sha256").update(body).digest("hex");
    chunks.push({
      id: randomUUID(),
      pageUrl: page.url,
      heading: extracted.heading,
      body,
      contentHash,
    });
  }
  return { chunks, links: extracted.links };
}

export async function crawlDocumentation(
  source: DocumentationSourceRecord,
  dependencies: DocumentationCrawlerDependencies,
): Promise<CrawlResult> {
  dependencies.repository.markCrawling(source.id);
  const queue = [source.rootUrl];
  const queued = new Set(queue);
  const chunks: DocumentationChunkInput[] = [];
  let pageCount = 0;
  let byteSize = 0;

  try {
    while (queue.length > 0 && pageCount < dependencies.maxPages) {
      const url = queue.shift();
      if (!url) break;
      let page: FetchedDocumentationPage;
      try {
        page = await dependencies.fetchPage(url);
      } catch (error) {
        // A page that cannot be read is skipped, but a usage refusal ends the crawl instead of skipping every page.
        if (url === source.rootUrl || error instanceof UsageLimitError) throw error;
        continue;
      }
      byteSize += Buffer.byteLength(page.body);
      const finalUrl = new URL(page.url);
      if (finalUrl.origin !== source.allowedOrigin) {
        throw new Error("Documentation fetch escaped the approved origin");
      }
      dependencies.observePage?.(page);
      pageCount += 1;
      const extracted = splitIntoChunks(page);
      chunks.push(...extracted.chunks);
      for (const link of extracted.links) {
        const candidate = new URL(link);
        candidate.hash = "";
        if (candidate.origin !== source.allowedOrigin) continue;
        const normalized = candidate.toString();
        if (queued.has(normalized)) continue;
        queued.add(normalized);
        queue.push(normalized);
      }
    }
    const uniqueChunks = [...new Map(chunks.map((chunk) => [chunk.contentHash, chunk])).values()];
    const contentFingerprint = createHash("sha256")
      .update(uniqueChunks.map(({ contentHash }) => contentHash).sort().join("\n"))
      .digest("hex");
    dependencies.repository.replaceSourceChunks(source.id, uniqueChunks, contentFingerprint);
    return { pageCount, chunkCount: uniqueChunks.length, contentFingerprint, byteSize };
  } catch (error) {
    dependencies.repository.markFailed(source.id, "crawl");
    throw error;
  }
}
