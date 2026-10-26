import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { contributionPreview } from "../adapters/contribution.js";
import { AdapterNotWorkingError, VersionConflictError } from "../adapters/repository.js";
import { SignInLockedError, type WebSession } from "../auth/repository.js";
import { describeArguments, spellOut } from "../changes/describe.js";
import { outcomeKeyOf, type OutcomeKey } from "../changes/outcome.js";
import type { ChangeRecord } from "../changes/repository.js";
import { flushErasedData } from "../db/database.js";
import { InputError, NotFoundError } from "../domain/types.js";
import type { Application } from "../index.js";
import { registerHttpMcpRoute } from "../mcp/http.js";
import { isLinkToken } from "../security/one-time-token.js";
import { isTunnelId } from "../tunnel/supervisor.js";
import { decodeUrlEncoded, first, parseForm } from "./forms.js";
import { registerCatalogRoutes } from "./catalog-page.js";
import { argumentList } from "./change-page.js";
import { registerConnectionDraftRoutes } from "./connection-drafts.js";
import { registerConfirmRoutes } from "./confirm-page.js";
import { registerConnectRoutes, replacing } from "./connect-page.js";
import { readCookies } from "./cookies.js";
import { escapeHtml, layout } from "./layout.js";
import { isLoopbackAddress, loopbackHosts, requestSource } from "./loopback.js";
import { localOneTimePageOptions, type SignInRequirement } from "./one-time.js";
import { registerReadApprovalRoutes } from "./reads-page.js";

const SESSION_COOKIE = "apiunicon_session";
const CSRF_COOKIE = "apiunicon_csrf";

function cookie(name: string, value: string, maxAge?: number): string {
  const age = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${age}`;
}

function setLoginCookies(reply: FastifyReply, token: string, csrfToken: string): void {
  void reply.header("set-cookie", [cookie(SESSION_COOKIE, token), cookie(CSRF_COOKIE, csrfToken)]);
}

function clearLoginCookies(reply: FastifyReply): void {
  void reply.header("set-cookie", [cookie(SESSION_COOKIE, "", 0), cookie(CSRF_COOKIE, "", 0)]);
}

function sessionFor(application: Application, request: FastifyRequest): WebSession | null {
  return application.auth.authenticate(readCookies(request)[SESSION_COOKIE] ?? "");
}

function requireCsrf(
  application: Application,
  request: FastifyRequest,
  reply: FastifyReply,
): { session: WebSession; csrfToken: string } | null {
  const requestCookies = readCookies(request);
  const session = application.auth.authenticate(requestCookies[SESSION_COOKIE] ?? "");
  const headerValue = request.headers["x-csrf-token"];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const formToken = first(parseForm(request.body), "csrf") ?? headerToken ?? "";
  const cookieToken = requestCookies[CSRF_COOKIE] ?? "";
  if (!session || !cookieToken || cookieToken !== formToken || !application.auth.verifyCsrf(session.id, formToken)) {
    void reply.code(403).type("text/plain").send("CSRF verification failed");
    return null;
  }
  return { session, csrfToken: cookieToken };
}

// The workspace's CSRF token as the browser's cookie carries it, for the forms of a signed-in page; requireCsrf checks a
// form's token against the session.
function sessionCsrfToken(request: FastifyRequest): string {
  return readCookies(request)[CSRF_COOKIE] ?? "";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The catalog's forms check where they come from themselves, and more strictly (see formAccepted in catalog-page.ts).
const CATALOG_PATH = /^\/catalog(?:\/|$)/u;

// Whether a page of a one-time link opens only for the person signed in here, as its route declares (SignInRequirement):
// the link, and the form token derived from it, are not enough on their own. A key-entry link needs the sign-in only
// once the connection exists, to replace its keys: the first key entry is how a connection starts.
function needsSignIn(application: Application, request: FastifyRequest, requirement: SignInRequirement): boolean {
  if (requirement === "always") return true;
  if (requirement !== "replacing_keys") return false;
  try {
    return replacing(application.drafts.get(routeId(request)));
  } catch (error) {
    // A link to no draft opens nothing, and its page says so.
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

function routeId(request: FastifyRequest): string {
  const { id } = request.params as { id?: unknown };
  return typeof id === "string" ? id : "";
}

// The link that was opened, read from the route rather than the raw path, which the router also matches in
// percent-encoded spellings: its page, with the link's token for a GET. For a form, the page it was sent from.
function linkOpened(request: FastifyRequest, route: string): string {
  const page = route === "/connect/:id/complete" ? `/connect/${routeId(request)}` : route.replace(":id", routeId(request));
  const { t } = request.query as { t?: unknown };
  return request.method === "GET" && typeof t === "string" ? `${page}?t=${t}` : page;
}

// A page the sign-in may return to, as its route declares it: its path with an id in place of each parameter, as its link
// or as the page behind the link's cookie.
function returnPattern(url: string): RegExp {
  const path = url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/:\w+/gu, "[0-9a-f-]{36}");
  return new RegExp(`^${path}(?:\\?t=[A-Za-z0-9_-]{43})?$`, "u");
}

// The setup token a link carries while no administrator exists (see withSetupToken), passed on to the setup page.
function setupTokenOf(value: unknown): string | null {
  return typeof value === "string" && isLinkToken(value) ? value : null;
}

function pathWith(path: string, query: Record<string, string | null>): string {
  const pairs = Object.entries(query).flatMap(([name, value]) => value === null ? [] : [`${name}=${encodeURIComponent(value)}`]);
  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}

function signInPath(next: string | null, setup: string | null = null): string {
  return pathWith("/login", { next, setup });
}

function setupPath(next: string | null, setup: string | null): string {
  return pathWith("/setup", { t: setup, next });
}

// The status of an error that Fastify or its body parsers raised for a request they could not take, which they mark
// with a client error status, or null for any other error.
function clientErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const { statusCode, validation } = error as Error & { statusCode?: unknown; validation?: unknown };
  if (validation !== undefined) return 400;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : null;
}

// How long the sign-in stays locked, rounded up, in words.
function waitText(milliseconds: number): string {
  if (milliseconds < 60_000) {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
    return seconds === 1 ? "1 second" : `${seconds} seconds`;
  }
  const minutes = Math.ceil(milliseconds / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

// How many changes the connection's page lists.
const CHANGE_LIST_LIMIT = 20;

// How a change ended, in a few words for the journal. The key is the confirmation page's own reading of the record
// (outcomeKeyOf): "failed" only where the request certainly did not take effect, "unknown" where it may have.
const OUTCOME_TEXT: Record<OutcomeKey, (httpStatus: number | null) => string> = {
  waiting: () => "Waiting for you",
  expired: () => "Expired, nothing changed",
  running: () => "Running",
  done: (httpStatus) => (httpStatus === null ? "Done" : `Done, the service answered ${httpStatus}`),
  service_error: (httpStatus) => `The service answered ${httpStatus}, most likely nothing changed`,
  not_sent: () => "Not sent, nothing changed",
  no_answer: () => "No answer in time, the change may have been made",
  not_confirmed: () => "Sent, result not confirmed",
  cancelled_by_person: () => "Cancelled by you",
  replaced: () => "Replaced by a newer request",
  cancelled_writes_off: () => "Cancelled: changing data was turned off",
  refused_plan: () => "Not done: changing data is not available",
  refused_writes_off: () => "Not done: changing data was turned off",
  refused_adapter_changed: () => "Not done: the connection changed after the request",
  refused_limit: () => "Not done: the call limit was reached",
  refused_origin: () => "Not done: the address is no longer allowed",
  refused_other: () => "Not done",
};

export function changeOutcome(record: ChangeRecord): string {
  return OUTCOME_TEXT[outcomeKeyOf(record)](record.httpStatus);
}

// Every value the change sends, in full and escaped, as the confirmation page showed it. Text that APIUniCon did not
// write has its invisible and direction characters written out.
function changeValues(record: ChangeRecord): string {
  const rows = describeArguments(record);
  return rows.length === 0 ? '<p class="muted">Nothing but the address.</p>' : argumentList(rows);
}

const CELL = 'style="text-align:left;vertical-align:top;border-top:1px solid var(--line);padding:10px 14px 10px 0"';

// How the person let a change run, when it was not on its page: the journal is where they find it afterwards.
const CONFIRMED_ELSEWHERE: Partial<Record<ChangeRecord["confirmation"], string>> = {
  // The person did not see it before it ran.
  none: " · without confirmation",
  // The person pressed "Run" in the card the chat showed.
  card: " · confirmed in the chat card",
};

function changeRow(record: ChangeRecord): string {
  const when = `${record.createdAt.slice(0, 10)} ${record.createdAt.slice(11, 16)} UTC`;
  const outcome = `${changeOutcome(record)}${CONFIRMED_ELSEWHERE[record.confirmation] ?? ""}`;
  return `<tr data-change="${escapeHtml(record.id)}"><td ${CELL}><time datetime="${escapeHtml(record.createdAt)}">${escapeHtml(when)}</time></td><td ${CELL}>${escapeHtml(spellOut(record.operation.description))}</td><td ${CELL}><code>${escapeHtml(spellOut(`${record.method} ${record.targetUrl}`))}</code><details><summary>Values</summary><div class="change">${changeValues(record)}</div></details></td><td ${CELL} data-outcome>${escapeHtml(outcome)}</td></tr>`;
}

// What confirmation of changes is for one connection: asked, turned off on its page, or off through the setting for
// every connection on the start page. The connection's own "off" is named first, since only its page turns it back.
type ConfirmationMode = "ask" | "off" | "off_everywhere";

const CONFIRMATION_STATUS: Record<ConfirmationMode, string> = {
  ask: "Ask",
  off: "Don't ask",
  off_everywhere: "Don't ask — setting for every connection",
};

// What the card says changes do now: with confirmation asked or off, and with changing data on or off. Only an action
// the person already confirmed on this connection in its current form runs at once, and then with any values, since the
// trust is in the action and not in its values; the hints must not promise more, nor less, and with changing data off
// they must not say that anything changes.
const HINTS: Record<"ask" | "off", Record<"on" | "off", string>> = {
  ask: {
    on: "Your assistant can propose changes; each one runs only after you confirm it on a page on this computer.",
    off: "Changing data is off, so your assistant cannot propose changes. If you turn it on, each change runs only after you confirm it on a page on this computer.",
  },
  off: {
    on: "Your assistant runs at once, without your confirmation, only actions you have already confirmed once on this connection in their current form, and from then on with any values. A new or changed action comes as a link to confirm on a page on this computer the first time; deletions always do.",
    off: "Changing data is off, so your assistant changes nothing through this connection. If you turn it on, your assistant will run at once, without your confirmation, only actions you have already confirmed once on this connection in their current form, and from then on with any values. A new or changed action will come as a link to confirm on a page on this computer the first time; deletions always will.",
  },
};

function changingDataHint(enabled: boolean, confirmation: ConfirmationMode, everywhere: boolean): string {
  const hint = HINTS[confirmation === "ask" ? "ask" : "off"][enabled ? "on" : "off"];
  // Off on its own page and on the start page: asking again here alone would not bring confirmation back.
  return confirmation === "off" && everywhere ? `${hint} It is also off for every connection on the start page.` : hint;
}

// A form that asks for confirmation again: one button, no warning, since it only takes a permission back.
function askAgainForm(action: string, csrf: string): string {
  return `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="required" value="1"><button type="submit">Ask for confirmation again</button></form>`;
}

// The person's switches for changing data through one connection, and the connection's latest changes. The switches
// are forms of this page alone, with the session's token: nothing the assistant can call reaches them. Confirmation goes
// off only through the warning page.
function changingDataCard(
  connectionId: string,
  enabled: boolean,
  confirmation: ConfirmationMode,
  everywhere: boolean,
  csrf: string,
  changes: ChangeRecord[],
): string {
  const switchForm = `<form method="post" action="/connections/${escapeHtml(connectionId)}/writes"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="enabled" value="${enabled ? "0" : "1"}"><button type="submit"${enabled ? ' class="secondary"' : ""}>${enabled ? "Turn off" : "Turn on"}</button></form>`;
  const warningPath = `/connections/${connectionId}/changes-confirmation`;
  const confirmationAction = confirmation === "ask"
    ? `<a class="button secondary" href="${escapeHtml(warningPath)}">Stop asking for confirmation</a>`
    : confirmation === "off"
      ? askAgainForm(warningPath, csrf)
      : '<p><a href="/#changes-confirmation">Change it on the start page</a></p>';
  const head = ["When", "Action", "Request", "Result"].map((name) => `<th ${CELL}>${name}</th>`).join("");
  const journal = changes.length === 0
    ? '<p class="muted">No changes yet.</p>'
    : `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>${head}</tr></thead><tbody>${changes.map(changeRow).join("")}</tbody></table></div>`;
  return `<section class="card" style="margin-top:22px"><h2>Changing data</h2><div class="row"><span>Status</span><span class="status">${enabled ? "On" : "Off"}</span></div><div class="row"><span>Confirmation</span><span class="status">${CONFIRMATION_STATUS[confirmation]}</span></div><p class="muted">${changingDataHint(enabled, confirmation, everywhere)}</p>${switchForm}${confirmationAction}<h2 style="margin-top:26px">Recent changes</h2>${journal}</section>`;
}

// The start page's card for the setting of every connection.
function everyConnectionCard(skipEverywhere: boolean, csrf: string): string {
  const action = skipEverywhere
    ? askAgainForm("/changes-confirmation", csrf)
    : '<a class="button secondary" href="/changes-confirmation">Stop asking for confirmation</a>';
  // Changing data is each connection's own switch, so this card speaks of the connections where it is on.
  const hint = skipEverywhere
    ? "On connections where changing data is on, your assistant runs at once, without your confirmation, only actions you have already confirmed once on that connection in their current form, and from then on with any values. A new or changed action comes as a link to confirm on a page on this computer the first time; deletions always do."
    : "By default every change waits for your confirmation on a page on this computer. Deletions always do. A connection can have its own setting on its page.";
  return `<section class="card section-gap" id="changes-confirmation"><h2>Confirming changes</h2><div class="row"><span>Every connection</span><span class="status">${skipEverywhere ? "Don't ask" : "Ask"}</span></div><p class="muted">${hint}</p>${action}</section>`;
}

// Where turning confirmation off applies: the form's address, the way back, the words for its reach, and where an action
// must have been confirmed before to run at once (the trust is a connection's own, even with the setting for every one).
type ConfirmationScope = { action: string; back: string; reach: string; confirmedOn: string };

// The warning before confirmation goes off, for one connection or for every one. Its form sends required=0 and goes
// through only with the tick; unticked, the same page comes back with the error.
function confirmationWarningPage(scope: ConfirmationScope, csrf: string, unticked: boolean): string {
  const error = unticked ? "<p class=\"error\">Tick “I understand” to stop asking for confirmation.</p>" : "";
  return layout(
    "Changes without confirmation",
    `<h1>Changes without confirmation</h1><section class="card start-card">${error}<p class="warning">Your assistant will change data in the service at once, without showing you the change and without your “Run”. The assistant's mistakes reach the service at once.</p><p>Only an action you have already confirmed ${escapeHtml(scope.confirmedOn)} once on a page on this computer, in its current form, runs at once, and from then on it runs with any values. A new action, or one your assistant has changed since, comes to you as a link to confirm the first time.</p><p>Deletions still need your confirmation on a page on this computer.</p><p>${escapeHtml(scope.reach)}</p><p class="muted">You can turn confirmation back on with one button at any time.</p><form method="post" action="${escapeHtml(scope.action)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="required" value="0"><label class="confirm"><input required type="checkbox" name="understood" value="yes"> I understand</label><button type="submit">Stop asking for confirmation</button> <a class="button secondary" href="${escapeHtml(scope.back)}">Keep confirmation</a></form></section>`,
    { csrfToken: csrf },
  );
}

// The confirmation form's fields once its token passed: required is 1 or 0, anything else is refused here.
function confirmationChoice(request: FastifyRequest, reply: FastifyReply): { required: boolean; understood: boolean } | null {
  const form = parseForm(request.body);
  const required = first(form, "required");
  if (required !== "1" && required !== "0") {
    void reply.code(400).type("text/plain").send("The setting must be 1 or 0");
    return null;
  }
  return { required: required === "1", understood: first(form, "understood") === "yes" };
}

export type HttpServerOptions = {
  // Where the server writes what it does not show on a page, such as the details of an unexpected error. Nowhere
  // without one.
  errorLog?: { write(line: string): void };
};

export function buildHttpServer(application: Application, options: HttpServerOptions = {}): FastifyInstance {
  const server = Fastify({
    logger: options.errorLog ? { level: "error", stream: options.errorLog } : false,
    bodyLimit: 128 * 1024,
  });
  server.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const encoded = typeof body === "string" ? body : body.toString("utf8");
      done(null, decodeUrlEncoded(encoded));
    },
  );
  // The uploaded tunnel-client is the one large body; its route raises the limit for itself alone.
  server.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  // Where the sign-in, and the first setup, may return: a page whose route declares the sign-in it needs (other than
  // "never"), opened as its link or as the page behind its cookie. Anything else, another site included, goes to the
  // start page. Collected as the routes are added, so it is never a list kept apart from them.
  const returnPages: RegExp[] = [];
  server.addHook("onRoute", ({ method, url, config }) => {
    const requirement = config?.signIn;
    if (requirement !== undefined && requirement !== "never" && [method].flat().includes("GET")) returnPages.push(returnPattern(url));
  });
  const returnPathOf = (value: unknown): string | null =>
    typeof value === "string" && returnPages.some((page) => page.test(value)) ? value : null;
  // The workspace page a link of the assistant leads to and the sign-in returns to, such as a connection's page, where
  // only the person turns changing data on.
  const workspaceReturn = (request: FastifyRequest): string | null =>
    request.method === "GET" && request.routeOptions.config.signIn === "workspace" && request.routeOptions.url !== undefined
      ? returnPathOf(request.routeOptions.url.replace(":id", routeId(request)))
      : null;
  // Referrer-Policy same-origin, not no-referrer: under no-referrer a browser words the Origin of a form it posts as
  // "null", which says nothing about the page, and the check below would refuse every form. Same-origin still sends
  // nothing to another site. This is the only place the local server sets it: the one-time pages leave it to the host
  // (privatePage in change-page.ts).
  server.addHook("onSend", async (_request, reply, payload) => {
    void reply
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "DENY")
      .header("referrer-policy", "same-origin")
      .header("cache-control", "no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'");
    return payload;
  });
  // Who may reach what is decided before the body is read, so a request that will be refused never has it buffered.
  const hosts = loopbackHosts(application.config.httpPort);
  server.addHook("onRequest", async (request, reply) => {
    // Whatever address the server listens on, it answers only connections from this computer.
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return reply.code(403).type("text/plain").send("Only this computer can connect");
    }
    const route = request.routeOptions.url;
    if (route === "/health") return;
    if (!hosts.has(request.headers.host?.toLocaleLowerCase("en-US") ?? "")) {
      return reply.code(421).type("text/plain").send("Loopback Host header required");
    }
    // The MCP endpoint checks its bearer token itself.
    if (route === "/mcp") return;
    const path = request.url.split("?", 1)[0] ?? "";
    // A form or a script of another site, or of another program on this computer, changes nothing here.
    if (!SAFE_METHODS.has(request.method) && !CATALOG_PATH.test(path) && requestSource(request) === "elsewhere") {
      return reply.code(403).type("text/plain").send("Cross-site request refused");
    }
    // A page of a one-time link checks its own token, and needs the sign-in as its route declares.
    const requirement = request.routeOptions.config.signIn;
    if (route !== undefined && requirement !== undefined && requirement !== "workspace") {
      if (!needsSignIn(application, request, requirement) || sessionFor(application, request)) return;
      // Back to the same link after the sign-in, and through the first setup when there is no administrator yet.
      const { setup } = request.query as { setup?: unknown };
      return reply.redirect(signInPath(returnPathOf(linkOpened(request, route)), setupTokenOf(setup)), 303);
    }
    // Every other page is the workspace's, and opens only after the sign-in.
    const { next, setup } = request.query as { next?: unknown; setup?: unknown };
    if (!application.auth.isSetup()) {
      if (route === "/setup") return;
      const back = route === "/login" ? returnPathOf(next) : workspaceReturn(request);
      return reply.redirect(setupPath(back, setupTokenOf(setup)), 303);
    }
    if (route === "/setup") return reply.redirect("/", 303);
    if (route === "/login") return;
    if (!sessionFor(application, request)) return reply.redirect(signInPath(workspaceReturn(request)), 303);
  });

  server.get("/health", async () => ({ status: "ok" }));
  registerHttpMcpRoute(server, application.mcpDependencies, application.config.mcpToken);
  registerConnectRoutes(server, localOneTimePageOptions(application));
  registerConfirmRoutes(server, localOneTimePageOptions(application));
  registerReadApprovalRoutes(server, localOneTimePageOptions(application));
  if (application.localCatalog) registerCatalogRoutes(server, application.localCatalog, localOneTimePageOptions(application));

  server.get("/assets/app.js", async (_request, reply) => reply
    .type("application/javascript; charset=utf-8")
    .send(`(() => {
  const upload = document.querySelector('[data-tunnel-upload]');
  if (upload) upload.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = upload.querySelector('input[type=file]');
    const button = upload.querySelector('button');
    if (!input || !input.files || !input.files[0]) return;
    button.disabled = true; button.textContent = 'Uploading…';
    const response = await fetch('/tunnel/binary', {
      method: 'POST', headers: {'content-type':'application/octet-stream','x-csrf-token':upload.dataset.csrf},
      body: await input.files[0].arrayBuffer()
    });
    if (!response.ok) { button.disabled = false; button.textContent = 'Upload tunnel-client'; alert(await response.text()); return; }
    location.reload();
  });
  const status = document.querySelector('[data-status-url]');
  if (status && ['starting','discovering'].includes(status.dataset.state || '')) {
    const poll = async () => {
      const response = await fetch(status.dataset.statusUrl, {headers:{accept:'application/json'}});
      if (!response.ok) return;
      const next = (await response.json()).status;
      if (next && next !== status.dataset.state) location.reload();
      else if (['starting','discovering'].includes(next)) setTimeout(poll, 1200);
    };
    setTimeout(poll, 1200);
  }
})();`));

  server.get("/api/tunnel/status", async () => application.tunnel.status());

  server.get("/tunnel", async (request, reply) => {
    const status = application.tunnel.status();
    const csrf = sessionCsrfToken(request);
    const binaryPath = join(application.config.binDir, "tunnel-client");
    let binaryReady = true;
    try { accessSync(binaryPath, constants.X_OK); } catch { binaryReady = false; }
    const events = status.events.map((event) => `<div class="row"><span>${escapeHtml(event.message)}</span><span class="muted">${escapeHtml(event.level)}</span></div>`).join("");
    const controls = status.configured
      ? `<div class="row"><span>Tunnel ID</span><code>${escapeHtml(status.tunnelId)}</code></div><div class="row"><span>Profile</span><code>${escapeHtml(status.profileName)}</code></div><form class="inline-actions" method="post" action="/tunnel/doctor"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Run doctor</button></form>${status.running ? `<form class="inline-actions" method="post" action="/tunnel/stop"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Stop tunnel</button></form>` : `<form class="inline-actions" method="post" action="/tunnel/start"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Start tunnel</button></form>`}`
      : '<p class="muted">Upload the client and enter the values from the OpenAI Platform tunnel.</p>';
    return reply.type("text/html").send(layout(
      "Secure MCP Tunnel",
      `<h1>Secure MCP Tunnel.</h1><p class="lede">Keep APIUniCon on this computer while ChatGPT reaches its loopback MCP endpoint through your developer tunnel.</p><div class="grid"><section class="card"><h2>1 · Install tunnel-client</h2><p>Download <code>tunnel-client</code> from the OpenAI Platform Tunnels page, then upload that file here.</p><form data-tunnel-upload data-csrf="${escapeHtml(csrf)}"><label>Downloaded client<input required type="file" name="binary"></label><button type="submit">Upload tunnel-client</button></form><div class="row"><span>Local binary</span><span class="status">${binaryReady ? "ready" : "missing"}</span></div><h2 style="margin-top:30px">2 · Configure</h2><form method="post" action="/tunnel/configure"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label>Tunnel ID<input required pattern="tunnel_[a-z0-9]{32}" name="tunnelId" placeholder="tunnel_…" value="${escapeHtml(status.tunnelId ?? "")}"></label><label>Runtime API key<input required type="password" autocomplete="off" name="runtimeKey" placeholder="Shown once by Platform"></label><button type="submit" ${binaryReady ? "" : "disabled"}>Seal key and initialize</button></form></section><aside class="card" data-status-url="/api/tunnel/status" data-state="${escapeHtml(status.status)}"><h2>Control</h2><div class="row"><span>Status</span><span class="status">${escapeHtml(status.status)}</span></div>${controls}</aside></div><section class="card" style="margin-top:22px"><h2>Sanitized client events</h2>${events || '<p class="muted">No events yet.</p>'}</section>`,
      { csrfToken: csrf },
    ));
  });

  server.post("/tunnel/binary", { bodyLimit: 50 * 1024 * 1024 }, async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.code(400).type("text/plain").send("A non-empty tunnel-client file is required");
    }
    mkdirSync(application.config.binDir, { recursive: true, mode: 0o700 });
    chmodSync(application.config.binDir, 0o700);
    const target = join(application.config.binDir, "tunnel-client");
    const temporary = join(application.config.binDir, `.tunnel-client-${randomUUID()}.tmp`);
    writeFileSync(temporary, request.body, { flag: "wx", mode: 0o700 });
    renameSync(temporary, target);
    chmodSync(target, 0o700);
    return reply.send({ uploaded: true });
  });

  server.post("/tunnel/configure", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    const form = parseForm(request.body);
    const tunnelId = first(form, "tunnelId")?.trim() ?? "";
    const runtimeKey = first(form, "runtimeKey") ?? "";
    if (!isTunnelId(tunnelId) || runtimeKey.length < 12) {
      return reply.code(400).type("text/plain").send("A valid tunnel ID and runtime key are required");
    }
    accessSync(join(application.config.binDir, "tunnel-client"), constants.X_OK);
    const runtimeCredentialSetId = application.tunnels.get()?.runtimeCredentialSetId ?? randomUUID();
    application.vault.storeFields(runtimeCredentialSetId, { CONTROL_PLANE_API_KEY: runtimeKey });
    // A new key overwrites the previous one, whose old page stays in the journal until it is flushed.
    flushErasedData(application.db);
    await application.tunnel.configure({ tunnelId, runtimeCredentialSetId, profileName: "apiunicon-local" });
    return reply.redirect("/tunnel", 303);
  });

  for (const action of ["doctor", "start", "stop"] as const) {
    server.post(`/tunnel/${action}`, async (request, reply) => {
      if (!requireCsrf(application, request, reply)) return;
      await application.tunnel[action]();
      return reply.redirect("/tunnel", 303);
    });
  }

  // The administrator is created only with the setup token (see SetupToken). Without it the page says where the link is.
  const setupLinkNeeded = (reply: FastifyReply): FastifyReply => reply.code(403).type("text/html").send(layout(
    "First-run setup",
    '<section class="card auth-card"><span class="status">One-time setup</span><h1>Open the setup link</h1><p class="lede">The local administrator is created only from the setup link this computer printed, so that no other page can create it first.</p><p>Find the link in the terminal where you ran <code>npm run dev</code> or <code>npm run service:install</code>, or in <code>~/.apiunicon/logs/service.out.log</code>. <code>npm run --silent setup-link</code> in the project folder prints it again. A link from your assistant to a page that needs the password leads through it too.</p></section>',
    { compact: true },
  ));
  const setupProblem = (reply: FastifyReply, problem: string, token: string, next: string | null): FastifyReply =>
    reply.code(400).type("text/html").send(layout(
      "First-run setup",
      `<section class="card auth-card"><p class="error">${escapeHtml(problem)}</p><a href="${escapeHtml(setupPath(next, token))}">Return to setup</a></section>`,
      { compact: true },
    ));

  server.get<{ Querystring: { t?: unknown; next?: unknown } }>("/setup", async (request, reply) => {
    const token = request.query.t;
    if (typeof token !== "string" || application.setupToken?.matches(token) !== true) return setupLinkNeeded(reply);
    const next = returnPathOf(request.query.next);
    const back = next === null
      ? ""
      : `<p class="muted">Then the page from your assistant's link opens.</p><input type="hidden" name="next" value="${escapeHtml(next)}">`;
    return reply.type("text/html").send(layout(
      "First-run setup",
      `<section class="card auth-card"><span class="status">One-time setup</span><h1>Create local administrator</h1><p class="lede">This password protects the workspace on this computer. API credentials will be sealed separately in the encrypted vault.</p><form method="post" action="/setup"><input type="hidden" name="t" value="${escapeHtml(token)}">${back}<label>Password<input required minlength="12" type="password" autocomplete="new-password" name="password"></label><label>Confirm password<input required minlength="12" type="password" autocomplete="new-password" name="confirmPassword"></label><button type="submit">Create administrator</button></form></section>`,
      { compact: true },
    ));
  });

  server.post("/setup", async (request, reply) => {
    const form = parseForm(request.body);
    const token = first(form, "t") ?? "";
    const next = returnPathOf(first(form, "next"));
    if (application.setupToken?.matches(token) !== true) return setupLinkNeeded(reply);
    const password = first(form, "password") ?? "";
    const confirmation = first(form, "confirmPassword") ?? "";
    if (password !== confirmation) return setupProblem(reply, "Passwords do not match.", token, next);
    if (password.length < 12) return setupProblem(reply, "The password needs at least 12 characters.", token, next);
    // Spent before the password is stored, so a second setup sent with the same token at the same moment is refused.
    if (!application.setupToken.take(token)) return setupLinkNeeded(reply);
    await application.auth.setup(password);
    const login = await application.auth.login(password);
    setLoginCookies(reply, login.token, login.csrfToken);
    return reply.redirect(next ?? "/", 303);
  });

  server.get<{ Querystring: { next?: unknown } }>("/login", async (request, reply) => {
    const next = returnPathOf(request.query.next);
    // Signed in already, for example in another tab: straight back to the link.
    if (next !== null && sessionFor(application, request)) return reply.redirect(next, 303);
    const back = next === null
      ? ""
      : `<p class="muted">Then the page from your assistant's link opens.</p><input type="hidden" name="next" value="${escapeHtml(next)}">`;
    return reply.type("text/html").send(layout(
      "Unlock",
      `<section class="card auth-card"><span class="status">Local access</span><h1>Unlock the workspace</h1><p class="lede">Use the administrator password created on this computer.</p><form method="post" action="/login">${back}<label>Password<input required type="password" autocomplete="current-password" name="password"></label><button type="submit">Unlock</button></form></section>`,
      { compact: true },
    ));
  });

  server.post("/login", async (request, reply) => {
    const form = parseForm(request.body);
    const password = first(form, "password") ?? "";
    const next = returnPathOf(first(form, "next"));
    try {
      const login = await application.auth.login(password);
      setLoginCookies(reply, login.token, login.csrfToken);
      return reply.redirect(next ?? "/", 303);
    } catch (error) {
      const locked = error instanceof SignInLockedError;
      const problem = locked
        ? `Too many wrong passwords. Try again in ${waitText(error.retryAfterMs)}.`
        : "Password was not accepted.";
      return reply.code(locked ? 429 : 401).type("text/html").send(layout(
        "Unlock",
        `<section class="card auth-card"><p class="error">${escapeHtml(problem)}</p><a href="${escapeHtml(signInPath(next))}">Try again</a></section>`,
        { compact: true },
      ));
    }
  });

  // Locking the workspace signs out every browser that is signed in, not only this one.
  server.post("/logout", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    application.auth.endAllSessions();
    clearLoginCookies(reply);
    return reply.redirect("/login", 303);
  });

  registerConnectionDraftRoutes(server, application, {
    requireCsrf: (request, reply) => requireCsrf(application, request, reply),
    sessionCsrfToken,
  });

  server.get("/", async (request, reply) => {
    const csrf = sessionCsrfToken(request);
    const items = application.connections.listConnections().map(
      (connection) => `<div class="row"><div><a href="/connections/${escapeHtml(connection.id)}"><strong>${escapeHtml(connection.label)}</strong></a><div class="muted"><code>${escapeHtml(connection.id)}</code></div></div><span class="status">${connection.adapterId ? "adapter bound" : "needs adapter"}</span></div>`,
    ).join("");
    return reply.type("text/html").send(layout(
      "Workspace",
      `<h1>Your API workspace.</h1><p class="lede">Start with the service’s documentation. APIUniCon finds the safe API route and asks only for the secret values it needs.</p><div class="hero-actions"><a class="button" href="/connections/new">Connect an API</a><a class="button secondary" href="/tunnel">Configure Secure MCP Tunnel</a></div><div class="grid dashboard-grid"><section class="card"><h2>Connections</h2><div class="rows">${items || '<p class="muted">No connections yet. Add the first one from its documentation.</p>'}</div></section><aside class="card"><h2>What happens automatically</h2><div class="rail"><div class="rail-step"><strong>Read the guide</strong><small>Only the documentation site is visited</small></div><div class="rail-step"><strong>Find the destination</strong><small>You confirm the API domain</small></div><div class="rail-step"><strong>Seal the keys</strong><small>Values stay in the local Vault</small></div><div class="rail-step"><strong>Connect ChatGPT</strong><small>Through your private MCP tunnel</small></div></div></aside></div>${everyConnectionCard(application.changes.skipsConfirmationEverywhere(), csrf)}`,
      { csrfToken: csrf },
    ));
  });

  server.post<{ Params: { id: string } }>("/connections/:id/retry-crawl", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    const connection = application.connections.getConnection(request.params.id);
    const source = application.connections.getDocumentationSource(connection.documentationSourceId);
    if (source.status !== "failed") {
      return reply.code(409).type("text/plain").send("Documentation crawl is not in a failed state");
    }
    application.jobs.enqueue("crawl_documentation", source.id);
    application.jobRunner.wake();
    return reply.redirect(`/connections/${connection.id}`, 303);
  });

  server.get<{ Params: { id: string } }>("/connections/:id", { config: { signIn: "workspace" } }, async (request, reply) => {
    const connection = application.connections.getConnection(request.params.id);
    const source = application.connections.getDocumentationSource(connection.documentationSourceId);
    const crawlJob = application.jobs.latest("crawl_documentation", source.id);
    const adapter = connection.adapterId ? application.adapters.get(connection.adapterId) : null;
    const csrf = sessionCsrfToken(request);
    const credentialRows = connection.credentials.map(
      ({ fieldName }) => `<div class="row"><span>${escapeHtml(fieldName)}</span><span class="status">Configured</span></div>`,
    ).join("");
    const auditRows = application.audits.recent(connection.id, 10).map(
      (audit) => `<div class="row"><span><code>${escapeHtml(audit.operationId)}</code> · ${escapeHtml(audit.outcome)}</span><span class="muted">${escapeHtml(audit.httpStatus ?? audit.errorCategory ?? "no status")}</span></div>`,
    ).join("");
    const adapterBlock = adapter
      ? `<div class="row"><a href="/adapters/${escapeHtml(adapter.id)}">${escapeHtml(adapter.displayName)} · v${adapter.version}</a><span class="status">${escapeHtml(adapter.status)} / ${escapeHtml(adapter.visibility)}</span></div>`
      : '<p class="muted">The model has not created an adapter for this connection yet.</p>';
    const reusableMatches = connection.adapterId ? [] : application.adapters.search("").filter(
      (candidate) => candidate.status === "working" &&
        candidate.visibility === "reusable" &&
        candidate.dsl.baseOrigins.every((origin) => connection.allowedOrigins.includes(origin)),
    );
    const matchBlock = reusableMatches.length === 0 ? "" : `<section class="card" style="margin-top:22px"><h2>Reusable match</h2><p class="muted">Bind a proven adapter without another documentation research cycle.</p>${reusableMatches.map((candidate) => `<div class="row"><a href="/adapters/${escapeHtml(candidate.id)}">${escapeHtml(candidate.displayName)} · v${candidate.version}</a><form method="post" action="/connections/${escapeHtml(connection.id)}/bind-adapter"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="adapterId" value="${escapeHtml(candidate.id)}"><button type="submit">Bind adapter</button></form></div>`).join("")}</section>`;
    const everywhere = application.changes.skipsConfirmationEverywhere();
    const confirmation: ConfirmationMode = !connection.confirmChanges ? "off" : everywhere ? "off_everywhere" : "ask";
    const changesCard = changingDataCard(
      connection.id,
      connection.writesEnabled,
      confirmation,
      everywhere,
      csrf,
      application.changes.list({ connectionId: connection.id, limit: CHANGE_LIST_LIMIT }),
    );
    return reply.type("text/html").send(layout(
      connection.label,
      `<h1>${escapeHtml(connection.label)}</h1><p class="lede"><code>${escapeHtml(connection.id)}</code></p><div class="grid"><section class="card"><h2>Connection</h2><div class="row"><span>Documentation</span><span class="status">${escapeHtml(source.status)}</span></div><div class="row"><span>Crawl job</span><span class="status">${escapeHtml(crawlJob?.status ?? "not queued")}</span></div>${source.status === "failed" ? `<form method="post" action="/connections/${escapeHtml(connection.id)}/retry-crawl"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Retry documentation crawl</button></form>` : ""}<div class="row"><span>Allowed origins</span><code>${escapeHtml(connection.allowedOrigins.join(", "))}</code></div><h2 style="margin-top:26px">Sealed credentials</h2>${credentialRows}</section><aside class="card"><h2>Adapter</h2>${adapterBlock}</aside></div>${matchBlock}${changesCard}<section class="card" style="margin-top:22px"><h2>Sanitized execution evidence</h2>${auditRows || '<p class="muted">No executions yet.</p>'}</section>`,
      { csrfToken: csrf },
    ));
  });

  server.post<{ Params: { id: string } }>("/connections/:id/bind-adapter", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    const connection = application.connections.getConnection(request.params.id);
    const adapterId = first(parseForm(request.body), "adapterId") ?? "";
    const adapter = application.adapters.get(adapterId);
    if (adapter.status !== "working" || adapter.visibility !== "reusable") {
      return reply.code(409).type("text/plain").send("Only a reusable working adapter can be bound");
    }
    if (!adapter.dsl.baseOrigins.every((origin) => connection.allowedOrigins.includes(origin))) {
      return reply.code(409).type("text/plain").send("Connection does not approve every adapter origin");
    }
    application.connections.replaceAdapter(connection.id, adapter.id);
    return reply.redirect(`/connections/${connection.id}`, 303);
  });

  // Only the person turns changing data on, here, with the session's token. Turning it off also cancels what waits.
  server.post<{ Params: { id: string } }>("/connections/:id/writes", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    const enabled = first(parseForm(request.body), "enabled");
    if (enabled !== "1" && enabled !== "0") {
      return reply.code(400).type("text/plain").send("The switch must be 1 or 0");
    }
    const connection = application.connections.getConnection(request.params.id);
    application.changes.setWrites(connection.id, enabled === "1");
    return reply.redirect(`/connections/${connection.id}`, 303);
  });

  // Only the person turns confirmation of changes off, here: after the warning, with the tick and the session's token.
  // Asking again is one button. No tool of the assistant reaches these forms, and a GET only shows the warning. The
  // connection's name is the assistant's words, so its invisible and direction characters are written out, as in the journal.
  const connectionScope = (connection: { id: string; label: string }): ConfirmationScope => ({
    action: `/connections/${connection.id}/changes-confirmation`,
    back: `/connections/${connection.id}`,
    reach: `This is for the connection “${spellOut(connection.label)}” only.`,
    confirmedOn: "on this connection",
  });
  const everyConnection: ConfirmationScope = {
    action: "/changes-confirmation",
    back: "/",
    reach: "This is for every connection, new ones too.",
    confirmedOn: "on the same connection",
  };

  server.get<{ Params: { id: string } }>("/connections/:id/changes-confirmation", async (request, reply) => {
    const connection = application.connections.getConnection(request.params.id);
    return reply.type("text/html").send(confirmationWarningPage(connectionScope(connection), sessionCsrfToken(request), false));
  });

  server.post<{ Params: { id: string } }>("/connections/:id/changes-confirmation", async (request, reply) => {
    const verified = requireCsrf(application, request, reply);
    if (!verified) return;
    const choice = confirmationChoice(request, reply);
    if (!choice) return;
    const connection = application.connections.getConnection(request.params.id);
    if (!choice.required && !choice.understood) {
      return reply.code(400).type("text/html").send(confirmationWarningPage(connectionScope(connection), verified.csrfToken, true));
    }
    application.changes.setConfirmChanges(connection.id, choice.required);
    return reply.redirect(`/connections/${connection.id}`, 303);
  });

  server.get("/changes-confirmation", async (request, reply) => reply
    .type("text/html")
    .send(confirmationWarningPage(everyConnection, sessionCsrfToken(request), false)));

  server.post("/changes-confirmation", async (request, reply) => {
    const verified = requireCsrf(application, request, reply);
    if (!verified) return;
    const choice = confirmationChoice(request, reply);
    if (!choice) return;
    if (!choice.required && !choice.understood) {
      return reply.code(400).type("text/html").send(confirmationWarningPage(everyConnection, verified.csrfToken, true));
    }
    application.changes.setSkipConfirmationEverywhere(!choice.required);
    return reply.redirect("/", 303);
  });

  server.get<{ Params: { id: string } }>("/adapters/:id", async (request, reply) => {
    const adapter = application.adapters.get(request.params.id);
    const preview = contributionPreview(application.db, adapter);
    const csrf = sessionCsrfToken(request);
    const previewJson = JSON.stringify(preview, null, 2);
    const contributionForm = adapter.status === "working" && adapter.visibility === "private"
      ? `<form method="post" action="/adapters/${escapeHtml(adapter.id)}/mark-reusable"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="expectedVersion" value="${adapter.version}"><label class="confirm"><input required type="checkbox" name="confirmContribution" value="yes"> I reviewed this sanitized preview and want to make the adapter reusable locally.</label><button type="submit">Confirm reusable adapter</button></form>`
      : `<p class="muted">This adapter is ${escapeHtml(adapter.visibility)} and ${escapeHtml(adapter.status)}.</p>`;
    return reply.type("text/html").send(layout(
      adapter.displayName,
      `<h1>${escapeHtml(adapter.displayName)}</h1><p class="lede"><code>${escapeHtml(adapter.slug)}</code> · version ${adapter.version}</p><div class="grid"><section class="card"><h2>Constrained adapter DSL</h2><pre>${escapeHtml(JSON.stringify(adapter.dsl, null, 2))}</pre></section><aside class="card"><h2>Readiness</h2><div class="row"><span>Status</span><span class="status">${escapeHtml(adapter.status)}</span></div><div class="row"><span>Visibility</span><span class="status">${escapeHtml(adapter.visibility)}</span></div><div class="row"><span>Tests</span><strong>${preview.testOutcomes.length}</strong></div><div class="row"><span>Learnings</span><strong>${preview.knowledgeEvents.length}</strong></div></aside></div><section class="card" style="margin-top:22px"><h2>Contribution preview</h2><p class="muted">Credential values, connection labels, account/customer data, response bodies, request history, and conversation content are excluded.</p><pre>${escapeHtml(previewJson)}</pre>${contributionForm}</section>`,
      { csrfToken: csrf },
    ));
  });

  server.post<{ Params: { id: string } }>("/adapters/:id/mark-reusable", async (request, reply) => {
    if (!requireCsrf(application, request, reply)) return;
    const form = parseForm(request.body);
    if (first(form, "confirmContribution") !== "yes") {
      return reply.code(400).type("text/plain").send("Contribution preview confirmation is required");
    }
    const expectedVersion = Number(first(form, "expectedVersion"));
    try {
      const adapter = application.adapters.markReusable(request.params.id, expectedVersion);
      const connection = application.connections.listConnections().find(({ adapterId }) => adapterId === adapter.id);
      return reply.redirect(connection ? `/connections/${connection.id}` : "/", 303);
    } catch (error) {
      // Only what the person can act on is said here: the adapter does not work yet, or it changed after the page
      // opened. Anything else goes to the error handler, which logs it and shows no details.
      if (error instanceof AdapterNotWorkingError || error instanceof VersionConflictError) {
        return reply.code(409).type("text/plain").send(error.message);
      }
      throw error;
    }
  });

  // A page shows only what is meant for it. Fastify's own refusals of a request it could not take (a failed validation, a
  // body too large or of an unknown type) keep their status and words. Anything else may carry a file path or a
  // database message, so the page says only that it failed, and the details go to the server's log.
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof NotFoundError) return reply.code(404).type("text/plain").send("Not found");
    // A mistake in what the person sent, such as a documentation link over http://: its message says what to change.
    if (error instanceof InputError) return reply.code(400).type("text/plain").send(error.message);
    const status = clientErrorStatus(error);
    if (status !== null) return reply.code(status).type("text/plain").send((error as Error).message);
    request.log.error({ err: error }, "request failed");
    return reply.code(500).type("text/plain").send("Something went wrong. The details are in the APIUniCon log.");
  });
  return server;
}
