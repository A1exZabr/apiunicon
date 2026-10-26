import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";

import { describeArguments, spellOut, type ArgumentRow } from "../changes/describe.js";
import { outcomeKeyOf, type OutcomeKey } from "../changes/outcome.js";
import { CHANGE_LINK_TTL_MS, type ChangeReason, type ChangeRecord } from "../changes/repository.js";
import type { PageState } from "../changes/service.js";
import { formatMinutes, translate, type MessageKey } from "../i18n/messages.js";
import { first, parseForm } from "./forms.js";
import { escapeHtml } from "./layout.js";
import { linkFormToken, linkCookie, linkToken, messagePage, sendPage, SIGNED_IN, type OneTimePageOptions } from "./one-time.js";

export const CHANGE_COOKIE = "apiunicon_change";

// Each step has its own form token, so the first form of a destructive change can never stand in for the second.
const PURPOSE = { 0: "change", 1: "change-final" } as const;
const STEPS = [0, 1] as const;

const REFUSED: Record<Exclude<ChangeReason, "person" | "superseded">, MessageKey> = {
  plan: "change.refused.plan",
  writes_off: "change.refused.writes_off",
  adapter_changed: "change.refused.adapter_changed",
  limit: "change.refused.limit",
  origin: "change.refused.origin",
  card_attempts: "change.refused.card_attempts",
};

export type Outcome = { status: number; title: MessageKey; text: MessageKey; vars?: Record<string, string | number> };

// Which step's form the posted token belongs to, compared in constant time, or null for none of this link's.
function formStep(given: string | undefined, token: string): 0 | 1 | null {
  if (given === undefined) return null;
  const posted = Buffer.from(given);
  for (const step of STEPS) {
    const expected = Buffer.from(linkFormToken(PURPOSE[step], token));
    if (posted.length === expected.length && timingSafeEqual(posted, expected)) return step;
  }
  return null;
}

// What the page says for each way a change can stand. A waiting change is answered with its form, never here; were it,
// the page offers nothing to press. Only the status of the service's answer is ever shown, never the answer itself.
const OUTCOME_PAGE: Record<OutcomeKey, Omit<Outcome, "vars">> = {
  waiting: { status: 403, title: "link.expired.title", text: "link.expired.text" },
  expired: { status: 403, title: "link.expired.title", text: "link.expired.text" },
  running: { status: 200, title: "change.running.title", text: "change.running.text" },
  done: { status: 200, title: "change.done.title", text: "change.done.text" },
  service_error: { status: 200, title: "change.failed.title", text: "change.failed.text" },
  not_sent: { status: 200, title: "change.refused.title", text: "change.notSent.text" },
  no_answer: { status: 200, title: "change.unknown.title", text: "change.unknown.text" },
  not_confirmed: { status: 200, title: "change.unconfirmed.title", text: "change.unconfirmed.text" },
  cancelled_by_person: { status: 200, title: "change.cancelled.title", text: "change.cancelled.text" },
  replaced: { status: 200, title: "change.cancelled.title", text: "change.cancelled.text" },
  cancelled_writes_off: { status: 200, title: "change.cancelled.title", text: "change.refused.writes_off" },
  refused_plan: { status: 200, title: "change.refused.title", text: REFUSED.plan },
  refused_writes_off: { status: 200, title: "change.refused.title", text: REFUSED.writes_off },
  refused_adapter_changed: { status: 200, title: "change.refused.title", text: REFUSED.adapter_changed },
  refused_limit: { status: 200, title: "change.refused.title", text: REFUSED.limit },
  refused_origin: { status: 200, title: "change.refused.title", text: REFUSED.origin },
  refused_other: { status: 200, title: "change.refused.title", text: "change.cancelled.text" },
};

export function outcomeOf(record: ChangeRecord): Outcome {
  const key = outcomeKeyOf(record);
  const page = OUTCOME_PAGE[key];
  return key === "done" || key === "service_error" ? { ...page, vars: { status: record.httpStatus ?? "" } } : page;
}

// The values a change sends, each named and, when its input has a description, labelled by it, in full and escaped. A
// block is never height-limited: nothing that will be sent may sit hidden above the button. The journal shows the same.
export function argumentList(rows: readonly ArgumentRow[]): string {
  return `<dl>${rows.map((row) => {
    const label = row.label === row.name ? "" : `${escapeHtml(row.label)} `;
    const value = row.block ? `<pre class="value">${escapeHtml(row.value)}</pre>` : escapeHtml(row.value);
    return `<dt>${label}<code>${escapeHtml(row.name)}</code></dt><dd>${value}</dd>`;
  }).join("")}</dl>`;
}

// Every value that will be sent, in full and escaped, then the assistant's words, signed as theirs and placed below.
// Text APIUniCon did not write has its invisible and direction characters written out, so it reads as it is.
function changeForm(options: OneTimePageOptions, request: FastifyRequest, state: PageState, token: string): string {
  const locale = options.locale(request);
  const text = (key: MessageKey, vars?: Record<string, string | number>) => escapeHtml(translate(locale, key, vars));
  const { record } = state;
  const host = new URL(record.targetUrl).host;
  const final = record.step === 1;
  const rows = describeArguments(record);
  const values = rows.length === 0 ? `<p class="muted">${text("change.noValues")}</p>` : argumentList(rows);
  const heading = final
    ? text("change.final.heading")
    : text(record.risk === "destructive" ? "change.heading.destructive" : "change.heading.write", {
      label: spellOut(record.connectionLabel),
    });
  // The lede names the first step's button, so the second step, whose button is another, goes without it.
  const lede = final ? "" : `<p class="lede">${text("change.lede", { host })}</p>`;
  const firstTime = state.firstTime ? `<p class="warning">${text("change.firstTime")}</p>` : "";
  // With confirmation off, this "Run" is the one that lets the action through at once from then on: the page says so.
  const standing = state.grantsStanding ? `<p class="warning">${text("change.standing")}</p>` : "";
  const finalWarning = final ? `<p class="warning">${text("change.final.text", { host })}</p>` : "";
  return options.render(
    request,
    translate(locale, "change.pageTitle"),
    `<div class="change"><h1>${heading}</h1>${lede}<div class="rows"><div class="row"><span>${text("change.action")}</span><span>${escapeHtml(spellOut(record.operation.description))}</span></div><div class="row"><span>${text("change.target")}</span><code>${escapeHtml(`${record.method} ${record.targetUrl}`)}</code></div></div><h2 class="section-gap">${text("change.values")}</h2>${values}<blockquote>${text("change.assistant", { summary: spellOut(record.summary) })}</blockquote><p class="muted">${text("change.assistantNote")}</p>${firstTime}${finalWarning}<p class="muted">${text("change.expires", { duration: formatMinutes(locale, CHANGE_LINK_TTL_MS) })}</p>${standing}<form method="post" action="/confirm/change/${escapeHtml(record.id)}"><input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE[record.step], token))}"><button type="submit" name="decision" value="run">${text(final ? "change.final.run" : "change.run")}</button> <button type="submit" name="decision" value="cancel" class="secondary">${text("change.cancel")}</button></form></div>`,
  );
}

// The page carries what a change will do and the link's cookie, so it is not cached, and no other site can frame it
// under a click, even when a host serves it without headers of its own. Referrer-Policy is the host's alone: the local
// server needs same-origin (server.ts), since under no-referrer a browser words the Origin of the page's own form as
// "null" and the server's check of where a form comes from would refuse every one. The page links nowhere else and loads
// nothing from elsewhere, so the browser's default sends no more than this host's origin to another site.
export function privatePage(reply: FastifyReply): FastifyReply {
  return reply.header("cache-control", "no-store").header("x-frame-options", "DENY");
}

// The confirmation of one change the assistant asked for. The link's token moves into a cookie on the page's own path,
// the form carries only a token derived from it and its step, and what runs is what the change stored, never the form.
export function registerChangeRoutes(server: FastifyInstance, options: OneTimePageOptions): void {
  const path = (changeId: string) => `/confirm/change/${changeId}`;
  const expired = (request: FastifyRequest) => messagePage(options, request, "link.expired.title", "link.expired.text");
  const notFound = (request: FastifyRequest) => messagePage(options, request, "link.notFound.title", "link.notFound.text");
  const outcome = (reply: FastifyReply, request: FastifyRequest, record: ChangeRecord) => {
    const { status, title, text, vars } = outcomeOf(record);
    return sendPage(reply, status, messagePage(options, request, title, text, vars));
  };

  server.get<{ Params: { id: string }; Querystring: { t?: unknown } }>("/confirm/change/:id", SIGNED_IN, async (request, reply) => {
    privatePage(reply);
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const queryToken = request.query.t;
    if (queryToken !== undefined) {
      const record = typeof queryToken === "string" ? app.changes.find(request.params.id, queryToken) : null;
      // The cookie lives exactly as long as the link: a decided change shows its outcome until then.
      const secondsLeft = record === null ? 0 : Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1_000);
      if (typeof queryToken !== "string" || record === null || record.status === "expired" || secondsLeft < 1) {
        return sendPage(reply, 403, expired(request));
      }
      return reply
        .header("set-cookie", linkCookie(CHANGE_COOKIE, path(record.id), queryToken, secondsLeft, options.secureCookies))
        .redirect(path(record.id), 303);
    }
    const token = linkToken(request, CHANGE_COOKIE);
    const state = await app.changes.open(request.params.id, token);
    if (state === null) return sendPage(reply, 403, expired(request));
    if (state.record.status !== "pending") return outcome(reply, request, state.record);
    // The host or the switch does not let it run now: the page says why and offers no button.
    if (state.blocked !== null) {
      return sendPage(reply, 200, messagePage(options, request, "change.refused.title", REFUSED[state.blocked]));
    }
    return sendPage(reply, 200, changeForm(options, request, state, token));
  });

  server.post<{ Params: { id: string } }>("/confirm/change/:id", SIGNED_IN, async (request, reply) => {
    privatePage(reply);
    const app = await options.resolveApplication(request);
    if (!app) return sendPage(reply, 404, notFound(request));
    const token = linkToken(request, CHANGE_COOKIE);
    const record = app.changes.find(request.params.id, token);
    const form = parseForm(request.body);
    const step = record === null ? null : formStep(first(form, "csrf"), token);
    // No form of this link, or the second step's form before the first step was taken: refused.
    if (record === null || step === null || step > record.step) return sendPage(reply, 403, expired(request));
    // The form of a step already passed, from another tab or a second click: it decides nothing, and the page shows
    // where the change stands, for a destructive one the final form.
    if (step < record.step) return reply.redirect(path(record.id), 303);
    const decision = first(form, "decision");
    if (decision !== "run" && decision !== "cancel") return reply.redirect(path(record.id), 303);
    const decided = await app.changes.decide(record.id, token, decision, step);
    // The first of a destructive change's two confirmations: the page asks again.
    if (decided?.kind === "final_step") return reply.redirect(path(record.id), 303);
    // Nothing decided by this click (another one was first, or the change stopped waiting): show where it stands.
    const current = decided?.record ?? app.changes.find(record.id, token);
    if (current === null) return sendPage(reply, 403, expired(request));
    if (current.status === "pending") return reply.redirect(path(record.id), 303);
    return outcome(reply, request, current);
  });
}
