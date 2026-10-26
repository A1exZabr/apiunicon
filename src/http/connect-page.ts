import type { FastifyInstance, FastifyRequest } from "fastify";

import { KEY_ENTRY_LINK_TTL_MS } from "../discovery/links.js";
import type { ConnectionDraftRecord } from "../discovery/repository.js";
import { stageFor } from "../discovery/stage.js";
import { translate, type Locale, type MessageKey } from "../i18n/messages.js";
import type { Application } from "../index.js";
import { destinationChoices } from "./destinations.js";
import { first, parseForm, values } from "./forms.js";
import { escapeHtml } from "./layout.js";
import { linkFormToken, linkCookie, linkToken, messagePage, sendPage, SIGNED_IN_TO_REPLACE_KEYS, type OneTimePageOptions } from "./one-time.js";

const COOKIE = "apiunicon_connect";
const PURPOSE = "connect";

function provenanceHtml(locale: Locale, draft: ConnectionDraftRecord): string {
  const summary = draft.provenanceSummary;
  if (!summary) return "";
  if (summary.kind === "registry") {
    return `<p class="muted">${escapeHtml(translate(locale, "provenance.registry", { slug: summary.adapterSlug, version: summary.adapterVersion }))}</p>`;
  }
  if (summary.kind === "model_settings") {
    return `<p class="warning">${escapeHtml(translate(locale, "provenance.modelSettings"))}</p>`;
  }
  if (summary.kind === "catalog") {
    return `<p class="muted">${escapeHtml(translate(locale, "provenance.catalog", { version: summary.version }))}</p>`;
  }
  const labels = { official: "provenance.official", third_party: "provenance.thirdParty", model_content: "provenance.modelContent" } as const;
  const items = summary.documents.map((document) =>
    `<li>${escapeHtml(translate(locale, labels[document.provenance]))}: <span class="domain">${escapeHtml(new URL(document.url).hostname)}</span>, ${escapeHtml(document.fetchedAt.slice(0, 10))}</li>`).join("");
  return `<h2 class="section-gap">${escapeHtml(translate(locale, "provenance.heading"))}</h2><ul>${items}</ul>`;
}

function renderForm(
  options: OneTimePageOptions,
  request: FastifyRequest,
  app: Application,
  draft: ConnectionDraftRecord,
  token: string,
  problemKey: MessageKey | null = null,
): string {
  const locale = options.locale(request);
  const source = app.connections.getDocumentationSource(draft.documentationSourceId);
  const title = draft.suggestedLabel ?? draft.serviceName ?? translate(locale, "keys.untitled");
  const reviewing = draft.status === "needs_review";
  const origins = reviewing
    ? destinationChoices(draft, source.rootUrl, title)
    : (draft.selectedOrigins ?? []).map((origin) => `<div class="row"><span class="domain">${escapeHtml(new URL(origin).host)}</span></div>`).join("");
  const credentials = reviewing ? draft.discovery.credentials : draft.selectedCredentials ?? [];
  const choose = reviewing && credentials.length > 1;
  const credentialInputs = credentials.map((credential) => {
    const selector = !reviewing
      ? ""
      : choose
        ? `<label class="choice-card"><input type="checkbox" name="credentialId" value="${escapeHtml(credential.id)}" checked><span>${escapeHtml(translate(locale, "keys.use", { label: credential.humanLabel }))}</span></label>`
        : `<input type="hidden" name="credentialId" value="${escapeHtml(credential.id)}">`;
    return `${selector}<label>${escapeHtml(credential.humanLabel)}<small class="technical-detail">${escapeHtml(credential.fieldName)}</small><input ${choose ? "" : "required "}type="password" autocomplete="off" spellcheck="false" name="credentialValue:${escapeHtml(credential.id)}"></label>`;
  }).join("");
  const problem = problemKey ? `<p class="warning">${escapeHtml(translate(locale, problemKey))}</p>` : "";
  return options.render(
    request,
    translate(locale, "keys.pageTitle"),
    `<span class="eyebrow">${escapeHtml(translate(locale, "keys.eyebrow"))}</span><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(translate(locale, "keys.lede"))}</p>${problem}<form method="post" action="/connect/${escapeHtml(draft.id)}/complete"><input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE, token))}"><section class="card"><h2>${escapeHtml(translate(locale, "keys.destinations"))}</h2><div class="choices">${origins}</div>${provenanceHtml(locale, draft)}<h2 class="section-gap">${escapeHtml(translate(locale, "keys.keys"))}</h2>${credentialInputs}<button type="submit">${escapeHtml(translate(locale, "keys.submit"))}</button></section></form>`,
  );
}

// The same one-time page, for a finished connection: destinations are fixed and only new key values are taken.
function renderReplaceForm(
  options: OneTimePageOptions,
  request: FastifyRequest,
  app: Application,
  draft: ConnectionDraftRecord,
  token: string,
  failed = false,
): string {
  const locale = options.locale(request);
  const connection = app.connections.getConnection(draft.completedConnectionId!);
  const labels = new Map((draft.selectedCredentials ?? []).map((credential) => [credential.fieldName, credential.humanLabel]));
  const destinations = connection.allowedOrigins
    .map((origin) => `<div class="row"><span class="domain">${escapeHtml(new URL(origin).host)}</span></div>`).join("");
  const inputs = connection.credentials.map(({ fieldName }) =>
    `<label>${escapeHtml(labels.get(fieldName) ?? fieldName)}<small class="technical-detail">${escapeHtml(fieldName)}</small><input required type="password" autocomplete="off" spellcheck="false" name="credentialValue:${escapeHtml(fieldName)}"></label>`).join("");
  const problem = failed ? `<p class="warning">${escapeHtml(translate(locale, "keys.error"))}</p>` : "";
  return options.render(
    request,
    translate(locale, "replace.pageTitle"),
    `<span class="eyebrow">${escapeHtml(translate(locale, "keys.eyebrow"))}</span><h1>${escapeHtml(translate(locale, "replace.heading", { label: connection.label }))}</h1><p class="lede">${escapeHtml(translate(locale, "replace.lede"))}</p>${problem}<form method="post" action="/connect/${escapeHtml(draft.id)}/complete"><input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE, token))}"><section class="card"><h2>${escapeHtml(translate(locale, "keys.destinations"))}</h2><div class="choices">${destinations}</div><h2 class="section-gap">${escapeHtml(translate(locale, "replace.keys"))}</h2>${inputs}<button type="submit">${escapeHtml(translate(locale, "replace.submit"))}</button></section></form>`,
  );
}

// A link to the key-entry page of a finished connection replaces its keys.
export function replacing(draft: ConnectionDraftRecord): boolean {
  return draft.status === "completed" && draft.completedConnectionId !== null;
}

export function registerConnectRoutes(server: FastifyInstance, options: OneTimePageOptions): void {
  const path = (draftId: string) => `/connect/${draftId}`;
  const expired = (request: FastifyRequest) => messagePage(options, request, "link.expired.title", "link.expired.text");
  const notFound = (request: FastifyRequest) => messagePage(options, request, "link.notFound.title", "link.notFound.text");

  server.get<{ Params: { id: string }; Querystring: { t?: string } }>("/connect/:id", SIGNED_IN_TO_REPLACE_KEYS, async (request, reply) => {
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const draftId = request.params.id;
    const queryToken = request.query.t;
    if (queryToken !== undefined) {
      if (!app.links.verify(draftId, queryToken)) return sendPage(reply, 403, expired(request));
      return reply
        .header("set-cookie", linkCookie(COOKIE, path(draftId), queryToken, KEY_ENTRY_LINK_TTL_MS / 1_000, options.secureCookies))
        .redirect(path(draftId), 303);
    }
    const token = linkToken(request, COOKIE);
    if (!app.links.verify(draftId, token)) return sendPage(reply, 403, expired(request));
    const draft = app.drafts.get(draftId);
    if (replacing(draft)) return sendPage(reply, 200, renderReplaceForm(options, request, app, draft, token));
    if (stageFor(draft) !== "waiting_for_keys") {
      return sendPage(reply, 409, messagePage(options, request, "keys.notReady.title", "keys.notReady.text"));
    }
    return sendPage(reply, 200, renderForm(options, request, app, draft, token));
  });

  server.post<{ Params: { id: string } }>("/connect/:id/complete", SIGNED_IN_TO_REPLACE_KEYS, async (request, reply) => {
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const draftId = request.params.id;
    const token = linkToken(request, COOKIE);
    const formBody = parseForm(request.body);
    if (!app.links.verify(draftId, token) || first(formBody, "csrf") !== linkFormToken(PURPOSE, token)) {
      return sendPage(reply, 403, expired(request));
    }
    const credentialValues: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(formBody)) {
      if (name.startsWith("credentialValue:") && typeof value === "string") {
        credentialValues[name.slice("credentialValue:".length)] = value;
      }
    }
    const current = app.drafts.get(draftId);
    const clearCookie = linkCookie(COOKIE, path(draftId), "", 0, options.secureCookies);
    if (replacing(current)) {
      try {
        app.discovery.replaceKeys(draftId, credentialValues);
      } catch {
        return sendPage(reply, 400, renderReplaceForm(options, request, app, current, token, true));
      }
      app.links.consumeAll(draftId);
      return sendPage(reply.header("set-cookie", clearCookie), 200, messagePage(options, request, "replace.done.title", "replace.done.text"));
    }
    const originIds = values(formBody, "originId");
    try {
      app.discovery.completeWithSelection(draftId, {
        originIds,
        credentialIds: values(formBody, "credentialId"),
        credentialValues,
      });
    } catch {
      // On a review form an empty destination list is the person's choice to fix, so it gets its own message.
      const problem = current.status === "needs_review" && originIds.length === 0 ? "keys.error.noDestination" : "keys.error";
      return sendPage(reply, 400, renderForm(options, request, app, app.drafts.get(draftId), token, problem));
    }
    app.links.consumeAll(draftId);
    return sendPage(reply.header("set-cookie", clearCookie), 200, messagePage(options, request, "keys.done.title", "keys.done.text"));
  });
}
