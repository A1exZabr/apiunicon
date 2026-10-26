import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

import { translate, type Locale, type MessageKey } from "../i18n/messages.js";
import type { Application } from "../index.js";
import { readCookies } from "./cookies.js";
import { escapeHtml, layout } from "./layout.js";

// The workspace's sign-in that a page whose link the assistant hands out needs, declared in its route's config. A page of
// a one-time link opens by the link's token and needs the sign-in too: "always"; "replacing_keys" for a key-entry link,
// which needs it only once its connection exists, to replace the keys (the first key entry is how a connection starts);
// or "never" for a page the browser reaches without the workspace's cookie, such as the catalog's OAuth callback.
// "workspace" is a page of the workspace itself, behind the sign-in like every other. The local server's guard reads
// it, and the sign-in returns only to a page that declares one, other than "never". A route without it is the
// workspace's own and always needs the sign-in. A hosted service puts its own sign-in in front of these pages.
export type SignInRequirement = "always" | "replacing_keys" | "never" | "workspace";

declare module "fastify" {
  interface FastifyContextConfig {
    signIn?: SignInRequirement;
  }
}

// The route options of a page that needs the sign-in always, of a key-entry page, and of one that never does.
export const SIGNED_IN = { config: { signIn: "always" } } as const;
export const SIGNED_IN_TO_REPLACE_KEYS = { config: { signIn: "replacing_keys" } } as const;
export const WITHOUT_SIGN_IN = { config: { signIn: "never" } } as const;

// How the one-time pages (key entry, confirmations) find their data and look. Locally there is one application on
// this computer; a hosted service resolves the signed-in account's application and wraps the pages in its own design.
export type OneTimePageOptions = {
  // The application that may hold the record behind the link, or null when this request may see none. The link
  // token is still checked against the returned application.
  resolveApplication(request: FastifyRequest): Promise<Application | null>;
  locale(request: FastifyRequest): Locale;
  // title is plain text; body is HTML.
  render(request: FastifyRequest, title: string, body: string): string;
  // Adds the Secure attribute to the link cookie, for pages served over HTTPS.
  secureCookies: boolean;
  // A host with a shared catalog may offer to propose the connection's adapter there before deleting the connection.
  // Both are needed for the offer. A rejection's message is shown to the person, so hosts reject with readable text.
  offerProposal?(app: Application, connectionId: string): Promise<boolean>;
  // A returned string is plain text for the person (the core escapes it): the outcome of the offer, shown as one line
  // on the deletion page. Nothing returned keeps that page as it is.
  // The locale is the page's, the same one proposalNote gets.
  propose?(app: Application, connectionId: string, locale: Locale): Promise<string | void>;
  // What the host shows under the offer checkbox, such as its terms and a link to what would be offered. HTML the host
  // has built and escaped, trusted like render's body; shown only where the checkbox is. A null, or a rejection, shows
  // no note and does not keep the page from rendering.
  proposalNote?(app: Application, connectionId: string, locale: Locale): Promise<string | null>;
};

export function localOneTimePageOptions(application: Application): OneTimePageOptions {
  return {
    resolveApplication: async () => application,
    locale: () => "en",
    render: (_request, title, body) => layout(title, body),
    secureCookies: false,
  };
}

// The token of a one-time page's form, derived from the link's token for the page's purpose: it needs no storage and is
// useless without the cookie that carries the link's token.
export function linkFormToken(purpose: string, token: string): string {
  return createHash("sha256").update(`${purpose}-csrf:${token}`).digest("base64url");
}

// Lax, not Strict: a link clicked in a web chat is a cross-site navigation, and Strict would drop the cookie on the
// redirect that follows. Lax is not sent on cross-site POSTs, and the form token covers the rest.
export function linkCookie(name: string, path: string, token: string, maxAge: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function linkToken(request: FastifyRequest, name: string): string {
  return readCookies(request)[name] ?? "";
}

export function sendPage(reply: FastifyReply, status: number, html: string): FastifyReply {
  return reply.code(status).type("text/html").send(html);
}

export function messagePage(
  options: OneTimePageOptions,
  request: FastifyRequest,
  titleKey: MessageKey,
  textKey: MessageKey,
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const locale = options.locale(request);
  const title = translate(locale, titleKey, vars);
  return options.render(
    request,
    title,
    `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(translate(locale, textKey, vars))}</p>`,
  );
}
