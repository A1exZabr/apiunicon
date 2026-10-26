import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

import { type AdapterRecord, type AdapterRepository, VersionConflictError } from "../adapters/repository.js";
import { AdapterDslSchema, type AdapterDsl } from "../adapters/schema.js";
import type { AuditRepository } from "../audit/repository.js";
import type {
  CardlessAnswer, ChangeService, ChangesConfirmation, RequestChangeAnswer, RequestedVia,
} from "../changes/service.js";
import { READ_APPROVAL_LINK_TTL_MS } from "../connections/action-links.js";
import type { ConnectionRecord, ConnectionRepository } from "../connections/repository.js";
import type { DocsRepository } from "../docs/repository.js";
import { formatMinutes } from "../i18n/messages.js";
import type { ReadApprovalLink, ReadApprovalService } from "../reads/service.js";
import { ReadNotApprovedError, type AdapterRuntime, type RuntimeResult } from "../runtime/runtime.js";
import type { Vault } from "../vault/vault.js";
import { createOnboardingHandlers, type OnboardingDependencies, type StartConnectionInput } from "./onboarding.js";

export type ToolName =
  | "list_connections"
  | "get_connection"
  | "search_adapters"
  | "get_adapter"
  | "bind_adapter"
  | "create_adapter"
  | "patch_adapter"
  | "search_docs"
  | "read_docs"
  | "test_adapter_operation"
  | "call_adapter"
  | "request_change"
  | "get_change"
  | "confirm_change"
  | "record_learning"
  | "mark_adapter_reusable"
  | "get_adapter_state"
  | "start_connection"
  | "get_connection_setup"
  | "attach_documentation"
  | "propose_connection_settings"
  | "replace_connection_keys"
  | "rename_connection"
  | "delete_connection";

export type ToolDependencies = {
  db: Database.Database;
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  docs: DocsRepository;
  runtime: AdapterRuntime;
  audits: AuditRepository;
  onboarding?: OnboardingDependencies;
  // Changes to the person's data, confirmed by the person on a page. Without it, or without onboarding (whose key-entry
  // base serves the confirmation page), this process cannot change data.
  changes?: ChangeService;
  // The person's approval of reads sent with POST. Without it, or without onboarding (whose key-entry base serves the
  // approval page), such a read is refused with no link to approve it.
  readApprovals?: ReadApprovalService;
  // Which assistant this process serves, as the host knows it ("Claude", "ChatGPT", "Claude Code"), or a hook that says
  // it, asked only when request_change runs. It is recorded with every change the assistant asks for and shown to the
  // person. Without it, the change service's own hook is asked, if it has one.
  requestedVia?: string | RequestedVia;
  onToolCall?: (name: ToolName) => void;
  // Only to mask a connection's key values in the text of a failed call that onToolResult hears. Without it the text is
  // given unmasked: the runtime has already redacted the keys from a service's answer, but not from a thrown error.
  vault?: Vault;
  now?: () => Date;
  // A host's advice for the person when an adapter built here starts working for the first time, for example that it
  // is private and can be offered to a shared catalog. It is added to the notice of the call that made it work.
  adviseOnWorkingAdapter?: (adapter: AdapterRecord) => string | null;
};

// call_adapter's and test_adapter_operation's answer for a read sent with POST that waits for the person's approval.
// Nothing was sent. It is an answer, not an error, as request_change's refusals are: the link's token stays out of the
// host's records of failed calls, and a read waiting for the person is not a failure of the connector.
export type ReadApprovalRequired = {
  status: "approval_required";
  operationId: string;
  readApproval: ReadApprovalLink;
  nextStep: string;
};

// Whether call_adapter or test_adapter_operation answered that the read waits for the person's approval.
export function awaitsReadApproval(result: object): result is ReadApprovalRequired {
  return (result as { status?: unknown }).status === "approval_required";
}

// What create_adapter, patch_adapter and bind_adapter add when the adapter has reads sent with POST that wait: a link
// for each connection concerned, and what to do with them.
type ReadApprovalNotice = { readApprovals: ReadApprovalLink[]; nextStep: string };

const READ_APPROVAL_LINK_TIME = formatMinutes("en", READ_APPROVAL_LINK_TTL_MS);

function readApprovalRequired(tool: "call_adapter" | "test_adapter_operation", operationId: string, link: ReadApprovalLink): ReadApprovalRequired {
  return {
    status: "approval_required",
    operationId,
    readApproval: link,
    nextStep: `Nothing was sent. ${operationId} is sent with POST and labelled as a read, and the person has not approved it as a read for this connection in its current form. If it only reads, show the person this link: ${link.url} . The page lists every read sent with POST that waits, and the person allows them as reads there; the link works for ${READ_APPROVAL_LINK_TIME}, only for them. When they say they are done, call ${tool} again with the same arguments. If the operation changes anything, do not ask for approval: label it write or destructive with patch_adapter and use request_change.`,
  };
}

function readApprovalNotice(links: ReadApprovalLink[]): ReadApprovalNotice | null {
  if (links.length === 0) return null;
  const operationIds = [...new Set(links.flatMap(({ operationIds: ids }) => ids))].join(", ");
  const where = links.length === 1
    ? `this link: ${links[0]!.url} .`
    : `these links, one for each connection that uses the adapter: ${links.map(({ url }) => `${url} `).join(", ")}.`;
  return {
    readApprovals: links,
    nextStep: `Reads sent with POST in this adapter wait for the person's approval: ${operationIds}. call_adapter and test_adapter_operation refuse them until then. If they only read, show the person ${where} The page lists them, and the person allows them as reads there; a link works for ${READ_APPROVAL_LINK_TIME}. If one of them changes anything, label it write or destructive with patch_adapter instead of asking for approval.`,
  };
}

type TestOutcome = {
  outcome: "success" | "failure";
  operationId: string;
  adapterVersion: number;
  httpStatus: number | null;
  errorCategory: string | null;
  createdAt: string;
};

export function createToolHandlers(dependencies: ToolDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const called = (name: ToolName): void => dependencies.onToolCall?.(name);
  const onboarding = dependencies.onboarding ? createOnboardingHandlers(dependencies.onboarding) : null;
  const requireOnboarding = () => {
    if (!onboarding) throw new Error("Connection setup is not available in this process");
    return onboarding;
  };
  const requireChanges = () => {
    if (!dependencies.changes) throw new Error("Changing data is not available in this process");
    return dependencies.changes;
  };
  // Approval links are served where the key-entry pages are: a cloud host sets this base to the request's domain.
  const approvalBase = (): string | undefined => (dependencies.readApprovals ? dependencies.onboarding?.keyEntryBaseUrl : undefined);
  // The refusal of a read sent with POST that waits, with a link for the person. Anything else, or a refusal no link can
  // be given for, goes on as it was thrown.
  const refusedRead = (error: unknown, connectionId: string, tool: "call_adapter" | "test_adapter_operation"): ReadApprovalRequired => {
    const base = approvalBase();
    if (!(error instanceof ReadNotApprovedError) || base === undefined) throw error;
    const link = dependencies.readApprovals!.link(connectionId, base);
    // Approved meanwhile: this call stays refused, and the next one runs.
    if (link === null) throw error;
    return readApprovalRequired(tool, error.operationId, link);
  };
  // The result of a tool that gave a connection an adapter, or changed one, with links for the reads that now wait.
  const withReadApprovals = <Result extends object>(
    result: Result,
    links: (base: string) => ReadApprovalLink[],
  ): Result | (Result & ReadApprovalNotice) => {
    const base = approvalBase();
    const notice = base === undefined ? null : readApprovalNotice(links(base));
    return notice === null ? result : { ...result, ...notice };
  };
  const connectionLinks = (connectionId: string) => (base: string): ReadApprovalLink[] => {
    const link = dependencies.readApprovals!.link(connectionId, base);
    return link === null ? [] : [link];
  };
  // Shown with a connection when the plan does not include changing data, so the AI tells the person what it takes before
  // pointing at a switch the person's plan does not have. A process that cannot change data at all says nothing here.
  const planRefusal = async (): Promise<string | null> => (dependencies.changes ? dependencies.changes.planRefusal() : null);
  // What the assistant sees of a connection: the mode in effect, never the connection's own switch for it. The switch
  // alone would mislead the assistant when the account-wide setting skips confirmation, and only the person changes
  // either, so the assistant has no use for it. A process that cannot change data shows no mode. readsAwaitingApproval
  // counts the adapter's reads sent with POST that wait for the person, when there are any.
  const connectionForAssistant = (
    connection: ConnectionRecord,
    refusal: string | null,
  ): Omit<ConnectionRecord, "confirmChanges"> & {
    changesConfirmation?: ChangesConfirmation;
    changingData?: string;
    readsAwaitingApproval?: number;
  } => {
    const { confirmChanges: _confirmChanges, ...shown } = connection;
    const awaiting = dependencies.readApprovals?.pendingCount(connection.id) ?? 0;
    return {
      ...shown,
      ...(dependencies.changes ? { changesConfirmation: dependencies.changes.changesConfirmation(connection) } : {}),
      ...(refusal === null ? {} : { changingData: refusal }),
      ...(awaiting === 0 ? {} : { readsAwaitingApproval: awaiting }),
    };
  };
  const documentationProvenance = (sourceId: string): string[] => {
    const documents = dependencies.onboarding?.documents.list(sourceId) ?? [];
    if (documents.length > 0) return [...new Set(documents.map(({ provenance }) => provenance))];
    const summary = dependencies.onboarding?.drafts.findByDocumentationSource(sourceId)?.provenanceSummary;
    return summary && summary.kind !== "documents" ? [summary.kind] : [];
  };

  const recordTestOutcome = (
    adapterId: string,
    connectionId: string,
    operationId: string,
    adapterVersion: number,
    result: RuntimeResult,
  ): void => {
    const latestAudit = dependencies.audits.recent(connectionId, 1)[0];
    dependencies.db
      .prepare(
        `insert into adapter_test_outcomes
          (id, adapter_id, connection_id, operation_id, adapter_version, outcome,
           http_status, error_category, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        adapterId,
        connectionId,
        operationId,
        adapterVersion,
        result.ok ? "success" : "failure",
        result.status,
        latestAudit?.errorCategory ?? null,
        now().toISOString(),
      );
  };

  return {
    async list_connections(_input: Record<string, never>) {
      called("list_connections");
      const refusal = await planRefusal();
      return dependencies.connections.listConnections().map((connection) => connectionForAssistant(connection, refusal));
    },

    async get_connection(input: { connectionId: string }) {
      called("get_connection");
      const connection = dependencies.connections.getConnection(input.connectionId);
      return connectionForAssistant(connection, await planRefusal());
    },

    async search_adapters(input: { query: string }) {
      called("search_adapters");
      return dependencies.adapters.search(input.query);
    },

    async get_adapter(input: { adapterId: string }) {
      called("get_adapter");
      return dependencies.adapters.get(input.adapterId);
    },

    async bind_adapter(input: { connectionId: string; adapterId: string }) {
      called("bind_adapter");
      const connection = dependencies.connections.getConnection(input.connectionId);
      const adapter = dependencies.adapters.get(input.adapterId);
      if (adapter.visibility !== "reusable" || adapter.status !== "working") {
        throw new Error("Only a reusable working adapter can be bound to a new connection");
      }
      const approved = adapter.dsl.baseOrigins.every((origin) =>
        connection.allowedOrigins.includes(origin),
      );
      if (!approved) throw new Error("Connection does not approve every adapter origin");
      const bound = connectionForAssistant(dependencies.connections.replaceAdapter(connection.id, adapter.id), null);
      return withReadApprovals(bound, connectionLinks(connection.id));
    },

    async create_adapter(input: {
      connectionId: string;
      slug: string;
      displayName: string;
      dsl: AdapterDsl;
    }) {
      called("create_adapter");
      const connection = dependencies.connections.getConnection(input.connectionId);
      const dsl = AdapterDslSchema.parse(input.dsl);
      // One transaction: if the new adapter cannot be created, the old one stays bound.
      const adapter = dependencies.db.transaction(() => {
        dependencies.connections.detachPrivateAdapter(connection.id);
        const created = dependencies.adapters.create({
          slug: input.slug,
          displayName: input.displayName,
          documentationSourceId: connection.documentationSourceId,
          dsl,
        });
        dependencies.connections.bindAdapter(connection.id, created.id);
        return created;
      })();
      return withReadApprovals(adapter, connectionLinks(connection.id));
    },

    // An adapter that connections rely on as it was reviewed (a reusable one, or one that serves more than one connection)
    // is never changed in place: the connection being worked on gets a private copy with the new definition, and every
    // other connection keeps the version it had. A copy of a catalog entry that serves one connection is that
    // connection's own and is changed in place, but stops being a copy of the entry. Nothing is erased either way: the
    // adapter's tests, learnings and the connection's journal of calls stay.
    async patch_adapter(input: {
      adapterId: string;
      expectedVersion: number;
      dsl: AdapterDsl;
      connectionId?: string | undefined;
    }) {
      called("patch_adapter");
      const dsl = AdapterDslSchema.parse(input.dsl);
      const original = dependencies.adapters.get(input.adapterId);
      const users = dependencies.connections.listIdsByAdapter(original.id);
      if (input.connectionId !== undefined && !users.includes(dependencies.connections.getConnection(input.connectionId).id)) {
        throw new Error("Connection is not bound to the requested adapter");
      }
      const shared = original.visibility === "reusable" || users.length > 1;
      const fromCatalog = original.catalogEntryId !== null;
      if (!shared && !fromCatalog) {
        const adapter = dependencies.adapters.patch(original.id, input.expectedVersion, dsl);
        return withReadApprovals(adapter, (base) => dependencies.readApprovals!.linksForAdapter(adapter.id, base));
      }
      if (!shared && users.length === 1) {
        const adapter = dependencies.adapters.patch(original.id, input.expectedVersion, dsl, { leaveCatalog: true });
        const step = `Adapter ${original.id} was a copy of a shared catalog entry that only this connection uses, so it was changed in place: it is now version ${adapter.version}, this connection's own adapter and no longer a copy of the entry, and a draft until a test passes. Its reads sent with POST that you did not change keep the catalog's approval for this connection.`;
        const base = approvalBase();
        const notice = base === undefined ? null : readApprovalNotice(dependencies.readApprovals!.linksForAdapter(adapter.id, base));
        return notice === null
          ? { ...adapter, nextStep: step }
          : { ...adapter, readApprovals: notice.readApprovals, nextStep: `${step} ${notice.nextStep}` };
      }
      if (original.version !== input.expectedVersion) throw new VersionConflictError(original.id, input.expectedVersion);
      const connectionId = input.connectionId ?? (users.length === 1 ? users[0] : undefined);
      if (connectionId === undefined) {
        throw new Error(users.length === 0
          ? `No connection uses adapter ${original.id}, so it is not changed. To build a different one for a connection, call create_adapter.`
          : `Adapter ${original.id} serves ${users.length} connections and is not changed in place. Pass connectionId: that connection gets a private copy with your changes, and the others keep this version.`);
      }
      const connection = dependencies.connections.getConnection(connectionId);
      // One transaction: if the copy cannot be bound, nothing changes. The original is reusable or serves other
      // connections, so it stays, with its history.
      const copy = dependencies.db.transaction(() => {
        const created = dependencies.adapters.createEditedCopy(original, { documentationSourceId: connection.documentationSourceId, dsl });
        dependencies.connections.bindAdapter(connection.id, created.id);
        return created;
      })();
      const why = original.visibility === "reusable" ? "is reusable" : "serves other connections too";
      const others = users.length > 1 ? " Every other connection keeps using it as it was." : "";
      const step = `Adapter ${original.id} ${why}, so it was not changed. This connection now uses a private copy with your changes: adapter ${copy.id}, version ${copy.version}, a draft until a test passes. Use this adapterId from now on.${others}`;
      const base = approvalBase();
      const notice = base === undefined ? null : readApprovalNotice(connectionLinks(connection.id)(base));
      const copied = { ...copy, copiedFrom: original.id };
      return notice === null
        ? { ...copied, nextStep: step }
        : { ...copied, readApprovals: notice.readApprovals, nextStep: `${step} ${notice.nextStep}` };
    },

    async search_docs(input: { connectionId: string; query: string; limit?: number | undefined }) {
      called("search_docs");
      const connection = dependencies.connections.getConnection(input.connectionId);
      return dependencies.docs.search(
        connection.documentationSourceId,
        input.query,
        Math.min(Math.max(input.limit ?? 5, 1), 20),
      );
    },

    async read_docs(input: { connectionId: string; chunkId: string }) {
      called("read_docs");
      const connection = dependencies.connections.getConnection(input.connectionId);
      return dependencies.docs.readChunkForSource(connection.documentationSourceId, input.chunkId);
    },

    async test_adapter_operation(input: {
      connectionId: string;
      adapterId: string;
      operationId: string;
      args: Record<string, unknown>;
    }) {
      called("test_adapter_operation");
      const connection = dependencies.connections.getConnection(input.connectionId);
      if (connection.adapterId !== input.adapterId) {
        throw new Error("Connection is not bound to the requested adapter");
      }
      const before = dependencies.adapters.get(input.adapterId);
      // Read before this outcome is recorded: an adapter becomes working only through a passing test, so an earlier
      // pass means it has worked before.
      const passedBefore = (dependencies.db
        .prepare("select count(*) as count from adapter_test_outcomes where adapter_id = ? and outcome = 'success'")
        .get(input.adapterId) as { count: number }).count > 0;
      let result: RuntimeResult;
      try {
        result = await dependencies.runtime.execute({
          connectionId: input.connectionId,
          operationId: input.operationId,
          args: input.args,
          mode: "test",
        });
      } catch (error) {
        // A test that threw has no outcome to record: either nothing was sent, or the request got no answer to judge the
        // operation by (a timeout, an answer past the size limit), which the runtime's audit of the call records.
        return refusedRead(error, input.connectionId, "test_adapter_operation");
      }
      recordTestOutcome(
        input.adapterId,
        input.connectionId,
        input.operationId,
        before.version,
        result,
      );
      // A passing test promotes a draft once. Retesting a working adapter changes nothing, and a parallel test that
      // promoted it first is not an error: the upstream call already ran, so its result must reach the caller.
      let adapterVersion = before.version;
      let advice: string | null = null;
      if (result.ok && before.status !== "working") {
        try {
          const promoted = dependencies.adapters.markWorking(input.adapterId, before.version);
          adapterVersion = promoted.version;
          // A copy from the catalog is shared already, so only an adapter built here gets the advice.
          if (!passedBefore && promoted.catalogEntryId === null) {
            // Advice is a courtesy: a failing host hook must not hide a test result that already ran upstream, and a
            // blank answer is no advice rather than an empty notice.
            try {
              advice = dependencies.adviseOnWorkingAdapter?.(promoted)?.trim() || null;
            } catch {
              advice = null;
            }
          }
        } catch (error) {
          if (!(error instanceof VersionConflictError)) throw error;
          adapterVersion = dependencies.adapters.get(input.adapterId).version;
        }
      }
      if (advice === null) return { ...result, adapterVersion };
      return { ...result, adapterVersion, notice: result.notice === undefined ? advice : `${result.notice} ${advice}` };
    },

    async call_adapter(input: {
      connectionId: string;
      operationId: string;
      args: Record<string, unknown>;
    }) {
      called("call_adapter");
      try {
        // Named fields only, so nothing else in the input, such as a mode, reaches the runtime.
        return await dependencies.runtime.execute({
          connectionId: input.connectionId,
          operationId: input.operationId,
          args: input.args,
          mode: "call",
        });
      } catch (error) {
        return refusedRead(error, input.connectionId, "call_adapter");
      }
    },

    // card: whether the client shows the chat card. Only then is a card token made, and given apart from the assistant's
    // answer; without it the link alone decides the change.
    async request_change(input: {
      connectionId: string;
      operationId: string;
      args: Record<string, unknown>;
      summary: string;
    }, card = false): Promise<RequestChangeAnswer | CardlessAnswer> {
      called("request_change");
      const changes = requireChanges();
      // The confirmation page is served where the key-entry pages are: a cloud host sets this base to the request's domain.
      const baseUrl = dependencies.onboarding?.keyEntryBaseUrl;
      if (baseUrl === undefined) throw new Error("Changing data is not available in this process");
      const request = {
        connectionId: input.connectionId,
        operationId: input.operationId,
        args: input.args,
        summary: input.summary,
        baseUrl,
        ...(dependencies.requestedVia === undefined ? {} : { requestedVia: dependencies.requestedVia }),
      };
      // The assistant's answer and, apart from it, what the chat card shows with its own token.
      return card ? changes.requestWithCard(request) : { result: await changes.request(request), card: null };
    },

    async get_change(input: { changeId: string }) {
      called("get_change");
      return requireChanges().view(input.changeId);
    },

    // A press in the chat card, never the assistant's: only the card holds the token it needs.
    async confirm_change(input: { changeId: string; cardToken: string; decision: "run" | "cancel"; step: 0 | 1 }) {
      called("confirm_change");
      return requireChanges().confirmFromCard(input.changeId, input.cardToken, input.decision, input.step);
    },

    async record_learning(input: {
      adapterId: string;
      operationId?: string | undefined;
      kind: "constraint" | "pagination" | "auth" | "error_mapping" | "behavior";
      finding: Record<string, unknown>;
      evidence: Record<string, unknown>;
    }) {
      called("record_learning");
      dependencies.adapters.get(input.adapterId);
      const id = randomUUID();
      dependencies.db
        .prepare(
          `insert into knowledge_events
            (id, adapter_id, operation_id, kind, finding_json, evidence_json, created_at)
           values (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.adapterId,
          input.operationId ?? null,
          input.kind,
          JSON.stringify(input.finding),
          JSON.stringify(input.evidence),
          now().toISOString(),
        );
      return { id };
    },

    async mark_adapter_reusable(input: { adapterId: string; expectedVersion: number }) {
      called("mark_adapter_reusable");
      const adapter = dependencies.adapters.get(input.adapterId);
      if (adapter.status !== "working") {
        throw new Error("Only a working adapter can be reviewed for reuse");
      }
      if (adapter.version !== input.expectedVersion) {
        throw new Error(
          `Adapter version conflict for ${adapter.id}; expected version ${input.expectedVersion}`,
        );
      }
      return {
        adapterId: adapter.id,
        expectedVersion: adapter.version,
        confirmationRequired: true as const,
        reviewPath: `/adapters/${adapter.id}`,
        message: "Ask the person to review the sanitized preview on the adapter's page in the local workspace and confirm reuse there. Only the person can.",
      };
    },

    async get_adapter_state(input: { adapterId: string }) {
      called("get_adapter_state");
      const adapter = dependencies.adapters.get(input.adapterId);
      const source = dependencies.connections.getDocumentationSource(
        adapter.documentationSourceId,
      );
      const knowledgeEventCount = (
        dependencies.db
          .prepare("select count(*) as count from knowledge_events where adapter_id = ?")
          .get(adapter.id) as { count: number }
      ).count;
      const rows = dependencies.db
        .prepare(
          `select outcome, operation_id, adapter_version, http_status, error_category, created_at
           from adapter_test_outcomes where adapter_id = ? order by created_at, rowid`,
        )
        .all(adapter.id) as Array<{
        outcome: "success" | "failure";
        operation_id: string;
        adapter_version: number;
        http_status: number | null;
        error_category: string | null;
        created_at: string;
      }>;
      const testOutcomes: TestOutcome[] = rows.map((row) => ({
        outcome: row.outcome,
        operationId: row.operation_id,
        adapterVersion: row.adapter_version,
        httpStatus: row.http_status,
        errorCategory: row.error_category,
        createdAt: row.created_at,
      }));
      return {
        id: adapter.id,
        status: adapter.status,
        visibility: adapter.visibility,
        version: adapter.version,
        docsReady: source.status === "ready",
        testOutcomes,
        knowledgeEventCount,
        documentationProvenance: documentationProvenance(adapter.documentationSourceId),
      };
    },

    async start_connection(input: StartConnectionInput) {
      called("start_connection");
      return requireOnboarding().start_connection(input);
    },

    async get_connection_setup(input: { draftId: string; newKeyEntryLink?: boolean | undefined }) {
      called("get_connection_setup");
      return requireOnboarding().get_connection_setup(input);
    },

    async attach_documentation(input: Parameters<ReturnType<typeof createOnboardingHandlers>["attach_documentation"]>[0]) {
      called("attach_documentation");
      return requireOnboarding().attach_documentation(input);
    },

    async propose_connection_settings(input: Parameters<ReturnType<typeof createOnboardingHandlers>["propose_connection_settings"]>[0]) {
      called("propose_connection_settings");
      return requireOnboarding().propose_connection_settings(input);
    },

    async replace_connection_keys(input: { connectionId: string }) {
      called("replace_connection_keys");
      return requireOnboarding().replace_connection_keys(input);
    },

    async rename_connection(input: { connectionId: string; label: string }) {
      called("rename_connection");
      return connectionForAssistant(dependencies.connections.rename(input.connectionId, input.label), null);
    },

    async delete_connection(input: { connectionId: string }) {
      called("delete_connection");
      return requireOnboarding().delete_connection(input);
    },
  };
}
