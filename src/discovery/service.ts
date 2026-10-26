import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type { AdapterRecord, AdapterRepository } from "../adapters/repository.js";
import { catalogSlug, validateCatalogEntry } from "../catalog/entry.js";
import type { CatalogEntry } from "../catalog/source.js";
import type { ConnectionRecord, ConnectionRepository } from "../connections/repository.js";
import { flushErasedData } from "../db/database.js";
import { InputError } from "../domain/types.js";
import type { DocumentRepository } from "../docs/documents.js";
import type { JobRepository } from "../jobs/repository.js";
import { catalogApprovedForms, type ReadApprovalRepository } from "../reads/repository.js";
import { assertPublicHttpsOriginLiteral, NetworkPolicyError } from "../security/network-policy.js";
import type { Vault } from "../vault/vault.js";
import { stableId } from "./collector.js";
import { sameRegistrableDomain } from "./domain.js";
import { discoveryFromAdapter } from "./registry.js";
import {
  type ConnectionDraftRecord,
  type ConnectionDraftRepository,
} from "./repository.js";
import { DiscoveryResultSchema, type CredentialKind, type DiscoveryResult } from "./schema.js";
import { mergeTrustedDiscovery } from "./trust.js";

export type ConnectionDiscoveryServiceDependencies = {
  db: Database.Database;
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  drafts: ConnectionDraftRepository;
  jobs: JobRepository;
  documents: DocumentRepository;
  vault: Pick<Vault, "storeFields">;
  // Where a connection made from a catalog copy gets the catalog's approval of its reads sent with POST. Without it the
  // person approves them, as for any other adapter.
  readApprovals?: Pick<ReadApprovalRepository, "record">;
};

function normalizeDocumentationUrl(documentationUrl: string): URL {
  let url: URL;
  try {
    url = new URL(documentationUrl);
  } catch {
    throw new InputError("Documentation URL must be a full address, such as https://docs.example.com/api");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new InputError("Documentation URL must use HTTPS and contain no credentials");
  }
  url.hash = "";
  return url;
}

// An API address the person typed, as its origin, or the reason it cannot be one.
function typedOrigin(value: string): string {
  try {
    return assertPublicHttpsOriginLiteral(value);
  } catch (error) {
    if (error instanceof NetworkPolicyError) throw new InputError(error.message);
    if (error instanceof TypeError) throw new InputError("API origin must be a full address, such as https://api.example.com");
    throw error;
  }
}

function sameSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export class ConnectionDiscoveryService {
  constructor(private readonly dependencies: ConnectionDiscoveryServiceDependencies) {}

  begin(documentationUrl: string): ConnectionDraftRecord {
    const url = normalizeDocumentationUrl(documentationUrl);
    return this.dependencies.db.transaction(() => {
      const draft = this.createDraft(url);
      this.dependencies.jobs.enqueue("crawl_documentation", draft.documentationSourceId);
      return draft;
    })();
  }

  // The draft that start() would resume for this link, if any.
  findOpen(documentationUrl: string): ConnectionDraftRecord | null {
    return this.dependencies.drafts.findOpenByRootUrl(normalizeDocumentationUrl(documentationUrl).toString());
  }

  // Whether start() would reuse one of this database's own reusable adapters for the link.
  hasReusableAdapter(documentationUrl: string): boolean {
    return this.reusableFor(normalizeDocumentationUrl(documentationUrl).toString()) !== null;
  }

  start(documentationUrl: string): ConnectionDraftRecord {
    const url = normalizeDocumentationUrl(documentationUrl);
    const open = this.dependencies.drafts.findOpenByRootUrl(url.toString());
    if (open) return open;
    const reusable = this.reusableFor(url.toString());
    if (!reusable) return this.begin(url.toString());
    const { adapter, discovery } = reusable;
    return this.dependencies.db.transaction(() => {
      const draft = this.createDraft(url);
      return this.dependencies.drafts.refreshDiscovery(draft.id, discovery, {
        kind: "registry",
        adapterId: adapter.id,
        adapterSlug: adapter.slug,
        adapterVersion: adapter.version,
      });
    })();
  }

  // The entry is copied into this database and the draft goes straight to key entry. The key-entry page still shows
  // every destination for the person to approve, so an entry cannot send keys anywhere they did not agree to.
  startFromCatalog(documentationUrl: string, entryInput: CatalogEntry): ConnectionDraftRecord {
    const url = normalizeDocumentationUrl(documentationUrl);
    const entry = validateCatalogEntry(entryInput, url.toString());
    if (!entry) throw new Error("The catalog entry does not fit this documentation link");
    return this.dependencies.db.transaction(() => {
      const draft = this.createDraft(url);
      const copy = this.dependencies.adapters.createCatalogCopy({
        slug: catalogSlug(entry),
        displayName: entry.displayName,
        documentationSourceId: draft.documentationSourceId,
        dsl: entry.dsl,
        catalogEntryId: entry.entryId,
        catalogVersion: entry.version,
      });
      return this.dependencies.drafts.refreshDiscovery(draft.id, discoveryFromAdapter(copy, url.toString()), {
        kind: "catalog",
        entryId: entry.entryId,
        version: entry.version,
      });
    })();
  }

  proposeSettings(
    draftId: string,
    input: {
      serviceName: string;
      origins: string[];
      credentials: Array<{ fieldName: string; kind: CredentialKind; humanLabel: string }>;
      rationale: string;
    },
  ): ConnectionDraftRecord {
    const draft = this.dependencies.drafts.get(draftId);
    if (draft.status !== "needs_help" || draft.helpReason !== "documentation_unavailable") {
      throw new Error("Settings can be proposed only when documentation is unavailable");
    }
    if (input.origins.length === 0 || input.origins.length > 10) throw new Error("Propose between 1 and 10 API origins");
    if (input.credentials.length === 0 || input.credentials.length > 20) throw new Error("Propose between 1 and 20 credential fields");
    const fieldNames = new Set<string>();
    for (const { fieldName } of input.credentials) {
      const key = fieldName.toLocaleLowerCase("en-US");
      if (fieldNames.has(key)) throw new Error(`Credential field ${fieldName} is proposed more than once`);
      fieldNames.add(key);
    }
    const source = this.dependencies.connections.getDocumentationSource(draft.documentationSourceId);
    const origins = [...new Set(input.origins.map((value) => {
      const origin = assertPublicHttpsOriginLiteral(value);
      if (!sameRegistrableDomain(origin, source.rootUrl)) {
        throw new Error(`Origin ${origin} is outside the documentation link's domain`);
      }
      return origin;
    }))];
    const serviceName = input.serviceName.trim().slice(0, 120) || "API connection";
    const evidence = [{
      pageUrl: source.rootUrl,
      kind: "model_proposal" as const,
      excerpt: "Proposed by the connected AI without documentation",
    }];
    const result = DiscoveryResultSchema.parse({
      serviceName,
      suggestedLabel: serviceName,
      origins: origins.map((origin) => ({
        id: stableId("origin", origin),
        origin,
        serviceLabel: serviceName,
        confidence: "high",
        evidence,
        observationCount: 1,
      })),
      credentials: input.credentials.map((credential) => ({
        id: stableId("credential", credential.fieldName),
        fieldName: credential.fieldName,
        kind: credential.kind,
        placement: "header",
        humanLabel: credential.humanLabel.slice(0, 120),
        confidence: "high",
        evidence,
      })),
      unsupportedAuthMethods: [],
    });
    return this.dependencies.drafts.refreshDiscovery(draftId, result, {
      kind: "model_settings",
      rationale: input.rationale.slice(0, 1_000),
    });
  }

  completeWithSelection(
    draftId: string,
    input: { originIds: string[]; credentialIds: string[]; credentialValues: Record<string, string> },
  ): ConnectionRecord {
    // One transaction: a failed completion also rolls the selection back, so the person can re-pick.
    return this.dependencies.db.transaction(() => {
      let draft = this.dependencies.drafts.get(draftId);
      if (draft.status === "needs_review") {
        draft = this.select(draftId, { originIds: input.originIds, credentialIds: input.credentialIds });
      } else if (draft.status === "ready") {
        this.assertSameSelection(draft, input);
      }
      const selected = new Set((draft.selectedCredentials ?? []).map(({ id }) => id));
      const credentialValues: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [id, value] of Object.entries(input.credentialValues)) {
        if (selected.has(id)) credentialValues[id] = value;
      }
      return this.complete(draftId, { credentialValues });
    })();
  }

  refreshFromDocuments(draftId: string): ConnectionDraftRecord {
    const draft = this.dependencies.drafts.get(draftId);
    const source = this.dependencies.connections.getDocumentationSource(draft.documentationSourceId);
    const documents = this.dependencies.documents.list(source.id);
    const trusted = mergeTrustedDiscovery(source.rootUrl, documents);
    return this.dependencies.drafts.refreshDiscovery(draftId, trusted.result, {
      kind: "documents",
      documents: documents.slice(0, 40).map((document) => ({
        url: document.url.slice(0, 2_000),
        kind: document.kind,
        provenance: document.provenance,
        fetchedAt: document.fetchedAt,
        sha256: document.sha256,
      })),
      discardedOrigins: trusted.discardedOrigins.map(({ origin, reason }) => ({
        origin: origin.slice(0, 300),
        reason,
      })),
    });
  }

  select(
    draftId: string,
    input: { originIds: string[]; credentialIds: string[] },
  ): ConnectionDraftRecord {
    return this.dependencies.drafts.select(draftId, input);
  }

  selectAdvanced(
    draftId: string,
    input: { origins: string[]; credentialNames: string[]; label?: string },
  ): ConnectionDraftRecord {
    if (input.origins.length === 0) throw new InputError("Enter the API address");
    if (input.origins.length > 10) throw new InputError("At most 10 API origins are supported");
    return this.dependencies.drafts.selectAdvanced(draftId, {
      ...input,
      origins: input.origins.map(typedOrigin),
    });
  }

  // New values for the same fields of a finished connection, for example after the person issues a new token.
  // Destinations, label, and adapter stay as they are.
  replaceKeys(draftId: string, values: Record<string, string>): ConnectionRecord {
    const draft = this.dependencies.drafts.get(draftId);
    if (draft.status !== "completed" || !draft.completedConnectionId) {
      throw new Error("Keys can be replaced only for a finished connection");
    }
    const connection = this.dependencies.connections.getConnection(draft.completedConnectionId);
    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const { fieldName } of connection.credentials) {
      const value = Object.hasOwn(values, fieldName) ? values[fieldName] : undefined;
      if (typeof value !== "string" || value.length === 0) throw new InputError(`Enter a new value for ${fieldName}`);
      fields[fieldName] = value;
    }
    if (Object.keys(values).length !== connection.credentials.length) {
      throw new InputError("Key values must match the connection's key fields exactly");
    }
    this.dependencies.vault.storeFields(connection.credentialSetId, fields);
    flushErasedData(this.dependencies.db);
    return connection;
  }

  complete(
    draftId: string,
    input: { credentialValues: Record<string, string> },
  ): ConnectionRecord {
    const draft = this.dependencies.drafts.get(draftId);
    if (draft.status !== "ready" || !draft.selectedOrigins || !draft.selectedCredentials) {
      throw new Error("Draft must be ready before completion");
    }
    const expectedIds = draft.selectedCredentials.map(({ id }) => id).sort();
    const providedIds = Object.keys(input.credentialValues).sort();
    if (
      expectedIds.length !== providedIds.length ||
      !expectedIds.every((candidateId, index) => candidateId === providedIds[index])
    ) {
      throw new InputError("Credential values must match the selected credential fields exactly");
    }

    const fields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const credential of draft.selectedCredentials) {
      const value = input.credentialValues[credential.id];
      if (typeof value !== "string" || value.length === 0) {
        throw new InputError(`Credential value is required for ${credential.humanLabel}`);
      }
      fields[credential.fieldName] = value;
    }

    const baseLabel = (draft.suggestedLabel ?? draft.serviceName ?? "API connection").trim();
    const label = this.uniqueLabel(baseLabel === "" ? "API connection" : baseLabel);
    const credentialSetId = randomUUID();
    const summary = draft.provenanceSummary;
    // A catalog draft brought its own copy of the adapter; any other draft takes a matching reusable one, if any.
    const adapter = summary?.kind === "catalog"
      ? this.dependencies.adapters.findCatalogCopy(draft.documentationSourceId, summary.entryId)
      : this.dependencies.adapters.findReusableMatch({
        origins: draft.selectedOrigins,
        credentialNames: draft.selectedCredentials.map(({ fieldName }) => fieldName),
      });

    return this.dependencies.db.transaction(() => {
      this.dependencies.vault.storeFields(credentialSetId, fields);
      const connection = this.dependencies.connections.createConnection({
        label,
        documentationSourceId: draft.documentationSourceId,
        allowedOrigins: draft.selectedOrigins!,
        credentialSetId,
        ...(adapter ? { adapterId: adapter.id } : {}),
      });
      // A copy still as the catalog published it brings the moderation's approval of its reads sent with POST.
      if (adapter && summary?.kind === "catalog") {
        this.dependencies.readApprovals?.record(connection.id, catalogApprovedForms(adapter), "catalog");
      }
      this.dependencies.drafts.markCompleted(draft.id, connection.id);
      return connection;
    })();
  }

  retry(draftId: string): ConnectionDraftRecord {
    return this.dependencies.db.transaction(() => {
      const draft = this.dependencies.drafts.resetForRetry(draftId);
      this.dependencies.jobs.enqueue("crawl_documentation", draft.documentationSourceId);
      return draft;
    })();
  }

  private createDraft(url: URL): ConnectionDraftRecord {
    const source = this.dependencies.connections.createDocumentationSource({
      rootUrl: url.toString(),
      allowedOrigin: url.origin,
    });
    return this.dependencies.drafts.create({ documentationSourceId: source.id });
  }

  private reusableFor(url: string): { adapter: AdapterRecord; discovery: DiscoveryResult } | null {
    const adapter = this.dependencies.adapters.findReusableForDocumentation(url);
    if (!adapter) return null;
    try {
      return { adapter, discovery: discoveryFromAdapter(adapter, url) };
    } catch (error) {
      // An adapter whose settings do not fit the discovery schema must not block the domain.
      if (error instanceof ZodError) return null;
      throw error;
    }
  }

  // Empty ids mean "use the stored selection"; non-empty ids must not contradict it.
  private assertSameSelection(
    draft: ConnectionDraftRecord,
    input: { originIds: string[]; credentialIds: string[] },
  ): void {
    const requestedOrigins = input.originIds.map((id) => draft.discovery.origins.find((candidate) => candidate.id === id)?.origin ?? id);
    const storedOrigins = draft.selectedOrigins ?? [];
    const storedCredentials = (draft.selectedCredentials ?? []).map(({ id }) => id);
    if (
      (input.originIds.length > 0 && !sameSet(requestedOrigins, storedOrigins)) ||
      (input.credentialIds.length > 0 && !sameSet(input.credentialIds, storedCredentials))
    ) {
      throw new Error("Draft already has a different selection of API origins or credential fields");
    }
  }

  private uniqueLabel(baseLabel: string): string {
    const existing = new Set(
      this.dependencies.connections.listConnections().map(({ label }) => label.toLocaleLowerCase()),
    );
    if (!existing.has(baseLabel.toLocaleLowerCase())) return baseLabel.slice(0, 200);
    let suffix = 2;
    while (existing.has(`${baseLabel} ${suffix}`.toLocaleLowerCase())) suffix += 1;
    const suffixText = ` ${suffix}`;
    return `${baseLabel.slice(0, 200 - suffixText.length)}${suffixText}`;
  }
}
