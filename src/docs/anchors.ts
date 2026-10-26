const ANCHOR_OPEN = /<a\b/giu;
const HREF = /\bhref\s*=\s*["']([^"']+)["']/iu;

// Returns the href of each anchor tag in document order. A tag is scanned once, up to its closing ">"
// (or the end of the document), and openings inside that tag are covered by it. Hostile markup such as
// "<a <a <a ..." therefore costs linear time instead of rescanning the same text for every opening.
export function anchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  let tagEnd = -1;
  let close = -1;
  for (const match of html.matchAll(ANCHOR_OPEN)) {
    const start = match.index;
    if (start < tagEnd) continue;
    if (close < start) {
      const next = html.indexOf(">", start);
      close = next === -1 ? html.length : next;
    }
    tagEnd = close;
    const href = HREF.exec(html.slice(start, close))?.[1];
    if (href) hrefs.push(href);
  }
  return hrefs;
}
