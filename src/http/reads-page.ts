import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { spellOut } from "../changes/describe.js";
import { READ_APPROVAL_LINK_TTL_MS } from "../connections/action-links.js";
import { translate, type MessageKey } from "../i18n/messages.js";
import { READ_APPROVAL_PATH, type PendingRead, type PendingReadInput, type ReadApprovalView } from "../reads/service.js";
import { privatePage } from "./change-page.js";
import { first, parseForm } from "./forms.js";
import { escapeHtml } from "./layout.js";
import { linkFormToken, linkCookie, linkToken, messagePage, sendPage, SIGNED_IN, type OneTimePageOptions } from "./one-time.js";

export const READ_APPROVAL_COOKIE = "apiunicon_reads";
const PURPOSE = "reads";

// Every read that waits, with the adapter's words for it, where it is sent, and its inputs, whose values the assistant
// chooses. An input that takes any text or data is marked, since through it one address can be asked anything. The words,
// the address and the input names are the assistant's or a catalog author's, so their invisible and direction characters
// are written out, and all is escaped. The form names the list by its fingerprint, so a click approves exactly what this
// page shows.
function approvalForm(
  options: OneTimePageOptions,
  request: FastifyRequest,
  view: ReadApprovalView,
  token: string,
  changed: boolean,
): string {
  const locale = options.locale(request);
  const text = (key: MessageKey, vars?: Record<string, string | number>) => escapeHtml(translate(locale, key, vars));
  const input = (item: PendingReadInput) => {
    const where = text(item.required ? "reads.input.required" : "reads.input", {
      type: item.type,
      location: translate(locale, `reads.location.${item.location}`),
    });
    const line = `<code>${escapeHtml(spellOut(item.name))}</code> ${where}`;
    return item.freeForm ? `<li class="warning" data-free-form>${line}. ${text("reads.freeForm")}</li>` : `<li>${line}</li>`;
  };
  const inputs = (read: PendingRead) => read.inputs.length === 0
    ? `<span>${text("reads.noInputs")}</span>`
    : `<ul>${read.inputs.map(input).join("")}</ul>`;
  const reads = view.reads.map((read) =>
    `<div class="rows section-gap"><div class="row"><span>${text("reads.action")}</span><span>${escapeHtml(spellOut(read.description))}</span></div><div class="row"><span>${text("reads.target")}</span><code>${escapeHtml(spellOut(`${read.method} ${read.url}`))}</code></div><div class="row"><span>${text("reads.inputs")}</span>${inputs(read)}</div></div>`).join("");
  const warning = changed ? `<p class="warning">${text("reads.changed")}</p>` : "";
  return options.render(
    request,
    translate(locale, "reads.pageTitle"),
    `<div class="change"><h1>${text("reads.heading", { label: spellOut(view.connectionLabel) })}</h1><p class="lede">${text("reads.lede")}</p><p>${text("reads.anyValues")}</p>${warning}${reads}<form class="section-gap" method="post" action="${READ_APPROVAL_PATH}/${escapeHtml(view.connectionId)}"><input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE, token))}"><input type="hidden" name="fingerprint" value="${escapeHtml(view.fingerprint)}"><button type="submit" name="decision" value="approve">${text("reads.approve")}</button> <button type="submit" name="decision" value="decline" class="secondary">${text("reads.decline")}</button></form></div>`,
  );
}

// The page where the person approves a connection's reads sent with POST, from a one-time link the assistant got. The
// link's token moves into a cookie on the page's own path, and the form carries only a token derived from it. Locally
// the workspace's sign-in is required in front of it, as for a change's page; a hosted service puts its own in front.
export function registerReadApprovalRoutes(server: FastifyInstance, options: OneTimePageOptions): void {
  const path = (connectionId: string) => `${READ_APPROVAL_PATH}/${connectionId}`;
  const expired = (request: FastifyRequest) => messagePage(options, request, "link.expired.title", "link.expired.text");
  const notFound = (request: FastifyRequest) => messagePage(options, request, "link.notFound.title", "link.notFound.text");
  const clearCookie = (reply: FastifyReply, connectionId: string) =>
    reply.header("set-cookie", linkCookie(READ_APPROVAL_COOKIE, path(connectionId), "", 0, options.secureCookies));
  const show = (reply: FastifyReply, request: FastifyRequest, view: ReadApprovalView, token: string, changed: boolean) =>
    view.reads.length === 0
      ? sendPage(reply, 200, messagePage(options, request, "reads.none.title", "reads.none.text"))
      : sendPage(reply, changed ? 409 : 200, approvalForm(options, request, view, token, changed));

  server.get<{ Params: { id: string }; Querystring: { t?: unknown } }>(`${READ_APPROVAL_PATH}/:id`, SIGNED_IN, async (request, reply) => {
    privatePage(reply);
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const connectionId = request.params.id;
    const queryToken = request.query.t;
    if (queryToken !== undefined) {
      if (typeof queryToken !== "string" || !app.actionLinks.verify(connectionId, "approve_reads", queryToken)) {
        return sendPage(reply, 403, expired(request));
      }
      return reply
        .header("set-cookie", linkCookie(READ_APPROVAL_COOKIE, path(connectionId), queryToken, READ_APPROVAL_LINK_TTL_MS / 1_000, options.secureCookies))
        .redirect(path(connectionId), 303);
    }
    const token = linkToken(request, READ_APPROVAL_COOKIE);
    const view = app.readApprovals.open(connectionId, token);
    if (view === null) return sendPage(reply, 403, expired(request));
    return show(reply, request, view, token, false);
  });

  server.post<{ Params: { id: string } }>(`${READ_APPROVAL_PATH}/:id`, SIGNED_IN, async (request, reply) => {
    privatePage(reply);
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const connectionId = request.params.id;
    const token = linkToken(request, READ_APPROVAL_COOKIE);
    const form = parseForm(request.body);
    if (!app.actionLinks.verify(connectionId, "approve_reads", token) || first(form, "csrf") !== linkFormToken(PURPOSE, token)) {
      return sendPage(reply, 403, expired(request));
    }
    const decision = first(form, "decision");
    if (decision === "decline") {
      if (!app.readApprovals.decline(connectionId, token)) return sendPage(reply, 403, expired(request));
      return sendPage(clearCookie(reply, connectionId), 200, messagePage(options, request, "reads.declined.title", "reads.declined.text"));
    }
    if (decision !== "approve") return reply.redirect(path(connectionId), 303);
    const outcome = app.readApprovals.approve(connectionId, token, first(form, "fingerprint") ?? "");
    if (outcome.kind === "approved") {
      return sendPage(clearCookie(reply, connectionId), 200, messagePage(options, request, "reads.approved.title", "reads.approved.text"));
    }
    // Something else waits now than the page showed: nothing was approved, and the page shows the list as it is.
    const view = outcome.kind === "changed" ? app.readApprovals.open(connectionId, token) : null;
    if (view === null) return sendPage(reply, 403, expired(request));
    return show(reply, request, view, token, true);
  });
}
