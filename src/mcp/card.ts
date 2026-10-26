import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { EXTENSION_ID, RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { describeArguments, spellOut, type ArgumentRow } from "../changes/describe.js";
import { outcomeKeyOf, type OutcomeKey } from "../changes/outcome.js";
import { CHANGE_LINK_TTL_MS, type ChangeRecord, type ChangeStatus } from "../changes/repository.js";
import type { CardDecision, CardlessAnswer, RequestChangeAnswer } from "../changes/service.js";
import { outcomeOf } from "../http/change-page.js";
import { formatMinutes, translate, type Locale, type MessageKey } from "../i18n/messages.js";
import { buildCardHtml } from "./card-view.js";

// The chat card that request_change shows beside the assistant's answer, on hosts that draw MCP Apps.
export const CHANGE_CARD_URI = "ui://apiunicon/change-card-v1";

export type CardFact = { label: string; value: string };

// What the card shows, every text already in the server's language. A change that waits gets the page's own words and
// the card's token; anything else, an outcome without buttons. Text APIUniCon did not write is spelled out, as on the
// page, and the card puts all of it in with textContent.
export type ChangeCardData =
  | {
    kind: "confirm";
    locale: Locale;
    changeId: string;
    cardToken: string;
    step: 0 | 1;
    risk: "write" | "destructive";
    expiresAt: string;
    // The same link the assistant is given.
    url: string;
    heading: string;
    lede: string;
    // The action, then where it goes.
    facts: CardFact[];
    valuesTitle: string;
    values: ArgumentRow[];
    noValues: string;
    assistant: string;
    assistantNote: string;
    warnings: string[];
    expires: string;
    // run is null where only the page may confirm: a deletion, or a write whose "Run" would let it run at once from then on.
    labels: { run: string | null; cancel: string; openPage: string; pressing: string; callFailed: string };
  }
  | { kind: "outcome"; locale: Locale; changeId: string | null; title: string; text: string; note: string | null };

// What a press tells the card: how the change stands now, in words, and never the change's values or anything else of
// its record.
export type CardAnswer = {
  result: "decided" | "page_only" | "rejected";
  changeStatus: ChangeStatus | null;
  title: string;
  text: string;
  note: string | null;
};

// The page's words for an outcome end with "go back to the chat" or "refresh the page"; the card is in the chat and
// has nothing to refresh, so these say it in their own words.
const CARD_TEXT: Partial<Record<OutcomeKey, MessageKey>> = {
  done: "card.done.text",
  service_error: "card.failed.text",
  not_sent: "card.notSent.text",
  running: "card.running.text",
};

// How a change ended, under the page's titles. A change stopped by wrong presses says so: the page shows it as any
// other refusal, but here the person pressing is the one who needs to know why the card no longer runs it.
function cardOutcome(record: ChangeRecord, locale: Locale): { title: string; text: string } {
  const { title, text, vars } = outcomeOf(record);
  const own = CARD_TEXT[outcomeKeyOf(record)];
  const words: MessageKey = record.status === "refused" && record.reason === "card_attempts"
    ? "change.refused.card_attempts"
    : own ?? text;
  return {
    title: translate(locale, title),
    text: translate(locale, words, own === undefined ? vars : { status: record.httpStatus ?? "" }),
  };
}

// Why the card offers only the page for this change: a deletion asks twice there, and a write whose "Run" lets the
// assistant run it at once from then on gets that permission on the page alone.
function pageOnlyText(record: Pick<ChangeRecord, "risk">, locale: Locale): string {
  return translate(locale, record.risk === "destructive" ? "card.deletion" : "card.standingFirst");
}

export function cardData(answer: RequestChangeAnswer, locale: Locale): ChangeCardData {
  const { card, result } = answer;
  const text = (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
  if (card.kind === "refused") {
    return {
      kind: "outcome",
      locale,
      changeId: null,
      title: text("change.refused.title"),
      text: text(card.reason === "plan" ? "change.refused.plan" : "change.refused.writes_off"),
      note: null,
    };
  }
  if (card.kind === "ran") {
    const { record } = card;
    return {
      kind: "outcome",
      locale,
      changeId: record.id,
      ...cardOutcome(record, locale),
      note: record.confirmation === "none" ? text("card.ranAtOnce") : null,
    };
  }
  if (result.status !== "pending") throw new Error("A change waiting for the card must come with its link");
  const { state, cardToken } = card;
  const { record } = state;
  const pageOnly = record.risk === "destructive" || state.grantsStanding;
  const warnings: string[] = [];
  if (state.firstTime) warnings.push(text("change.firstTime"));
  if (state.grantsStanding) warnings.push(text("change.standing"));
  return {
    kind: "confirm",
    locale,
    changeId: record.id,
    cardToken,
    step: record.step,
    risk: record.risk,
    expiresAt: result.confirmation.expiresAt,
    url: result.confirmation.url,
    heading: text(record.risk === "destructive" ? "change.heading.destructive" : "change.heading.write", {
      label: spellOut(record.connectionLabel),
    }),
    lede: pageOnly ? pageOnlyText(record, locale) : text("change.lede", { host: new URL(record.targetUrl).host }),
    facts: [
      { label: text("change.action"), value: spellOut(record.operation.description) },
      { label: text("change.target"), value: spellOut(`${record.method} ${record.targetUrl}`) },
    ],
    valuesTitle: text("change.values"),
    values: describeArguments(record),
    noValues: text("change.noValues"),
    assistant: text("change.assistant", { summary: spellOut(record.summary) }),
    assistantNote: text("change.assistantNote"),
    warnings,
    expires: text("card.expires", { duration: formatMinutes(locale, CHANGE_LINK_TTL_MS) }),
    labels: {
      run: pageOnly ? null : text("change.run"),
      cancel: text("change.cancel"),
      openPage: text("card.openPage"),
      pressing: text("card.pressing"),
      callFailed: text("card.callFailed"),
    },
  };
}

export function cardAnswer(decision: CardDecision, locale: Locale): CardAnswer {
  const { record } = decision;
  const changeStatus = record?.status ?? null;
  const tell = translate(locale, "card.tellAssistant");
  if (decision.kind === "decided") return { result: "decided", changeStatus, ...cardOutcome(decision.record, locale), note: tell };
  if (decision.kind === "page_only") {
    return {
      result: "page_only",
      changeStatus,
      title: translate(locale, "change.refused.title"),
      text: pageOnlyText(decision.record, locale),
      note: null,
    };
  }
  // A card shown again after its change ended: the press ran nothing, and the card tells how the change ended.
  if (record !== null && record.status !== "pending" && record.status !== "expired") {
    return { result: "rejected", changeStatus, ...cardOutcome(record, locale), note: tell };
  }
  return {
    result: "rejected",
    changeStatus,
    title: translate(locale, "card.invalid.title"),
    text: translate(locale, "card.invalid.text"),
    note: null,
  };
}

// What request_change answers. The assistant reads the text alone: Claude gives the model only structuredContent when a
// result has it, so there is none, and the link stays where the model sees it. The card's data, with its token, is only
// in _meta, which the hosts that draw the card give the card and never the model; a request from a client that draws
// none comes without it (card null), and the text is all there is. A card that cannot be built is left out, never turned
// into an error: the change may already have run at once, and an assistant told it failed would ask for it again. The
// card then shows the link from the text, and nothing is written out about why.
export function changeRequestResult(answer: RequestChangeAnswer | CardlessAnswer, locale: Locale): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(answer.result) }];
  if (answer.card === null) return { content };
  let card: ChangeCardData;
  try {
    card = cardData(answer, locale);
  } catch {
    return { content };
  }
  return { content, _meta: { apiunicon: { card } } };
}

let html: string | undefined;

// The card's page, built at the first read and kept. The bridge comes from the installed ext-apps package and is inlined,
// so the card loads nothing from outside.
export function changeCardHtml(): string {
  html ??= buildCardHtml(readFileSync(createRequire(import.meta.url).resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8"));
  return html;
}

// Whether the client said at initialize that it draws MCP Apps cards: the UI extension with the cards' type. Claude
// Code, older clients and anything that has not initialized yet draw none.
export function clientShowsCards(server: McpServer): boolean {
  try {
    const ui: unknown = server.server.getClientCapabilities()?.extensions?.[EXTENSION_ID];
    const mimeTypes: unknown = typeof ui === "object" && ui !== null ? (ui as { mimeTypes?: unknown }).mimeTypes : undefined;
    return Array.isArray(mimeTypes) && mimeTypes.includes(RESOURCE_MIME_TYPE);
  } catch {
    return false;
  }
}

// The card's resource, registered only where the card may be shown (McpServerOptions.cards).
export function registerChangeCard(server: McpServer): RegisteredResource {
  return registerAppResource(
    server,
    "APIUniCon change confirmation",
    CHANGE_CARD_URI,
    { description: "Shows a change the assistant asked for, with its buttons." },
    async () => ({
      contents: [{
        uri: CHANGE_CARD_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: changeCardHtml(),
        // The card makes no requests of its own and loads nothing: its one call to the server goes through the host.
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } },
      }],
    }),
  );
}
