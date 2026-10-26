import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { WebSession } from "../auth/repository.js";
import type { ConnectionDraftRecord } from "../discovery/repository.js";
import type { Application } from "../index.js";
import { destinationChoices } from "./destinations.js";
import { first, parseForm, values } from "./forms.js";
import { escapeHtml, layout } from "./layout.js";

export type DraftRouteHelpers = {
  requireCsrf(
    request: FastifyRequest,
    reply: FastifyReply,
  ): { session: WebSession; csrfToken: string } | null;
  sessionCsrfToken(request: FastifyRequest): string;
};

function stages(active: number): string {
  const labels = ["Reading documentation", "Finding the API", "Finding required keys", "Ready to review"];
  return `<ol class="stage-list">${labels.map((label, index) => {
    const state = index < active ? "completed" : index === active ? "current" : "waiting";
    return `<li class="stage" data-state="${state}"><span>${index + 1}</span><strong>${label}</strong></li>`;
  }).join("")}</ol>`;
}

function retryForm(draft: ConnectionDraftRecord, csrf: string): string {
  return `<form method="post" action="/connection-drafts/${escapeHtml(draft.id)}/retry"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Try reading again</button></form>`;
}

// noDestination: the review form came back without any destination selected.
function renderDraft(draft: ConnectionDraftRecord, csrf: string, sourceUrl: string, noDestination = false): string {
  const title = draft.suggestedLabel ?? draft.serviceName ?? "New API connection";
  if (draft.status === "discovering") {
    return layout(
      "Reading documentation",
      `<section class="wizard-head"><span class="eyebrow">Automatic setup</span><h1>We’re reading the API guide.</h1><p class="lede">You can leave this page open. APIUniCon is finding the safe destination and the keys the service expects.</p></section><section class="card" data-status-url="/api/connection-drafts/${escapeHtml(draft.id)}/status" data-state="discovering">${stages(0)}<p class="muted">No credentials are requested or sent during this step.</p></section>`,
      { csrfToken: csrf },
    );
  }
  if (draft.status === "failed") {
    return layout(
      "Could not read documentation",
      `<h1>We couldn’t read that guide.</h1><p class="lede">Nothing was connected and no secret was requested. Check that the link opens, then try again.</p><section class="card"><p class="error">Documentation reading failed (${escapeHtml(draft.errorCategory ?? "crawl")}).</p>${retryForm(draft, csrf)}<p><a href="/connections/new">Use another documentation link</a></p></section>`,
      { csrfToken: csrf },
    );
  }
  if (draft.status === "needs_help") {
    const blocked = draft.helpReason === "documentation_unavailable";
    // Unsupported methods are listed for information when a supported key was also found; only an
    // unsupported_auth draft is actually stopped by them.
    const stopped = draft.helpReason === "unsupported_auth";
    const unsupported = stopped && draft.discovery.unsupportedAuthMethods.includes("OAuth 2.0")
      ? '<p class="error">This API uses OAuth, which this version cannot connect yet.</p>'
      : stopped && draft.discovery.unsupportedAuthMethods.length > 0
        ? `<p class="error">This API uses ${escapeHtml(draft.discovery.unsupportedAuthMethods.join(" and "))}, which this version cannot connect yet.</p>`
        : blocked
          ? ""
          : '<p class="error">We read the documentation but couldn\'t identify where requests go or which key is required.</p>';
    const heading = blocked ? "This documentation can’t be read automatically." : "We need one technical detail.";
    const lede = blocked
      ? "Your AI assistant can find the official files and finish the setup. You can also retry or open the recovery fields below."
      : "The automatic pass did not find a safe, complete answer. You can retry or open the recovery fields below.";
    const hint = blocked
      ? `<section class="card"><h2>Continue with your AI assistant</h2><p>Write to your assistant:</p><pre>Connect this API with APIUniCon: ${escapeHtml(sourceUrl)}</pre><p class="muted">In Claude Code, the shortcut <code>/mcp__apiunicon__connect ${escapeHtml(sourceUrl)}</code> does the same.</p></section>`
      : "";
    return layout(
      "Setup needs help",
      `<h1>${heading}</h1><p class="lede">${lede}</p>${hint}<section class="card">${unsupported}${retryForm(draft, csrf)}<details class="advanced"><summary>Advanced setup</summary><form method="post" action="/connection-drafts/${escapeHtml(draft.id)}/select"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="mode" value="advanced"><label>Connection name <span class="muted">optional</span><input name="label" value="${escapeHtml(draft.suggestedLabel ?? "")}"></label><label>API address<input required type="url" name="origin" placeholder="https://api.example.com"></label><label>Credential header<input required name="credentialName" placeholder="Api-Key"></label><button type="submit">Continue securely</button></form></details></section>`,
      { csrfToken: csrf },
    );
  }
  if (draft.status === "needs_review") {
    const origins = destinationChoices(draft, sourceUrl, title);
    const problem = noDestination ? '<p class="warning">Select at least one API destination.</p>' : "";
    const credentials = draft.discovery.credentials.map((candidate) =>
      `<input type="hidden" name="credentialId" value="${escapeHtml(candidate.id)}"><div class="row"><span>${escapeHtml(candidate.humanLabel)}</span><span class="technical-detail">${escapeHtml(candidate.fieldName)}</span></div>`,
    ).join("");
    return layout(
      title,
      `<span class="eyebrow">Review what we found</span><h1>${escapeHtml(title)}</h1><p class="lede">Confirm where this connection may send requests. Keys are entered only on the next screen.</p>${problem}<form method="post" action="/connection-drafts/${escapeHtml(draft.id)}/select"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><section class="card"><h2>API destination</h2><div class="choices">${origins}</div><h2 class="section-gap">Keys this service expects</h2>${credentials}<button type="submit">Continue securely</button></section></form><details class="advanced"><summary>Advanced setup</summary><p>The exact addresses and header names above came from the documentation. If they are wrong, return and use recovery setup.</p></details>`,
      { csrfToken: csrf },
    );
  }
  if (draft.status === "ready" && draft.selectedCredentials) {
    const fields = draft.selectedCredentials.map((credential) =>
      `<label>${escapeHtml(credential.humanLabel)}<small class="technical-detail">${escapeHtml(credential.fieldName)}</small><input required type="password" autocomplete="off" name="credentialValue:${escapeHtml(credential.id)}" spellcheck="false"></label>`,
    ).join("");
    return layout(
      "Enter keys",
      `<span class="eyebrow">Encrypted on this computer</span><h1>Add your keys.</h1><p class="lede">Paste only the values. APIUniCon already knows their names and seals them directly in the local Vault.</p><section class="card"><form method="post" action="/connection-drafts/${escapeHtml(draft.id)}/complete"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${fields}<button type="submit">Save keys and connect</button></form><p class="muted">These values are never shown again or included in discovery state.</p></section>`,
      { csrfToken: csrf },
    );
  }
  return layout(
    "Connection complete",
    `<h1>Connection ready.</h1><p><a class="button" href="/connections/${escapeHtml(draft.completedConnectionId ?? "")}">Open connection</a></p>`,
    { csrfToken: csrf },
  );
}

export function registerConnectionDraftRoutes(
  server: FastifyInstance,
  application: Application,
  helpers: DraftRouteHelpers,
): void {
  server.get("/connections/new", async (request, reply) => {
    const csrf = helpers.sessionCsrfToken(request);
    return reply.type("text/html").send(layout(
      "Connect an API",
      `<span class="eyebrow">One-link setup</span><h1>Connect an API.</h1><p class="lede">Paste the service’s API documentation. We’ll read it, identify the safe destination, and tell you which keys to paste.</p><section class="card start-card"><form method="post" action="/connection-drafts"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>API documentation link<input required autofocus type="url" inputmode="url" name="documentationUrl" placeholder="https://docs.example.com/api/"></label><button type="submit">Read documentation</button></form><details class="advanced"><summary>Advanced setup</summary><p>Use this only if automatic setup cannot find the API address or key names. Those fields appear after the safe automatic check.</p></details></section>`,
      { csrfToken: csrf, compact: true },
    ));
  });

  server.post("/connection-drafts", async (request, reply) => {
    if (!helpers.requireCsrf(request, reply)) return;
    const documentationUrl = first(parseForm(request.body), "documentationUrl")?.trim() ?? "";
    if (!documentationUrl) return reply.code(400).type("text/plain").send("Documentation URL is required");
    const draft = application.discovery.begin(documentationUrl);
    application.jobRunner.wake();
    return reply.redirect(`/connection-drafts/${draft.id}`, 303);
  });

  server.get<{ Params: { id: string } }>("/connection-drafts/:id", async (request, reply) => {
    const draft = application.drafts.get(request.params.id);
    if (draft.status === "completed" && draft.completedConnectionId) {
      return reply.redirect(`/connections/${draft.completedConnectionId}`, 303);
    }
    const sourceUrl = application.connections.getDocumentationSource(draft.documentationSourceId).rootUrl;
    return reply.type("text/html").send(renderDraft(draft, helpers.sessionCsrfToken(request), sourceUrl));
  });

  server.get<{ Params: { id: string } }>("/api/connection-drafts/:id/status", async (request) => {
    const draft = application.drafts.get(request.params.id);
    return {
      id: draft.id,
      status: draft.status,
      helpReason: draft.helpReason,
      serviceName: draft.serviceName,
      destinations: draft.discovery.origins.map(({ origin }) => new URL(origin).hostname),
      requiredKeys: draft.discovery.credentials.map(({ humanLabel }) => humanLabel),
      errorCategory: draft.errorCategory,
      completedConnectionId: draft.completedConnectionId,
    };
  });

  server.post<{ Params: { id: string } }>("/connection-drafts/:id/select", async (request, reply) => {
    if (!helpers.requireCsrf(request, reply)) return;
    const form = parseForm(request.body);
    if (first(form, "mode") === "advanced") {
      const label = first(form, "label")?.trim();
      application.discovery.selectAdvanced(request.params.id, {
        origins: values(form, "origin").map((value) => value.trim()).filter(Boolean),
        credentialNames: values(form, "credentialName").map((value) => value.trim()).filter(Boolean),
        ...(label ? { label } : {}),
      });
    } else {
      const originIds = values(form, "originId");
      // An address on another domain starts unselected, so a review sent as it came may name none: the same page
      // again, asking for one.
      if (originIds.length === 0) {
        const draft = application.drafts.get(request.params.id);
        const sourceUrl = application.connections.getDocumentationSource(draft.documentationSourceId).rootUrl;
        return reply.code(400).type("text/html").send(renderDraft(draft, helpers.sessionCsrfToken(request), sourceUrl, true));
      }
      application.discovery.select(request.params.id, { originIds, credentialIds: values(form, "credentialId") });
    }
    return reply.redirect(`/connection-drafts/${request.params.id}`, 303);
  });

  server.post<{ Params: { id: string } }>("/connection-drafts/:id/complete", async (request, reply) => {
    if (!helpers.requireCsrf(request, reply)) return;
    const form = parseForm(request.body);
    const credentialValues: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [name, value] of Object.entries(form)) {
      if (!name.startsWith("credentialValue:") || Array.isArray(value) || value === undefined) continue;
      credentialValues[name.slice("credentialValue:".length)] = value;
    }
    const connection = application.discovery.complete(request.params.id, { credentialValues });
    return reply.redirect(`/connections/${connection.id}`, 303);
  });

  server.post<{ Params: { id: string } }>("/connection-drafts/:id/retry", async (request, reply) => {
    if (!helpers.requireCsrf(request, reply)) return;
    application.discovery.retry(request.params.id);
    application.jobRunner.wake();
    return reply.redirect(`/connection-drafts/${request.params.id}`, 303);
  });
}
