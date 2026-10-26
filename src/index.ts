import type Database from "better-sqlite3";
import { join } from "node:path";

import { AdapterRepository } from "./adapters/repository.js";
import { AuditRepository } from "./audit/repository.js";
import { AuthRepository } from "./auth/repository.js";
import { SetupToken } from "./auth/setup-token.js";
import { createLocalCatalog, type LocalCatalog } from "./catalog/local.js";
import type { CatalogSource } from "./catalog/source.js";
import { localWritePolicy, type WritePolicy } from "./changes/policy.js";
import { ChangeRequestRepository } from "./changes/repository.js";
import { ChangeService, type ChangeFinishedObserver, type RequestedVia } from "./changes/service.js";
import { ChangeSettings } from "./changes/settings.js";
import { localBaseUrl, type AppConfig } from "./config.js";
import { ConnectionActionLinkRepository } from "./connections/action-links.js";
import { ConnectionRepository } from "./connections/repository.js";
import { migrateDatabase, openDatabase } from "./db/database.js";
import { crawlDocumentation } from "./docs/crawler.js";
import { DOCUMENT_LIMITS, DocumentLimitError, DocumentRepository } from "./docs/documents.js";
import { DEFAULT_MAX_DOCUMENT_BYTES, DocumentationIntake } from "./docs/intake.js";
import { DocsRepository } from "./docs/repository.js";
import { extractSpecLinks } from "./docs/spec-links.js";
import { DiscoveryCollector } from "./discovery/collector.js";
import { DraftLinkRepository } from "./discovery/links.js";
import { ConnectionDraftRepository } from "./discovery/repository.js";
import { ConnectionDiscoveryService } from "./discovery/service.js";
import { JobRepository } from "./jobs/repository.js";
import { JobRunner } from "./jobs/runner.js";
import type { ToolDependencies } from "./mcp/tools.js";
import { ReadApprovalRepository } from "./reads/repository.js";
import { ReadApprovalService } from "./reads/service.js";
import { AdapterRuntime } from "./runtime/runtime.js";
import {
  guardedFetch,
  publicAddressFetch,
  ResponseByteLimitError,
  systemResolver,
  type FetchImplementation,
  type HostResolver,
} from "./security/network-policy.js";
import { unlimitedUsage, type UsageGate } from "./usage/gate.js";
import { Vault } from "./vault/vault.js";
import { TunnelRepository } from "./tunnel/repository.js";
import { TunnelSupervisor, type ProcessLauncher } from "./tunnel/supervisor.js";

export type ApplicationOverrides = {
  resolver?: HostResolver;
  fetchImpl?: FetchImplementation;
  launchTunnelProcess?: ProcessLauncher;
  usage?: UsageGate;
  // The shared catalog of ready-made adapters. A host passes its own; the local version uses the cloud's catalog when
  // the configuration names its address. Without either, every connection is built from its documentation.
  catalog?: CatalogSource;
  // Whether changes to the person's data may run now, and where the person turns them on. Local: always, on the
  // connection's page.
  writes?: WritePolicy;
  // Which assistant asks for a change, looked up when request_change runs, for tools that do not name it themselves.
  requestedVia?: RequestedVia;
  // Hears how every change the person confirmed ended once it ran. The local version passes none.
  onChangeFinished?: ChangeFinishedObserver;
};

export type Application = {
  config: AppConfig;
  db: Database.Database;
  adapters: AdapterRepository;
  connections: ConnectionRepository;
  docs: DocsRepository;
  documents: DocumentRepository;
  intake: DocumentationIntake;
  drafts: ConnectionDraftRepository;
  discovery: ConnectionDiscoveryService;
  links: DraftLinkRepository;
  actionLinks: ConnectionActionLinkRepository;
  // The person's approval of reads sent with POST, through a one-time link like the deletion's.
  readApprovals: ReadApprovalService;
  keyEntryBaseUrl: string;
  vault: Vault;
  audits: AuditRepository;
  auth: AuthRepository;
  // The token for creating the local administrator; null where the configuration names no place for it.
  setupToken: SetupToken | null;
  jobs: JobRepository;
  jobRunner: JobRunner;
  tunnels: TunnelRepository;
  tunnel: TunnelSupervisor;
  runtime: AdapterRuntime;
  usage: UsageGate;
  // Changes the assistant asks for and the person confirms on a page, and each connection's switch for them.
  changes: ChangeService;
  // The local version's sign-in to the shared catalog; null when the configuration names no catalog address.
  localCatalog: LocalCatalog | null;
  mcpDependencies: ToolDependencies;
  crawlSource(sourceId: string): Promise<void>;
};

export function buildApplication(
  config: AppConfig,
  overrides: ApplicationOverrides = {},
): Application {
  const db = openDatabase(config.dbPath);
  migrateDatabase(db);
  const adapters = new AdapterRepository(db);
  const connections = new ConnectionRepository(db);
  const docs = new DocsRepository(db);
  const documents = new DocumentRepository(db);
  const vault = new Vault(db, config.masterKey);
  const audits = new AuditRepository(db);
  const auth = new AuthRepository(db);
  const setupToken = config.setupTokenPath === undefined ? null : new SetupToken(config.setupTokenPath);
  // While no administrator exists, the links that lead through the sign-in carry the setup token, so the first of them
  // takes the person through creating one.
  const linkSetupToken = (): string | null => (setupToken === null || auth.isSetup() ? null : setupToken.issue());
  const jobs = new JobRepository(db);
  const drafts = new ConnectionDraftRepository(db);
  const approvedReads = new ReadApprovalRepository(db);
  const discovery = new ConnectionDiscoveryService({
    db,
    adapters,
    connections,
    drafts,
    jobs,
    documents,
    vault,
    readApprovals: approvedReads,
  });
  const links = new DraftLinkRepository(db);
  const actionLinks = new ConnectionActionLinkRepository(db);
  const readApprovals = new ReadApprovalService({
    db,
    adapters,
    connections,
    approvals: approvedReads,
    links: actionLinks,
    ...(setupToken ? { setupToken: linkSetupToken } : {}),
  });
  const tunnels = new TunnelRepository(db);
  const resolver = overrides.resolver ?? systemResolver;
  const fetchImpl = overrides.fetchImpl ?? publicAddressFetch(resolver);
  const usage = overrides.usage ?? unlimitedUsage;
  const intake = new DocumentationIntake({
    documents,
    resolver,
    fetchImpl,
    timeoutMs: config.requestTimeoutMs,
    maxDocumentBytes: config.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    usage,
  });
  const runtime = new AdapterRuntime({
    adapters,
    connections,
    vault,
    audits,
    resolver,
    fetchImpl,
    requestTimeoutMs: config.requestTimeoutMs,
    maxResponseBytes: config.maxResponseBytes,
    usage,
    readApprovals: approvedReads,
    ...(config.maxUpstreamBytes === undefined ? {} : { maxUpstreamBytes: config.maxUpstreamBytes }),
  });
  const changes = new ChangeService({
    adapters,
    connections,
    vault,
    runtime,
    changes: new ChangeRequestRepository(db, { requestTimeoutMs: config.requestTimeoutMs }),
    settings: new ChangeSettings(db),
    writes: overrides.writes ?? localWritePolicy,
    ...(setupToken ? { setupToken: linkSetupToken } : {}),
    ...(overrides.requestedVia ? { requestedVia: overrides.requestedVia } : {}),
    ...(overrides.onChangeFinished ? { onChangeFinished: overrides.onChangeFinished } : {}),
  });
  const crawlSource = async (sourceId: string): Promise<void> => {
    const source = connections.getDocumentationSource(sourceId);
    // The crawl is long, so the draft is re-read each time it is needed instead of trusting a snapshot.
    const discoveringDraft = () => {
      const current = drafts.findByDocumentationSource(sourceId);
      return current?.status === "discovering" ? current : null;
    };
    const collector = new DiscoveryCollector();
    const specLinks = new Set<string>();
    let crawled: Awaited<ReturnType<typeof crawlDocumentation>>;
    try {
      crawled = await crawlDocumentation(source, {
        maxPages: config.maxCrawlPages,
        repository: docs,
        fetchPage: async (url) => {
          // A refusal (UsageLimitError) stops the whole crawl, so the draft goes back for documentation.
          await usage.beforeDocumentation();
          let response: Response;
          try {
            response = await guardedFetch(url, { method: "GET" }, {
              allowedOrigins: [source.allowedOrigin],
              resolver,
              fetchImpl,
              timeoutMs: config.requestTimeoutMs,
              maxResponseBytes: config.maxResponseBytes,
            });
          } catch (error) {
            // The page was read up to the limit before the download was cut off.
            if (error instanceof ResponseByteLimitError) await usage.afterDocumentation(config.maxResponseBytes);
            throw error;
          }
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`Documentation page returned HTTP ${response.status}`);
          }
          const body = await response.arrayBuffer();
          await usage.afterDocumentation(body.byteLength);
          return {
            url: response.url || url,
            contentType: response.headers.get("content-type") ?? "text/plain",
            body: new TextDecoder().decode(body),
          };
        },
        observePage: (page) => {
          collector.observe(page);
          if (page.contentType.toLocaleLowerCase("en-US").includes("html")) {
            for (const link of extractSpecLinks(page.body, page.url)) specLinks.add(link);
          }
        },
      });
    } catch (error) {
      const draft = discoveringDraft();
      if (draft) {
        drafts.markDocumentationUnavailable(draft.id);
        return;
      }
      throw error;
    }
    try {
      try {
        documents.add({
          sourceId,
          url: source.rootUrl,
          kind: "html",
          provenance: "official",
          sha256: crawled.contentFingerprint,
          byteSize: crawled.byteSize,
          discovery: collector.result(),
          chunks: [],
        }, DOCUMENT_LIMITS.maxCrawlDocuments);
      } catch (error) {
        // The crawled page is bookkeeping: a source that is already full still has documents to refresh from.
        if (!(error instanceof DocumentLimitError)) throw error;
      }
      if (specLinks.size > 0) await intake.attachCrawlSpecLinks(source, [...specLinks]);
      const draft = discoveringDraft();
      if (draft) discovery.refreshFromDocuments(draft.id);
    } catch (error) {
      // The job still records the failure, but the draft must not wait for a crawl that is over.
      const draft = discoveringDraft();
      if (draft) drafts.markDocumentationUnavailable(draft.id);
      throw error;
    }
  };
  // A crawl that kept crashing the service is given up, and its draft goes back to the person or their AI.
  const abandonCrawl = (sourceId: string): void => {
    docs.markFailed(sourceId, "crawl");
    const draft = drafts.findByDocumentationSource(sourceId);
    if (draft?.status === "discovering") drafts.markDocumentationUnavailable(draft.id);
  };
  const jobRunner = new JobRunner(
    jobs,
    { crawl_documentation: crawlSource },
    { categorizeError: () => "crawl", onAbandoned: (job) => abandonCrawl(job.subjectId) },
  );
  const keyEntryBaseUrl = localBaseUrl(config);
  const localCatalog = config.catalogOrigin === undefined
    ? null
    : createLocalCatalog({
      db,
      vault,
      origin: config.catalogOrigin,
      followStoredOrigin: config.catalogOriginExplicit === false,
      baseUrl: keyEntryBaseUrl,
      resolver,
      fetchImpl,
    });
  const catalog = overrides.catalog ?? localCatalog?.source;
  const mcpDependencies: ToolDependencies = {
    db,
    adapters,
    connections,
    docs,
    runtime,
    audits,
    changes,
    readApprovals,
    vault,
    onboarding: {
      discovery,
      drafts,
      documents,
      intake,
      links,
      actionLinks,
      connections,
      keyEntryBaseUrl,
      usage,
      ...(catalog ? { catalog } : {}),
      ...(setupToken ? { setupToken: linkSetupToken } : {}),
      drainJobs: async () => {
        while (await jobRunner.runOne()) {
          // Run queued crawls inline so stdio and HTTP clients both see results.
        }
      },
    },
  };
  const tunnel = new TunnelSupervisor(tunnels, {
    runtimeKeyProvider: async (credentialSetId) => tunnelRuntimeKey(vault, credentialSetId),
    mcpServerUrl: `${keyEntryBaseUrl}/mcp`,
    ...(config.mcpToken === undefined ? {} : { mcpToken: config.mcpToken }),
    profileDir: join(config.stateDir, "tunnel-client"),
    binDir: config.binDir,
    ...(overrides.launchTunnelProcess ? { launch: overrides.launchTunnelProcess } : {}),
  });

  return {
    config,
    db,
    adapters,
    connections,
    docs,
    documents,
    intake,
    drafts,
    discovery,
    links,
    actionLinks,
    readApprovals,
    keyEntryBaseUrl,
    vault,
    audits,
    auth,
    setupToken,
    jobs,
    jobRunner,
    tunnels,
    tunnel,
    runtime,
    usage,
    changes,
    localCatalog,
    mcpDependencies,
    crawlSource,
  };
}

// The tunnel client's runtime key, sealed in the vault when the person configured the tunnel.
async function tunnelRuntimeKey(vault: Vault, credentialSetId: string): Promise<string> {
  return vault.withCredentials(credentialSetId, async (fields) => {
    const key = fields.CONTROL_PLANE_API_KEY;
    if (!key) throw new Error("Tunnel runtime key is not configured");
    return key;
  });
}
