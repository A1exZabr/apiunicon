// Linear scanners for untrusted HTML. Patterns such as /<[^>]+>/ restart a scan to the end of the document
// from every unclosed "<", which is quadratic; these scanners only move forward. Each one gives the same
// result as the regular expression named in its comment.

const HIDDEN_ELEMENTS = ["script", "style", "noscript"] as const;

// Replaces each <name ...>...</name> element with a space, like /<name\b[^>]*>[\s\S]*?<\/name>/giu.
// An opening tag without a later ">" or closing tag stays in place.
function removeElements(html: string, name: string): string {
  const opening = new RegExp(`<${name}\\b`, "giu");
  const closing = new RegExp(`</${name}>`, "giu");
  let result = "";
  let position = 0;
  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    // A later opening tag ends at the same ">" or a later one, and its closing tag must come later still,
    // so once either is missing no later element can be complete.
    const tagEnd = html.indexOf(">", match.index);
    if (tagEnd === -1) break;
    closing.lastIndex = tagEnd + 1;
    const close = closing.exec(html);
    if (!close) break;
    result += `${html.slice(position, match.index)} `;
    position = close.index + close[0].length;
    opening.lastIndex = position;
  }
  return result + html.slice(position);
}

export function removeHiddenElements(html: string): string {
  return HIDDEN_ELEMENTS.reduce(removeElements, html);
}

// Replaces each tag with a space, like /<[^>]+>/gu.
export function stripTags(html: string): string {
  let result = "";
  let position = 0;
  let open = html.indexOf("<");
  while (open !== -1) {
    const close = html.indexOf(">", open + 1);
    // Without a later ">" no "<" from here on starts a tag.
    if (close === -1) break;
    if (close === open + 1) {
      // "<>" is text.
      open = html.indexOf("<", open + 1);
      continue;
    }
    result += `${html.slice(position, open)} `;
    position = close + 1;
    open = html.indexOf("<", position);
  }
  return result + html.slice(position);
}

// The inner HTML of the first h1-h3 element, like /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/iu.
export function firstHeadingHtml(html: string): string | null {
  const open = /<h[1-3]/iu.exec(html);
  if (!open) return null;
  // As in removeElements, only the first opening tag can start a match.
  const tagEnd = html.indexOf(">", open.index);
  if (tagEnd === -1) return null;
  const closing = /<\/h[1-3]>/giu;
  closing.lastIndex = tagEnd + 1;
  const close = closing.exec(html);
  return close ? html.slice(tagEnd + 1, close.index) : null;
}
