import type { FastifyInstance, FastifyRequest } from "fastify";

import { ACTION_LINK_TTL_MS } from "../connections/action-links.js";
import { translate } from "../i18n/messages.js";
import type { Application } from "../index.js";
import { registerChangeRoutes } from "./change-page.js";
import { first, parseForm } from "./forms.js";
import { escapeHtml } from "./layout.js";
import { linkFormToken, linkCookie, linkToken, messagePage, sendPage, SIGNED_IN, type OneTimePageOptions } from "./one-time.js";

const COOKIE = "apiunicon_confirm";
const PURPOSE = "delete";
const LEDE = { erased: "delete.lede.adapterErased", kept: "delete.lede.adapterKept", none: "delete.lede.noAdapter" } as const;

// The offer is extra: when the host cannot say whether to make it, the page goes on without the checkbox rather than
// keeping the person from deleting.
async function proposalOffered(
  options: OneTimePageOptions,
  request: FastifyRequest,
  app: Application,
  connectionId: string,
): Promise<boolean> {
  if (!options.offerProposal || !options.propose) return false;
  try {
    return await options.offerProposal(app, connectionId);
  } catch (error) {
    request.log.error({ err: error }, "catalog proposal check failed");
    return false;
  }
}

// The host's note under the checkbox is as optional as the checkbox: without it the page is the same, never broken.
async function proposalNoteOf(
  options: OneTimePageOptions,
  request: FastifyRequest,
  app: Application,
  connectionId: string,
): Promise<string> {
  if (!options.proposalNote) return "";
  try {
    return await options.proposalNote(app, connectionId, options.locale(request)) ?? "";
  } catch (error) {
    request.log.error({ err: error }, "catalog proposal note failed");
    return "";
  }
}

function renderConfirm(
  options: OneTimePageOptions,
  request: FastifyRequest,
  app: Application,
  connectionId: string,
  token: string,
  offerProposal: boolean,
  proposalNote: string,
): string {
  const locale = options.locale(request);
  const connection = app.connections.getConnection(connectionId);
  const hosts = connection.allowedOrigins.map((origin) => new URL(origin).host).join(", ");
  // The page says exactly what the deletion erases, so it asks the repository the same question delete() does.
  const lede = LEDE[app.connections.adapterOnDelete(connectionId)];
  const proposal = offerProposal
    ? `<label class="confirm"><input type="checkbox" name="propose" value="yes"> ${escapeHtml(translate(locale, "delete.proposal.offer"))}</label>${proposalNote}`
    : "";
  return options.render(
    request,
    translate(locale, "delete.pageTitle"),
    `<h1>${escapeHtml(translate(locale, "delete.heading", { label: connection.label }))}</h1><p class="lede">${escapeHtml(translate(locale, lede, { hosts }))}</p><form method="post" action="/confirm/delete/${escapeHtml(connection.id)}"><input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE, token))}">${proposal}<button type="submit">${escapeHtml(translate(locale, "delete.submit"))}</button></form>`,
  );
}

// The proposal went through and the host has a line about it. The line is plain text, so it is escaped here.
function deletedWithOutcome(options: OneTimePageOptions, request: FastifyRequest, outcome: string): string {
  const locale = options.locale(request);
  const title = translate(locale, "delete.done.title");
  return options.render(
    request,
    title,
    `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(translate(locale, "delete.done.text"))}</p><p>${escapeHtml(outcome)}</p>`,
  );
}

function deletedWithoutProposal(options: OneTimePageOptions, request: FastifyRequest, reason: string): string {
  const locale = options.locale(request);
  const title = translate(locale, "delete.done.title");
  const detail = reason === "" ? "" : `<p class="muted">${escapeHtml(reason)}</p>`;
  return options.render(
    request,
    title,
    `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(translate(locale, "delete.done.text"))}</p><p class="warning">${escapeHtml(translate(locale, "delete.proposal.failed"))}</p>${detail}`,
  );
}

export function registerConfirmRoutes(server: FastifyInstance, options: OneTimePageOptions): void {
  const path = (connectionId: string) => `/confirm/delete/${connectionId}`;
  const expired = (request: FastifyRequest) => messagePage(options, request, "link.expired.title", "link.expired.text");
  const notFound = (request: FastifyRequest) => messagePage(options, request, "link.notFound.title", "link.notFound.text");

  server.get<{ Params: { id: string }; Querystring: { t?: string } }>("/confirm/delete/:id", SIGNED_IN, async (request, reply) => {
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const connectionId = request.params.id;
    const queryToken = request.query.t;
    if (queryToken !== undefined) {
      if (!app.actionLinks.verify(connectionId, "delete", queryToken)) return sendPage(reply, 403, expired(request));
      return reply
        .header("set-cookie", linkCookie(COOKIE, path(connectionId), queryToken, ACTION_LINK_TTL_MS / 1_000, options.secureCookies))
        .redirect(path(connectionId), 303);
    }
    const token = linkToken(request, COOKIE);
    if (!app.actionLinks.verify(connectionId, "delete", token)) return sendPage(reply, 403, expired(request));
    const offered = await proposalOffered(options, request, app, connectionId);
    const note = offered ? await proposalNoteOf(options, request, app, connectionId) : "";
    return sendPage(reply, 200, renderConfirm(options, request, app, connectionId, token, offered, note));
  });

  server.post<{ Params: { id: string } }>("/confirm/delete/:id", SIGNED_IN, async (request, reply) => {
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const connectionId = request.params.id;
    const token = linkToken(request, COOKIE);
    const form = parseForm(request.body);
    if (!app.actionLinks.verify(connectionId, "delete", token) || first(form, "csrf") !== linkFormToken(PURPOSE, token)) {
      return sendPage(reply, 403, expired(request));
    }
    // Proposed before the deletion, which may erase the adapter. A failed proposal does not stop the deletion.
    let proposalError: string | null = null;
    let outcome = "";
    if (options.propose && first(form, "propose") === "yes" && await proposalOffered(options, request, app, connectionId)) {
      try {
        outcome = await options.propose(app, connectionId, options.locale(request)) ?? "";
      } catch (error) {
        request.log.error({ err: error }, "catalog proposal failed");
        proposalError = error instanceof Error ? error.message : "";
      }
    }
    try {
      app.connections.delete(connectionId);
    } catch (error) {
      // Deletion can fail only before or inside its single transaction (the journal flush after it never throws), so
      // nothing was erased and the link and its cookie still work for a retry.
      request.log.error({ err: error }, "connection deletion failed");
      return sendPage(reply, 500, messagePage(options, request, "delete.failed.title", "delete.failed.text"));
    }
    return sendPage(
      reply.header("set-cookie", linkCookie(COOKIE, path(connectionId), "", 0, options.secureCookies)),
      200,
      proposalError !== null
        ? deletedWithoutProposal(options, request, proposalError)
        : outcome === ""
          ? messagePage(options, request, "delete.done.title", "delete.done.text")
          : deletedWithOutcome(options, request, outcome),
    );
  });

  registerChangeRoutes(server, options);
}
