import { anchorHrefs } from "./anchors.js";

// Endpoints that frameworks serve specs from without a file extension (Springdoc and Springfox).
const SPEC_ENDPOINTS = ["/v3/api-docs", "/v2/api-docs"];

// Only file-like paths and well-known endpoints count. Documentation sites keep ordinary pages under
// paths such as /docs/openapi/, and following those would fill the document budget with HTML.
function looksLikeSpec(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const pathname = new URL(raw, "https://placeholder.invalid/").pathname.toLocaleLowerCase("en-US");
    return /\.(?:ya?ml|json)$/u.test(pathname) || SPEC_ENDPOINTS.some((endpoint) => pathname.endsWith(endpoint));
  } catch {
    return false;
  }
}

export function extractSpecLinks(html: string, pageUrl: string, limit = 30): string[] {
  const found = new Set<string>();
  const add = (raw: string | undefined): void => {
    if (!raw || found.size >= limit) return;
    try {
      const url = new URL(raw.replaceAll("&amp;", "&"), pageUrl);
      if (url.protocol !== "https:") return;
      url.hash = "";
      found.add(url.toString());
    } catch {
      // Ignore malformed links in untrusted documentation.
    }
  };
  for (const match of html.matchAll(/\bspec-url\s*=\s*["']([^"']+)["']/giu)) add(match[1]);
  for (const match of html.matchAll(/\burl\s*:\s*["']([^"']+)["']/giu)) {
    if (looksLikeSpec(match[1])) add(match[1]);
  }
  for (const href of anchorHrefs(html)) {
    if (looksLikeSpec(href)) add(href);
  }
  return [...found];
}
