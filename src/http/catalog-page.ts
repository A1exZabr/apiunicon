import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { LocalCatalog } from "../catalog/local.js";
import {
  CATALOG_SIGN_IN_TTL_MS,
  CatalogRefusedError,
  CatalogSignInExpiredError,
  CatalogSignInInterruptedError,
  type CatalogSignOut,
} from "../catalog/oauth.js";
import { translate, type MessageKey } from "../i18n/messages.js";
import { readCookies } from "./cookies.js";
import { first, parseForm } from "./forms.js";
import { escapeHtml } from "./layout.js";
import { requestSource } from "./loopback.js";
import { linkFormToken, sendPage, SIGNED_IN, WITHOUT_SIGN_IN, type OneTimePageOptions } from "./one-time.js";

const COOKIE = "apiunicon_catalog";
// The state of the sign-in this browser started, for the cloud's answer to come back to.
const SIGN_IN_COOKIE = "apiunicon_catalog_sign_in";
const CALLBACK_PATH = "/catalog/callback";
// How long the catalog page's forms keep working after the page was opened.
const FORM_COOKIE_SECONDS = 1_800;
const PURPOSE = "catalog";
const SIGNED_OUT: Record<CatalogSignOut, MessageKey> = {
  revoked: "catalog.signedOut.text",
  refused: "catalog.signedOut.refused",
  not_answered: "catalog.signedOut.offline",
  not_asked: "catalog.signedOut.local",
};

// The form token pairs with a cookie this page sets. Strict is enough here: the forms post from this page itself.
function formCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/catalog; HttpOnly; SameSite=Strict; Max-Age=${FORM_COOKIE_SECONDS}${secure ? "; Secure" : ""}`;
}

// Lax, unlike the form cookie: the cloud's answer arrives as a navigation from the cloud's page, another site, and a
// Strict cookie would stay behind. It goes only to the callback, and a sign-in's state is good for as long as the
// sign-in itself.
function signInCookie(state: string, maxAge: number, secure: boolean): string {
  return `${SIGN_IN_COOKIE}=${encodeURIComponent(state)}; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Whether the cloud's answer came back to the browser that started this sign-in: its state is the one in that
// browser's cookie. Compared in constant time.
function startedHere(request: FastifyRequest, state: string): boolean {
  const kept = readCookies(request)[SIGN_IN_COOKIE] ?? "";
  if (kept === "" || state === "") return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(kept), digest(state));
}

// Cookies do not tell ports apart, so another program on 127.0.0.1 could plant the cookie and post the matching form
// token. The browser's own word that the form comes from this very page closes that: a request that says nothing about
// where it comes from is refused here too, unlike on the workspace's other forms.
function formAccepted(request: FastifyRequest): boolean {
  const token = readCookies(request)[COOKIE] ?? "";
  return requestSource(request) === "this_server" && token !== "" && first(parseForm(request.body), "csrf") === linkFormToken(PURPOSE, token);
}

// The local catalog page and the sign-in round trip. The server lets these addresses answer on the loopback host only.
// The page, its forms and the start of a sign-in need the workspace's sign-in; the cloud's answer comes back without the
// workspace's Strict cookie, so it is taken only with the Lax cookie of the sign-in this browser started.
export function registerCatalogRoutes(server: FastifyInstance, catalog: LocalCatalog, options: OneTimePageOptions): void {
  const message = (request: FastifyRequest, titleKey: MessageKey, textKey: MessageKey): string => {
    const locale = options.locale(request);
    const title = translate(locale, titleKey);
    return options.render(
      request,
      title,
      `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(translate(locale, textKey))}</p><p><a href="/catalog">${escapeHtml(translate(locale, "catalog.pageTitle"))}</a></p>`,
    );
  };

  const formExpired = (request: FastifyRequest): string => message(request, "catalog.formExpired.title", "catalog.formExpired.text");

  const status = (request: FastifyRequest, token: string): string => {
    const locale = options.locale(request);
    const text = (key: MessageKey, vars: Readonly<Record<string, string>> = {}) => escapeHtml(translate(locale, key, vars));
    const csrf = `<input type="hidden" name="csrf" value="${escapeHtml(linkFormToken(PURPOSE, token))}">`;
    const signedIn = catalog.session.signedIn();
    const disabled = catalog.session.disabled();
    const state = `<p>${text(signedIn ? "catalog.state.signedIn" : "catalog.state.signedOut")}</p>${disabled ? `<p class="warning">${text("catalog.state.disabled")}</p>` : ""}`;
    // Signing in leaves for the cloud, so it is a link: a form would be held to the page's form-action 'self'.
    const account = signedIn
      ? `<form method="post" action="/catalog/sign-out">${csrf}<button type="submit">${text("catalog.signOut")}</button></form>`
      : `<a class="button" href="/catalog/connect">${text("catalog.signIn")}</a>`;
    const use = `<form method="post" action="/catalog/use">${csrf}<input type="hidden" name="use" value="${disabled ? "yes" : "no"}"><button class="secondary" type="submit">${text(disabled ? "catalog.enable" : "catalog.disable")}</button></form>`;
    const title = translate(locale, "catalog.pageTitle");
    return options.render(
      request,
      title,
      `<h1>${escapeHtml(title)}</h1><p class="lede">${text("catalog.lede", { host: new URL(catalog.origin).host })}</p><section class="card">${state}${account}${use}</section>`,
    );
  };

  server.get("/catalog/connect", SIGNED_IN, async (request, reply) => {
    // Registering this computer with the cloud is the person's act, made by opening the link as a page. Another site
    // can load it as an image or a script, and a browser says so in Sec-Fetch-Dest; one that says nothing is let by.
    const dest = request.headers["sec-fetch-dest"];
    if (dest !== undefined && dest !== "document") return sendPage(reply, 403, formExpired(request));
    let target: string;
    try {
      target = await catalog.oauth.start();
    } catch (error) {
      request.log.error({ err: error }, "catalog registration failed");
      return sendPage(reply, 502, message(request, "catalog.unreachable.title", "catalog.unreachable.text"));
    }
    const state = new URL(target).searchParams.get("state") ?? "";
    return reply
      .header("set-cookie", signInCookie(state, CATALOG_SIGN_IN_TTL_MS / 1_000, options.secureCookies))
      .redirect(target, 302);
  });

  server.get<{ Querystring: Record<string, unknown> }>(CALLBACK_PATH, WITHOUT_SIGN_IN, async (request, reply) => {
    const { code, state, error } = request.query;
    // The answer is for one sign-in, whatever it says.
    void reply.header("set-cookie", signInCookie("", 0, options.secureCookies));
    const bound = typeof state === "string" && startedHere(request, state);
    // The person declined on the cloud's consent page: that sign-in is over.
    if (bound && typeof state === "string" && error !== undefined) catalog.oauth.forget(state);
    if (error !== undefined || typeof code !== "string" || typeof state !== "string") {
      return sendPage(reply, 400, message(request, "catalog.refused.title", "catalog.refused.text"));
    }
    // An answer that reaches another browser, or a program that has no cookie of this sign-in, signs nothing in.
    if (!bound) return sendPage(reply, 400, message(request, "catalog.expired.title", "catalog.expired.text"));
    try {
      await catalog.oauth.finish(code, state);
    } catch (failure) {
      if (failure instanceof CatalogSignInExpiredError) {
        return sendPage(reply, 400, message(request, "catalog.expired.title", "catalog.expired.text"));
      }
      if (failure instanceof CatalogSignInInterruptedError) {
        return sendPage(reply, 409, message(request, "catalog.interrupted.title", "catalog.interrupted.text"));
      }
      if (failure instanceof CatalogRefusedError) {
        return sendPage(reply, 400, message(request, "catalog.refused.title", "catalog.refused.text"));
      }
      request.log.error({ err: failure }, "catalog sign-in failed");
      return sendPage(reply, 502, message(request, "catalog.unreachable.title", "catalog.unreachable.text"));
    }
    return sendPage(reply, 200, message(request, "catalog.done.title", "catalog.done.text"));
  });

  server.get("/catalog", SIGNED_IN, async (request, reply) => {
    const token = randomBytes(24).toString("base64url");
    return sendPage(reply.header("set-cookie", formCookie(token, options.secureCookies)), 200, status(request, token));
  });

  server.post("/catalog/sign-out", SIGNED_IN, async (request, reply) => {
    if (!formAccepted(request)) return sendPage(reply, 403, formExpired(request));
    const signedOut = await catalog.oauth.signOut();
    return sendPage(reply, 200, message(request, "catalog.signedOut.title", SIGNED_OUT[signedOut]));
  });

  server.post("/catalog/use", SIGNED_IN, async (request, reply) => {
    if (!formAccepted(request)) return sendPage(reply, 403, formExpired(request));
    catalog.session.setDisabled(first(parseForm(request.body), "use") !== "yes");
    return reply.redirect("/catalog", 303);
  });
}
