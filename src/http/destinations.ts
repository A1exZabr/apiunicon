import type { ConnectionDraftRecord } from "../discovery/repository.js";
import { isPreselectedOrigin } from "../discovery/trust.js";
import { escapeHtml } from "./layout.js";

// The step where the person picks the API addresses a connection may send requests to, the same on the one-time
// key-entry page and on the workspace's own setup page. An address on the documentation link's domain starts selected;
// one on another domain, which only official documentation can name, starts unselected (see isPreselectedOrigin).
// label names an address whose documentation gives it no name of its own.
export function destinationChoices(draft: ConnectionDraftRecord, linkUrl: string, label: string): string {
  return draft.discovery.origins.map((candidate) =>
    `<label class="choice-card"><input type="checkbox" name="originId" value="${escapeHtml(candidate.id)}"${isPreselectedOrigin(candidate, linkUrl) ? " checked" : ""}><span><strong>${escapeHtml(candidate.serviceLabel ?? label)}</strong><small class="domain">${escapeHtml(new URL(candidate.origin).host)}</small></span></label>`).join("");
}
