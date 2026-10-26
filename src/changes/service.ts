import { canonicalJson } from "../adapters/canonical.js";
import type { AdapterRecord, AdapterRepository } from "../adapters/repository.js";
import { effectiveRisk } from "../adapters/risk.js";
import { withSetupToken } from "../auth/setup-token.js";
import type { AdapterOperation } from "../adapters/schema.js";
import type { ConnectionRecord, ConnectionRepository } from "../connections/repository.js";
import { NotFoundError } from "../domain/types.js";
import { formatMinutes } from "../i18n/messages.js";
import {
  AdapterChangedError,
  fetchStartedOf,
  noticeOf,
  prepareCall,
  WriteOperationError,
  type AdapterRuntime,
  type RuntimeResult,
} from "../runtime/runtime.js";
import { containsSecret, errorDetail } from "../security/error-detail.js";
import { NetworkPolicyError, RedirectBlockedError, ResponseByteLimitError } from "../security/network-policy.js";
import { UsageLimitError, WritesNotAllowedError } from "../usage/gate.js";
import type { Vault } from "../vault/vault.js";
import type { WritePolicy } from "./policy.js";
import {
  CHANGE_LINK_TTL_MS,
  type ChangeConfirmation,
  type ChangeOutcome,
  type ChangeReason,
  type ChangeRecord,
  type ChangeRequestRepository,
  type ChangeStatus,
} from "./repository.js";
import type { ChangeSettings } from "./settings.js";

// Waiting changes per connection: enough for a batch of edits, few enough that links do not pile up unread.
export const MAX_PENDING_CHANGES = 10;
// Requests per connection in an hour, in whatever state they ended: a cancelled or replaced one is still a row in the
// journal for a year, so an assistant that keeps asking cannot grow it without bound.
export const MAX_CHANGES_PER_HOUR = 30;
const CHANGE_WINDOW_MS = 60 * 60_000;
// The operation as the person is shown it is stored with every change; an adapter's operation may carry many described
// parameters, so its JSON is capped too.
export const MAX_CHANGE_OPERATION_BYTES = 65_536;
// The page shows every value in full, and more than this cannot be read on a screen.
export const MAX_CHANGE_ARGS_BYTES = 16_384;
export const MAX_CHANGE_SUMMARY = 500;

export type RequestChangeInput = {
  connectionId: string;
  operationId: string;
  args: Record<string, unknown>;
  // The assistant's own words for the person: what will change and what they asked for.
  summary: string;
  // Where the confirmation page is served: the key-entry base of this process.
  baseUrl: string;
  // Which assistant asked, as the host knows it ("Claude", "ChatGPT", "Claude Code"), or null, or a hook that says it.
  // Without one, the service's own hook is asked, and without that nobody is named.
  requestedVia?: string | null | RequestedVia;
};

// Which assistant asks for a change, as the host knows it, or null. Asked only when a change is requested, so a host
// that has to look the name up does it for that call alone.
export type RequestedVia = () => Promise<string | null> | string | null;

// The mode in effect for a connection: "off" when the person turned confirmation off for it or for every connection.
export type ChangesConfirmation = "required" | "off";

// A link for the person, a refusal before anything was stored, or, with confirmation off, a write that already ran.
// ranAtOnce tells the two refusals apart.
export type RequestChangeResult =
  | {
    status: "pending";
    changeId: string;
    risk: "write" | "destructive";
    confirmation: { url: string; expiresAt: string };
    // With confirmation off, why this write still needs the page.
    notice?: string;
    nextStep: string;
  }
  | { status: "refused"; reason: "plan" | "writes_off"; nextStep: string }
  | RanChange;

export type ChangeView = {
  changeId: string;
  status: ChangeStatus;
  // Only for a change let through without confirmation, so the assistant knows the person did not see it.
  changesConfirmation?: "off";
  connectionId: string;
  operationId: string;
  summary: string;
  createdAt: string;
  decidedAt: string | null;
  finishedAt: string | null;
  reason?: ChangeReason;
  // The service's sanitized answer, for a change that succeeded or failed. Null once it was erased, an hour after the end.
  result?: RuntimeResult | null;
  notice?: string;
  nextStep: string;
};

// A write the request ran at once because the person turned confirmation off: how it ended, as get_change tells it.
export type RanChange = Omit<ChangeView, "status" | "changesConfirmation"> & {
  status: "succeeded" | "failed" | "unknown" | "refused";
  changesConfirmation: "off";
};

// Whether the request stored a change that ran at once, or was refused as it was about to run, rather than refusing
// before anything was stored. Both answers can say "refused"; only the first has a changeId and changesConfirmation, so
// a host that wraps request_change narrows on this, not on the status.
export function ranAtOnce(result: RequestChangeResult): result is RanChange {
  return result.status !== "pending" && "changesConfirmation" in result;
}

// grantsStanding: whether the person's "Run" also lets this action run at once from then on, with any values: confirmation
// is off for the connection, and the person has not yet confirmed this write there in its current form.
export type PageState = { record: ChangeRecord; blocked: "plan" | "writes_off" | null; firstTime: boolean; grantsStanding: boolean };

// final_step: the first of the two confirmations of a destructive change was taken, and the page asks again.
export type Decision = { kind: "final_step" } | { kind: "decided"; record: ChangeRecord };

// What the chat card gets for a request: for a change that waits, the card's own token and what the page shows; for a
// write that ran at once, or was refused as it was about to run, the change as it ended; for a refusal before anything
// was stored, the reason.
export type CardGrant =
  | { kind: "confirm"; cardToken: string; state: PageState }
  | { kind: "ran"; record: ChangeRecord }
  | { kind: "refused"; reason: "plan" | "writes_off" };

// result is the assistant's answer and never holds the card's token; card is for the chat card alone.
export type RequestChangeAnswer = { result: RequestChangeResult; card: CardGrant };
// The same request where no chat card shows it: no card token was made for it.
export type CardlessAnswer = { result: RequestChangeResult; card: null };

// What a press in the chat card did. decided: the press decided the change; page_only: a deletion, or a write whose
// "Run" would let it run at once from then on, left as it was for its page; rejected: the token did not fit or the
// change no longer waits, with where it stands now (null: unknown).
export type CardDecision =
  | { kind: "decided"; record: ChangeRecord }
  | { kind: "page_only"; record: ChangeRecord }
  | { kind: "rejected"; record: ChangeRecord | null };

// How a change ended, after the person confirmed it, or right after the request when confirmation is off, for a host
// that looks after broken connectors. The connection's label and the assistant are as the change recorded them. No
// argument values are in it, and no answer of a successful change.
export type ChangeFinishedEvent = {
  changeId: string;
  connectionId: string;
  connectionLabel: string;
  adapterId: string;
  adapterVersion: number;
  operationId: string;
  status: "succeeded" | "failed" | "unknown";
  httpStatus: number | null;
  // The change's errorCategory; null for a success.
  kind: string | null;
  // For failed and unknown only: the service's error answer or the error's message, with the connection's key values
  // masked (errorDetail). null when there is none or the keys could not be read to mask it.
  detail: string | null;
  requestedVia: string | null;
};

export type ChangeFinishedObserver = (event: ChangeFinishedEvent) => void;

export type ChangeServiceDependencies = {
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  vault: Vault;
  runtime: AdapterRuntime;
  changes: ChangeRequestRepository;
  // The person's account-wide setting for confirming changes.
  settings: ChangeSettings;
  writes: WritePolicy;
  // The host's hook for requests that do not name the assistant themselves.
  requestedVia?: RequestedVia;
  // Hears how every change that ran ended, after the person confirmed it, or right after the request when confirmation
  // is off. A refusal, a cancellation or an expired link ran nothing and is not told: a plan without writes or a switch
  // turned off is not a broken connector. It is called once the outcome is stored, and one that throws or rejects
  // changes nothing for the person. It runs on the answer path of the person or the assistant, synchronously, so it
  // must not wait for anything slow.
  onChangeFinished?: ChangeFinishedObserver;
  // The local version's setup token while no administrator exists, or null: the links to pages behind the sign-in
  // carry it (see withSetupToken).
  setupToken?: () => string | null;
};

const NEXT_STEP: Record<Exclude<ChangeStatus, "refused">, string> = {
  pending: "The person has not decided yet. Wait until they say they are done, then call get_change again.",
  running: "The change is running. Call get_change again in a moment.",
  succeeded: "The change is made. Tell the person in plain words what the service answered.",
  failed:
    "The service answered with an error, or the request did not reach it, so the change was most likely not made. Tell the person in plain words.",
  unknown:
    "The service did not answer in time. The change may have been made: ask the person to check in the service before requesting it again. Do not request it again on your own.",
  cancelled: "The person cancelled the change, or a newer one replaced it. Nothing was changed.",
  expired:
    "The link expired before the person decided. Nothing was changed. Request the change again only if the person still wants it.",
};

const REFUSED_BECAUSE: Record<Exclude<ChangeReason, "person" | "superseded" | "limit">, string> = {
  plan: "the plan does not include changing data",
  writes_off: "changing data is turned off for this connection",
  // Also a version bump, another adapter bound, or an adapter that no longer works: not necessarily the assistant's doing.
  adapter_changed: "the connection or its adapter changed after the request. Request the change again",
  origin: "the connection no longer approves this address",
  card_attempts:
    "too many wrong confirmations came from the chat card, so the change was stopped. Request it again only if the person still wants it",
};

// When the usage gate's own words were already erased with the answer, an hour after the end.
const LIMIT_REACHED = "the call limit was reached";

// With confirmation off, a write still comes as a link until the person confirmed its operation once as it is now.
const NOT_CONFIRMED_YET =
  "Confirmation is off for this connection, but the person has not yet confirmed this operation in its current form, so this time it needs the page. After they confirm it once, the same operation runs at once next time.";

// The usage gate refused after the request was sent: the service may well have answered, so this is not a timeout.
const UNKNOWN_AFTER_CALL =
  "The request was sent, but how it ended could not be recorded. The change may have been made: ask the person to check in the service before requesting it again. Do not request it again on your own.";

// The switch was found off at the last look before sending. Thrown by the change's own hook in the runtime.
class WritesTurnedOffError extends Error {
  constructor() {
    super("Changing data is turned off for this connection.");
    this.name = "WritesTurnedOffError";
  }
}

// A refused connection or an unresolved host: the request never left this process. Anything else may have reached the
// service, so it is not one of these.
const NOT_SENT_CODES: ReadonlyMap<string, string> = new Map([
  ["ENOTFOUND", "dns"],
  ["EAI_AGAIN", "dns"],
  ["ECONNREFUSED", "connect"],
]);

function sentence(text: string): string {
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

function pendingStep(url: string, risk: "write" | "destructive", confirmationOff: boolean): string {
  const step = `Nothing has changed yet. Show the person this link: ${url} . The page shows exactly what will be sent; the change runs only after they confirm there. The link works for ${formatMinutes("en", CHANGE_LINK_TTL_MS)}, only for them. When they say they are done, call get_change with this changeId. Never say the change is made before get_change reports succeeded.`;
  if (risk !== "destructive") return step;
  // The assistant was told this connection runs changes at once, so it is told why this one still has a link.
  const deletion = `${step} This is a deletion: the page asks them twice.`;
  return confirmationOff ? `${deletion} A deletion always needs the person's confirmation, even with confirmation turned off.` : deletion;
}

function ranStatus(status: ChangeStatus): status is RanChange["status"] {
  return status === "succeeded" || status === "failed" || status === "unknown" || status === "refused";
}

// What the repository keeps for a change: the runtime's result with an optional notice, or only { notice }.
function storedAnswer(value: unknown): { result: RuntimeResult | null; notice?: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { result: null };
  const { notice, ...rest } = value as Record<string, unknown>;
  const result = typeof rest["ok"] === "boolean" ? (rest as RuntimeResult) : null;
  return typeof notice === "string" ? { result, notice } : { result };
}

function nextStepFor(record: ChangeRecord, notice: string | undefined): string {
  const { status, reason } = record;
  if (status === "unknown" && record.errorCategory === "usage_after_call") return UNKNOWN_AFTER_CALL;
  if (status !== "refused") return NEXT_STEP[status];
  if (reason === "limit") return `Nothing was changed: ${sentence(notice ?? LIMIT_REACHED)}`;
  if (reason === null || reason === "person" || reason === "superseded") return "Nothing was changed.";
  return `Nothing was changed: ${REFUSED_BECAUSE[reason]}.`;
}

function errorCode(error: unknown): string | undefined {
  const own: unknown = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof own === "string") return own;
  const cause: unknown = (error as { cause?: unknown } | null | undefined)?.cause;
  const nested: unknown = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof nested === "string" ? nested : undefined;
}

function notSentCategory(error: unknown): string {
  if (error instanceof NetworkPolicyError) return "policy";
  if (error instanceof AdapterChangedError || error instanceof WriteOperationError) return "adapter_changed";
  if (error instanceof NotFoundError) return "not_found";
  return "not_sent";
}

// How a change that was taken to run but threw ended. "failed" is said only where the request certainly never left;
// whatever may have reached the service is "unknown", and a change is never sent twice either way.
function thrownOutcome(error: unknown): ChangeOutcome {
  const notice = noticeOf(error);
  const ended = (status: "failed" | "unknown", errorCategory: string, httpStatus: number | null = null): ChangeOutcome => ({
    status, httpStatus, errorCategory, result: notice === undefined ? null : { notice },
  });
  // The runtime never called fetch: nothing was sent. A limit is then the gate refusing before the request, and the
  // gate's refusal for the plan is the plan's.
  if (fetchStartedOf(error) === false) {
    if (error instanceof WritesTurnedOffError) return { status: "refused", reason: "writes_off" };
    if (error instanceof WritesNotAllowedError) return { status: "refused", reason: "plan", notice: error.message };
    if (error instanceof UsageLimitError) return { status: "refused", reason: "limit", notice: error.message };
    return ended("failed", notSentCategory(error));
  }
  // Fetch was called, or the error is not one the runtime marked: the request may have reached the service.
  if (error instanceof DOMException && error.name === "TimeoutError") return ended("unknown", "timeout");
  // Both come after the service received the request: a 3xx answer, or a body past the byte limit.
  if (error instanceof RedirectBlockedError) return ended("unknown", "redirect", error.status);
  if (error instanceof ResponseByteLimitError) return ended("unknown", "response_limit");
  // Any other policy refusal once fetch was called may have come after the request left, so it is not "nothing sent".
  if (error instanceof NetworkPolicyError) return ended("unknown", "policy");
  const code = errorCode(error);
  const notSent = code === undefined ? undefined : NOT_SENT_CODES.get(code);
  if (notSent !== undefined) return ended("failed", notSent);
  // A limit here came after the request was sent, so the change may have been made.
  return ended("unknown", error instanceof UsageLimitError ? "usage_after_call" : "internal");
}

// Changes to the person's data in a connected service. The assistant only asks; the change runs once, with the stored
// values, after the person confirms on a page, and only if the host, the connection's switch and the adapter still
// allow exactly what was asked. When the person turned confirmation off, a write whose operation they already confirmed
// once in its current form runs at once on the request, under the same checks; any other write and every deletion still
// wait for the person.
export class ChangeService {
  constructor(private readonly deps: ChangeServiceDependencies) {
    // The service's answers are erased an hour after a change, even when nobody reads them again.
    deps.changes.sweep();
  }

  // The request where no chat card shows it: the link alone decides it, and no card token is made.
  async request(input: RequestChangeInput): Promise<RequestChangeResult> {
    return (await this.ask(input, false)).result;
  }

  // The request, with what the chat card shows beside the assistant's answer.
  async requestWithCard(input: RequestChangeInput): Promise<RequestChangeAnswer> {
    const { result, card } = await this.ask(input, true);
    if (card === null) throw new Error("A change asked for with the card must come with it");
    return { result, card };
  }

  private async ask(input: RequestChangeInput, withCard: boolean): Promise<RequestChangeAnswer | CardlessAnswer> {
    // The card's part of an answer, left out where no card shows it.
    const answer = (result: RequestChangeResult, card: CardGrant): RequestChangeAnswer | CardlessAnswer =>
      withCard ? { result, card } : { result, card: null };
    if (input.summary.length < 1 || input.summary.length > MAX_CHANGE_SUMMARY) {
      throw new Error(`The summary must be 1 to ${MAX_CHANGE_SUMMARY} characters.`);
    }
    if (input.args === null || typeof input.args !== "object" || Array.isArray(input.args)) {
      throw new Error("Arguments must be an object.");
    }
    const connection = this.deps.connections.getConnection(input.connectionId);
    const { adapter, operation } = this.boundOperation(connection, input.operationId);
    const risk = effectiveRisk(operation);
    if (risk === "read") throw new Error(`Operation ${operation.id} only reads. Use call_adapter.`);
    if (Buffer.byteLength(JSON.stringify(operation)) > MAX_CHANGE_OPERATION_BYTES) {
      throw new Error("This operation is too large to confirm.");
    }
    // Checked, stored, shown and later sent in the same form: what JSON keeps of them.
    const serialized = JSON.stringify(input.args);
    const args = JSON.parse(serialized) as Record<string, unknown>;
    const prepared = prepareCall(adapter, connection, operation, args);
    if (Buffer.byteLength(serialized) > MAX_CHANGE_ARGS_BYTES) {
      throw new Error("The arguments are too large to show the person. Split the change into smaller ones.");
    }
    const holdsKey = await this.deps.vault.withCredentials(connection.credentialSetId, async (credentials) => {
      const secrets = Object.values(credentials).filter((secret) => secret !== "");
      return { args: containsSecret(args, secrets), summary: containsSecret(input.summary, secrets) };
    });
    if (holdsKey.args) throw new Error("Arguments must not contain key values.");
    if (holdsKey.summary) throw new Error("The summary must not contain key values.");
    this.assertRoomFor(connection.id);
    const requestedVia = await this.requester(input.requestedVia);

    const baseUrl = input.baseUrl.replace(/\/+$/u, "");
    const refusal = await this.deps.writes.check();
    if (refusal !== null) {
      return answer(
        { status: "refused", reason: "plan", nextStep: `${refusal.message} Nothing was changed.` },
        { kind: "refused", reason: "plan" },
      );
    }
    // Read again after the waits above, so a switch or a confirmation setting changed meanwhile is seen, and nothing
    // waits from here to issue.
    const current = this.deps.connections.getConnection(connection.id);
    if (!current.writesEnabled) {
      return answer(
        {
          status: "refused",
          reason: "writes_off",
          nextStep: `Changing data is turned off for this connection. Only the person can turn it on, on this page: ${this.signInLink(this.deps.writes.settingsUrl(baseUrl, connection.id))} . Nothing was changed.`,
        },
        { kind: "refused", reason: "writes_off" },
      );
    }
    const confirmationOff = this.changesConfirmation(current) === "off";
    // Confirmation off lets a write through at once only in a form the person already confirmed on its page: the
    // assistant writes operations and their risk labels itself, so what the person never saw still goes by link. A
    // deletion keeps its page and its two confirmations whatever came before.
    const needsFirstConfirmation = risk === "write" && confirmationOff
      && !this.confirmedBefore(connection.id, operation, prepared.method, prepared.url.origin);
    const runsAtOnce = risk === "write" && confirmationOff && !needsFirstConfirmation;
    this.assertRoomFor(connection.id);
    const { record, token, cardToken } = this.deps.changes.issue({
      connectionId: connection.id,
      connectionLabel: connection.label,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      operationId: operation.id,
      operation,
      risk,
      method: prepared.method,
      targetUrl: prepared.url.toString(),
      args,
      summary: input.summary,
      requestedVia,
      confirmation: runsAtOnce ? "none" : "person",
    }, { card: withCard });
    if (runsAtOnce) {
      const result = await this.runAtOnce(record, token);
      const ran = this.deps.changes.get(record.id);
      if (!ran) throw new Error("The change could not be started");
      return answer(result, { kind: "ran", record: ran });
    }
    const url = this.signInLink(`${baseUrl}/confirm/change/${record.id}?t=${token}`);
    // What the page would open with now: nothing blocked it a moment ago, and with confirmation off this write's "Run"
    // is the one that lets it through at once from then on.
    const firstTime = !this.deps.changes.succeededOperations(adapter.id, adapter.version).has(operation.id);
    const result: RequestChangeResult = {
      status: "pending",
      changeId: record.id,
      risk: record.risk,
      confirmation: { url, expiresAt: record.expiresAt },
      ...(needsFirstConfirmation ? { notice: NOT_CONFIRMED_YET } : {}),
      nextStep: pendingStep(url, record.risk, confirmationOff),
    };
    if (cardToken === null) return { result, card: null };
    return answer(result, { kind: "confirm", cardToken, state: { record, blocked: null, firstTime, grantsStanding: needsFirstConfirmation } });
  }

  // A link to a page the person opens signed in, with the setup token while there is no administrator to sign in as.
  private signInLink(url: string): string {
    return withSetupToken(url, this.deps.setupToken?.() ?? null);
  }

  view(changeId: string): ChangeView {
    const record = this.deps.changes.get(changeId);
    if (!record) throw new Error("Unknown change");
    const answer = storedAnswer(record.result);
    const view: ChangeView = {
      changeId: record.id,
      status: record.status,
      connectionId: record.connectionId,
      operationId: record.operationId,
      summary: record.summary,
      createdAt: record.createdAt,
      decidedAt: record.decidedAt,
      finishedAt: record.finishedAt,
      nextStep: nextStepFor(record, answer.notice),
    };
    if (record.confirmation === "none") view.changesConfirmation = "off";
    if ((record.status === "refused" || record.status === "cancelled") && record.reason !== null) view.reason = record.reason;
    if (record.status === "succeeded" || record.status === "failed") view.result = answer.result;
    if (answer.notice !== undefined) view.notice = answer.notice;
    return view;
  }

  // The change behind a confirmation link, for its page: what stops it now, whether this action ever ran before, and
  // whether running it lets the same action run at once from then on.
  async open(changeId: string, token: string): Promise<PageState | null> {
    let record = this.deps.changes.byToken(changeId, token);
    if (!record) return null;
    let blocked: PageState["blocked"] = null;
    let grantsStanding = false;
    if (record.status === "pending") {
      const refusal = await this.deps.writes.check();
      record = this.deps.changes.byToken(changeId, token);
      if (!record) return null;
      if (record.status === "pending") {
        if (refusal !== null) blocked = "plan";
        else {
          const connection = this.deps.connections.getConnection(record.connectionId);
          if (!connection.writesEnabled) blocked = "writes_off";
          else grantsStanding = this.grantsStanding(connection, record);
        }
      }
    }
    const firstTime = !this.deps.changes.succeededOperations(record.adapterId, record.adapterVersion).has(record.operationId);
    return { record, blocked, firstTime, grantsStanding };
  }

  // The change behind a confirmation link, in any state, without asking the host: the page reads its step and outcome.
  find(changeId: string, token: string): ChangeRecord | null {
    return this.deps.changes.byToken(changeId, token);
  }

  // The person's decision on the page. null when it changed nothing: a wrong token, a change no longer waiting, or a
  // form of another step. A run checks again what the request checked, and only the caller that takes the change sends
  // it, once, with the stored values.
  async decide(changeId: string, token: string, decision: "run" | "cancel", step: 0 | 1): Promise<Decision | null> {
    const record = this.deps.changes.byToken(changeId, token);
    if (!record || record.status !== "pending") return null;
    if (decision === "cancel") return this.deps.changes.cancel(changeId, token) ? this.decided(changeId) : null;
    if (record.step !== step) return null;
    if (record.risk === "destructive" && step === 0) {
      return this.deps.changes.advance(changeId, token) ? { kind: "final_step" } : null;
    }

    const refusal = await this.deps.writes.check();
    // From here to the claim and the start of the run nothing waits, so what is checked is what runs.
    const current = this.deps.changes.byToken(changeId, token);
    if (!current || current.status !== "pending" || current.step !== step) return null;
    const reason = refusal !== null ? "plan" : this.clickRefusal(current);
    if (reason !== null) return this.deps.changes.refuse(changeId, token, reason) ? this.decided(changeId) : null;
    if (!this.deps.changes.claim(changeId, token, step)) return null;
    await this.runClaimed(current);
    return this.decided(changeId);
  }

  // The person's press in the chat card, with the card's token. It decides a write as the page does, with the same
  // checks and the same single claim; its "Run" confirms this change only, never the operation for later. A deletion,
  // and a write whose "Run" would let it run at once from then on, are never run from the card: they are left as they
  // are for the page, where that permission is given. A token that does not fit decides nothing, and too many wrong ones
  // stop the change.
  async confirmFromCard(changeId: string, cardToken: string, decision: "run" | "cancel", step: 0 | 1): Promise<CardDecision> {
    const check = this.deps.changes.verifyCard(changeId, cardToken);
    if (check.kind !== "valid") return this.rejected(changeId);
    if (decision === "cancel") {
      return this.deps.changes.cancelByCard(changeId, cardToken) ? this.cardDecided(changeId) : this.rejected(changeId);
    }
    if (check.record.step !== step) return { kind: "rejected", record: check.record };
    if (check.record.risk === "destructive") return { kind: "page_only", record: check.record };

    const refusal = await this.deps.writes.check();
    // From here to the claim and the start of the run nothing waits, so what is checked is what runs.
    const current = this.deps.changes.get(changeId);
    if (!current || current.status !== "pending" || current.step !== step) return { kind: "rejected", record: current };
    const reason = refusal !== null ? "plan" : this.clickRefusal(current);
    if (reason !== null) {
      return this.deps.changes.refuseByCard(changeId, cardToken, reason) ? this.cardDecided(changeId) : this.rejected(changeId);
    }
    // In the mode as it is at the press, with nothing awaited before the claim.
    if (this.grantsStanding(this.deps.connections.getConnection(current.connectionId), current)) {
      return { kind: "page_only", record: current };
    }
    if (!this.deps.changes.claimByCard(changeId, cardToken, step)) return this.rejected(changeId);
    await this.runClaimed(current);
    return this.cardDecided(changeId);
  }

  // What the plan says of changing data, for the tools that show a connection to the AI: null when changes may run.
  async planRefusal(): Promise<string | null> {
    return (await this.deps.writes.check())?.message ?? null;
  }

  // Only the person turns writes on, on a page. Turning them off cancels what still waits for this connection.
  setWrites(connectionId: string, enabled: boolean): ConnectionRecord {
    const connection = this.deps.connections.setWritesEnabled(connectionId, enabled);
    if (!enabled) this.deps.changes.cancelPending(connectionId, "writes_off");
    return connection;
  }

  // What the connection's changes do now: wait for the person, or run at once. The account-wide setting wins over the
  // connection's own, so the person can let every connection through with one switch.
  changesConfirmation(connection: Pick<ConnectionRecord, "confirmChanges">): ChangesConfirmation {
    return !connection.confirmChanges || this.skipsConfirmationEverywhere() ? "off" : "required";
  }

  skipsConfirmationEverywhere(): boolean {
    return this.deps.settings.skipsConfirmationEverywhere();
  }

  // Only the person, in a form of the workspace. Turning confirmation off leaves the changes that already wait for the
  // person as they are: they were asked for with a link, and the person decides them on their page.
  setConfirmChanges(connectionId: string, required: boolean): ConnectionRecord {
    return this.deps.connections.setConfirmChanges(connectionId, required);
  }

  // Only the person, in a form of the workspace, as setConfirmChanges.
  setSkipConfirmationEverywhere(skip: boolean): void {
    this.deps.settings.setSkipConfirmationEverywhere(skip);
  }

  list(options: { connectionId?: string; confirmation?: ChangeConfirmation; limit: number }): ChangeRecord[] {
    return this.deps.changes.list(options);
  }

  // A write the person let through without confirmation, right after it was issued. The checks of the click run here
  // too, with nothing waiting between them and the claim: the adapter may have changed while the request waited for the
  // keys and the plan. The mode is not read again during the run, so confirmation turned back on does not stop a change
  // already taken; the switch is still read right before sending.
  private async runAtOnce(record: ChangeRecord, token: string): Promise<RanChange> {
    let refusal: ReturnType<ChangeService["clickRefusal"]>;
    try {
      refusal = this.clickRefusal(record);
    } catch {
      // The adapter was erased while the request waited. Nothing can run, and the change must not stay waiting for a
      // link nobody holds.
      refusal = "adapter_changed";
    }
    if (refusal !== null) {
      if (!this.deps.changes.refuse(record.id, token, refusal)) throw new Error("The change could not be started");
    } else {
      if (!this.deps.changes.claim(record.id, token, 0)) throw new Error("The change could not be started");
      await this.runClaimed(record);
    }
    const ran = this.view(record.id);
    if (!ranStatus(ran.status)) throw new Error("The change could not be started");
    return { ...ran, status: ran.status, changesConfirmation: "off" };
  }

  // Whether the person confirmed this operation, exactly as the adapter describes it now, on its page for this
  // connection, and it succeeded, sent the same way to the same host. Compared by content, not by adapter version, so a
  // patch of another operation keeps the person's confirmation, and any change to this one, its label included, drops it.
  private confirmedBefore(connectionId: string, operation: AdapterOperation, method: string, origin: string): boolean {
    const wanted = canonicalJson(operation);
    return this.deps.changes
      .confirmedForms(connectionId, operation.id, method, origin)
      .some((form) => canonicalJson(form) === wanted);
  }

  // Whether the person's "Run" on this change's page is the confirmation that lets the same action through at once
  // afterwards: confirmation is off for the connection now, the action is a write, and it is not yet trusted in the form
  // the change stored, which is the form that runs, since the click refuses an adapter changed since the request.
  private grantsStanding(connection: ConnectionRecord, record: ChangeRecord): boolean {
    return this.changesConfirmation(connection) === "off"
      && effectiveRisk(record.operation) === "write"
      && !this.confirmedBefore(record.connectionId, record.operation, record.method, new URL(record.targetUrl).origin);
  }

  // Sends a change this caller claimed, stores how it ended and tells the host's observer, the same for a change the
  // person confirmed and for one that ran without confirmation.
  private async runClaimed(record: ChangeRecord): Promise<void> {
    const { outcome, detail } = await this.run(record);
    this.deps.changes.finish(record.id, outcome);
    this.tellFinished(record, outcome, detail);
  }

  private boundOperation(connection: ConnectionRecord, operationId: string): { adapter: AdapterRecord; operation: AdapterOperation } {
    if (!connection.adapterId) throw new Error("Connection is not bound to an adapter");
    const adapter = this.deps.adapters.get(connection.adapterId);
    if (adapter.status !== "working") throw new Error("Adapter must be working before changes");
    const operation = adapter.dsl.operations.find(({ id }) => id === operationId);
    if (!operation) throw new Error(`Unknown adapter operation: ${operationId}`);
    return { adapter, operation };
  }

  private async requester(given: RequestChangeInput["requestedVia"]): Promise<string | null> {
    if (typeof given === "function") return (await given()) ?? null;
    if (given !== undefined) return given;
    return (await this.deps.requestedVia?.()) ?? null;
  }

  private assertRoomFor(connectionId: string): void {
    // First, since confirming or cancelling the waiting ones would not make room under it.
    if (this.deps.changes.issuedWithin(connectionId, CHANGE_WINDOW_MS) >= MAX_CHANGES_PER_HOUR) {
      throw new Error("Too many change requests for this connection in the last hour. Wait and ask the person what to change.");
    }
    if (this.deps.changes.pendingCount(connectionId) >= MAX_PENDING_CHANGES) {
      throw new Error(
        `Too many changes are waiting for the person. Ask them to confirm or cancel those first, or wait ${formatMinutes("en", CHANGE_LINK_TTL_MS)}.`,
      );
    }
  }

  // What stops the change at the click, besides the host's policy: the switch, and anything that would send something
  // other than what the person was shown.
  private clickRefusal(record: ChangeRecord): "writes_off" | "adapter_changed" | "origin" | null {
    const connection = this.deps.connections.getConnection(record.connectionId);
    if (!connection.writesEnabled) return "writes_off";
    if (connection.adapterId !== record.adapterId) return "adapter_changed";
    const adapter = this.deps.adapters.get(record.adapterId);
    if (adapter.version !== record.adapterVersion || adapter.status !== "working") return "adapter_changed";
    const operation = adapter.dsl.operations.find(({ id }) => id === record.operationId);
    if (!operation || JSON.stringify(operation) !== JSON.stringify(record.operation)) return "adapter_changed";
    let prepared: ReturnType<typeof prepareCall>;
    try {
      // The operation and the arguments are the ones checked at the request, so only the connection's approval of the
      // address can fail here.
      prepared = prepareCall(adapter, connection, operation, record.args);
    } catch {
      return "origin";
    }
    if (prepared.method !== record.method || prepared.url.toString() !== record.targetUrl) return "adapter_changed";
    return null;
  }

  // The outcome to store, and for the observer the text of a change that failed or may have failed. The text is made,
  // and the keys read for it, only when there is an observer to hear it.
  private async run(record: ChangeRecord): Promise<{ outcome: ChangeOutcome; detail: string | null }> {
    try {
      const result = await this.deps.runtime.execute({
        connectionId: record.connectionId,
        operationId: record.operationId,
        args: record.args,
        mode: "change",
        expectedAdapter: { id: record.adapterId, version: record.adapterVersion },
        // The switch read again after the usage gate and the keys, so one turned off while the change started sends
        // nothing.
        beforeSend: () => {
          if (!this.deps.connections.getConnection(record.connectionId).writesEnabled) throw new WritesTurnedOffError();
        },
      });
      if (result.ok) {
        return {
          outcome: { status: "succeeded", httpStatus: result.status, errorCategory: null, result },
          detail: null,
        };
      }
      return {
        outcome: { status: "failed", httpStatus: result.status, errorCategory: "upstream_http", result },
        detail: this.failureText(record.connectionId, result.error),
      };
    } catch (error) {
      const outcome = thrownOutcome(error);
      return { outcome, detail: outcome.status === "refused" ? null : this.failureText(record.connectionId, error) };
    }
  }

  // A failure's text with the connection's key values masked. When the keys cannot be read, no text is given at all
  // rather than one that might hold a key.
  private failureText(connectionId: string, failure: unknown): string | null {
    if (this.deps.onChangeFinished === undefined) return null;
    try {
      const { credentialSetId } = this.deps.connections.getConnection(connectionId);
      const secrets = this.deps.vault.withCredentialsSync(credentialSetId, (fields) =>
        Object.values(fields).filter((value) => value !== ""));
      return errorDetail(failure, secrets);
    } catch {
      return null;
    }
  }

  // Tells the host's observer how a change that ran ended. The person's answer does not depend on it, so whatever the
  // observer throws, at once or by rejecting, goes no further.
  private tellFinished(record: ChangeRecord, outcome: ChangeOutcome, detail: string | null): void {
    const observer = this.deps.onChangeFinished;
    if (observer === undefined || outcome.status === "refused") return;
    try {
      const returned: unknown = observer({
        changeId: record.id,
        connectionId: record.connectionId,
        connectionLabel: record.connectionLabel,
        adapterId: record.adapterId,
        adapterVersion: record.adapterVersion,
        operationId: record.operationId,
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        kind: outcome.errorCategory,
        detail,
        requestedVia: record.requestedVia,
      });
      // An observer written as an async function reports its failure by rejecting, which must not escape either.
      const then: unknown = (returned as { then?: unknown } | null | undefined)?.then;
      if (typeof then === "function") Promise.resolve(returned).catch(() => undefined);
    } catch {
      // A courtesy to the host, as onToolResult is.
    }
  }

  private decided(changeId: string): Decision | null {
    const record = this.deps.changes.get(changeId);
    return record ? { kind: "decided", record } : null;
  }

  private cardDecided(changeId: string): CardDecision {
    const record = this.deps.changes.get(changeId);
    return record ? { kind: "decided", record } : { kind: "rejected", record: null };
  }

  private rejected(changeId: string): CardDecision {
    return { kind: "rejected", record: this.deps.changes.get(changeId) };
  }
}
