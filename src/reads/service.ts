import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import type { AdapterRepository } from "../adapters/repository.js";
import { readsThroughPost } from "../adapters/risk.js";
import type { AdapterOperation } from "../adapters/schema.js";
import { withSetupToken } from "../auth/setup-token.js";
import type { ConnectionActionLinkRepository } from "../connections/action-links.js";
import type { ConnectionRepository } from "../connections/repository.js";
import { readForm, type ReadApprovalRepository } from "./repository.js";

// Where the approval page of a connection is served, under the base address of the one-time pages.
export const READ_APPROVAL_PATH = "/confirm/reads";

type InputDefinition = AdapterOperation["input"][string];

// An input of a read that waits, as the adapter describes it. The assistant chooses its value on every call, and the
// approval covers any value it chooses.
export type PendingReadInput = {
  name: string;
  type: InputDefinition["type"];
  // Where the value goes: the path, the query, or the JSON body. An adapter puts nothing but keys in headers.
  location: InputDefinition["location"];
  required: boolean;
  // The input takes any text or structure in the query or the body: a string, an object or a list. Through such an input
  // one address can be asked anything, such as a GraphQL query or the name of an RPC method, a change included. A value in
  // the path only names what the request is about, so it is not flagged.
  freeForm: boolean;
};

// A read sent with POST that waits for the person's approval, as the approval page lists it.
export type PendingRead = {
  operationId: string;
  method: string;
  // The host and the path template the operation is sent to, as the adapter describes them.
  url: string;
  // The adapter's words for the operation: the assistant's or a catalog author's, untrusted text.
  description: string;
  // Every input of the operation, in the adapter's order.
  inputs: PendingReadInput[];
};

function inputsOf(operation: AdapterOperation): PendingReadInput[] {
  return Object.entries(operation.input).map(([name, { type, location, required }]) => ({
    name,
    type,
    location,
    required,
    freeForm: location !== "path" && (type === "string" || type === "object" || type === "array"),
  }));
}

// A link for the person to approve the connection's reads sent with POST that wait, and which ones wait now.
export type ReadApprovalLink = { connectionId: string; url: string; expiresAt: string; operationIds: string[] };

// What an approval link would approve now. fingerprint names exactly this list: the page sends it back with the person's
// decision, so approve() approves the reads the person saw and none the adapter gained or changed since.
export type ReadApprovalView = {
  connectionId: string;
  connectionLabel: string;
  reads: PendingRead[];
  fingerprint: string;
};

// approved: the reads are approved and the link is used. changed: the reads that wait are not the ones shown, so nothing
// was approved and the link still works. invalid: the link does not work (expired, used, or another connection's).
export type ReadApprovalOutcome =
  | { kind: "approved"; operationIds: string[] }
  | { kind: "changed" }
  | { kind: "invalid" };

export type ReadApprovalServiceDependencies = {
  db: Database.Database;
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  approvals: ReadApprovalRepository;
  links: ConnectionActionLinkRepository;
  // The local version's setup token while no administrator exists, or null: the approval page is behind the sign-in, so
  // its link carries it (see withSetupToken).
  setupToken?: () => string | null;
};

type PendingForm = PendingRead & { form: string };

function fingerprintOf(pending: readonly PendingForm[]): string {
  return createHash("sha256").update(pending.map(({ form }) => form).sort().join(",")).digest("base64url");
}

// The person's approval of reads sent with POST. The assistant gets a one-time link; the person sees every read of the
// connection's adapter that waits and allows them all as reads, or none. The approval is for the connection and for each
// operation as it is now: an edited operation waits again. A host that serves its own page calls open, approve and
// decline with the link's token, as the core's page does.
export class ReadApprovalService {
  constructor(private readonly deps: ReadApprovalServiceDependencies) {}

  // The reads sent with POST of the connection's adapter that neither the person nor the catalog approved, in the
  // adapter's order. None for a connection without an adapter.
  pending(connectionId: string): PendingRead[] {
    return this.pendingForms(connectionId).map(({ form: _form, ...read }) => read);
  }

  pendingCount(connectionId: string): number {
    return this.pendingForms(connectionId).length;
  }

  // A one-time link to the approval page, under baseUrl, or null when nothing waits. It works for
  // READ_APPROVAL_LINK_TTL_MS and leaves the connection's earlier approval links working.
  link(connectionId: string, baseUrl: string): ReadApprovalLink | null {
    const pending = this.pendingForms(connectionId);
    if (pending.length === 0) return null;
    const { token, expiresAt } = this.deps.links.issue(connectionId, "approve_reads");
    return {
      connectionId,
      url: withSetupToken(`${baseUrl.replace(/\/+$/u, "")}${READ_APPROVAL_PATH}/${connectionId}?t=${token}`, this.deps.setupToken?.() ?? null),
      expiresAt,
      operationIds: pending.map(({ operationId }) => operationId),
    };
  }

  // Links for every connection the adapter serves whose reads wait, for the tool that edited it.
  linksForAdapter(adapterId: string, baseUrl: string): ReadApprovalLink[] {
    return this.deps.connections.listIdsByAdapter(adapterId)
      .map((connectionId) => this.link(connectionId, baseUrl))
      .filter((link): link is ReadApprovalLink => link !== null);
  }

  // What the link would approve now, or null when it does not work. The list may be empty: everything was approved
  // since the link was given.
  open(connectionId: string, token: string): ReadApprovalView | null {
    if (!this.deps.links.verify(connectionId, "approve_reads", token)) return null;
    const pending = this.pendingForms(connectionId);
    return {
      connectionId,
      connectionLabel: this.deps.connections.getConnection(connectionId).label,
      reads: pending.map(({ form: _form, ...read }) => read),
      fingerprint: fingerprintOf(pending),
    };
  }

  // The person's "allow as reads" for the list they were shown, named by its fingerprint. The link is used by it.
  approve(connectionId: string, token: string, fingerprint: string): ReadApprovalOutcome {
    return this.deps.db.transaction((): ReadApprovalOutcome => {
      if (!this.deps.links.verify(connectionId, "approve_reads", token)) return { kind: "invalid" };
      const pending = this.pendingForms(connectionId);
      if (pending.length === 0 || fingerprintOf(pending) !== fingerprint) return { kind: "changed" };
      if (!this.deps.links.consume(connectionId, "approve_reads", token)) return { kind: "invalid" };
      this.deps.approvals.record(connectionId, pending.map(({ form }) => form), "person");
      return { kind: "approved", operationIds: pending.map(({ operationId }) => operationId) };
    })();
  }

  // The person's "don't allow": nothing is approved, and the link is used. False when the link does not work.
  decline(connectionId: string, token: string): boolean {
    return this.deps.links.consume(connectionId, "approve_reads", token);
  }

  private pendingForms(connectionId: string): PendingForm[] {
    const connection = this.deps.connections.getConnection(connectionId);
    if (connection.adapterId === null) return [];
    const { dsl } = this.deps.adapters.get(connection.adapterId);
    const approved = this.deps.approvals.approvedForms(connectionId);
    const pending: PendingForm[] = [];
    for (const operation of dsl.operations) {
      if (!readsThroughPost(operation)) continue;
      const form = readForm(dsl, operation);
      if (approved.has(form)) continue;
      const origin = operation.origin ?? dsl.baseOrigins[0] ?? "";
      pending.push({
        operationId: operation.id,
        method: operation.method,
        url: `${origin}${operation.path}`,
        description: operation.description,
        inputs: inputsOf(operation),
        form,
      });
    }
    return pending;
  }
}
