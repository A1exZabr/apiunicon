import Database from "better-sqlite3";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../src/config.js";
import { flushErasedData, openDatabase } from "../../src/db/database.js";
import { buildHttpServer } from "../../src/http/server.js";
import { buildApplication, type Application, type ApplicationOverrides } from "../../src/index.js";
import type { ProcessLauncher, SpawnedProcess } from "../../src/tunnel/supervisor.js";
import { form, LOCAL, setupAdmin, setupTokenPath } from "../http/helpers.js";

describe("erasing keys", () => {
  let application: Application | undefined;
  let reader: Database.Database | undefined;
  let directory: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    reader?.close();
    reader = undefined;
    application?.db.close();
    application = undefined;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function fileApplication(overrides: ApplicationOverrides = {}): Application {
    directory = mkdtempSync(join(tmpdir(), "apiunicon-erasure-"));
    const config: AppConfig = {
      setupTokenPath: setupTokenPath(),
      stateDir: directory, binDir: directory, dbPath: join(directory, "apiunicon.sqlite"), masterKey: Buffer.alloc(32, 31),
      httpHost: "127.0.0.1", httpPort: 3210, maxResponseBytes: 32_768, requestTimeoutMs: 1_000, maxCrawlPages: 5,
    };
    application = buildApplication(config, {
      resolver: async () => ["8.8.8.8"], fetchImpl: async () => new Response(""), ...overrides,
    });
    return application;
  }

  function onDisk(): string {
    const read = (suffix: string) => {
      try {
        return readFileSync(join(directory!, `apiunicon.sqlite${suffix}`)).toString("latin1");
      } catch {
        return "";
      }
    };
    return read("") + read("-wal");
  }

  function storedCiphertext(app: Application, credentialSetId: string): string {
    return (app.db.prepare("select ciphertext from credential_fields where credential_set_id = ?").get(credentialSetId) as { ciphertext: string }).ciphertext;
  }

  function connectionWithKey(app: Application): { connectionId: string; ciphertext: string } {
    const source = app.connections.createDocumentationSource({ rootUrl: "https://docs.shop.test/api", allowedOrigin: "https://docs.shop.test" });
    app.vault.storeFields("credentials-1", { "X-Shop-Key": "shop-secret" });
    const connection = app.connections.createConnection({
      label: "Shop", documentationSourceId: source.id, allowedOrigins: ["https://api.shop.test"], credentialSetId: "credentials-1",
    });
    return { connectionId: connection.id, ciphertext: storedCiphertext(app, "credentials-1") };
  }

  // A second connection inside a read transaction keeps an older snapshot, so the journal cannot be truncated yet.
  function openReader(): Database.Database {
    reader = new Database(join(directory!, "apiunicon.sqlite"));
    reader.exec("begin");
    reader.prepare("select count(*) from credential_fields").get();
    return reader;
  }

  it("leaves no trace of a deleted connection's key in the database file or its journal", () => {
    const app = fileApplication();
    const { connectionId, ciphertext } = connectionWithKey(app);
    expect(onDisk()).toContain(ciphertext);

    app.connections.delete(connectionId);

    expect(onDisk()).not.toContain(ciphertext);
  });

  it("leaves no trace of a replaced key", () => {
    const app = fileApplication();
    const started = app.discovery.start("https://docs.shop.test/api");
    app.drafts.markDocumentationUnavailable(started.id);
    const draft = app.discovery.proposeSettings(started.id, {
      serviceName: "Shop",
      origins: ["https://api.shop.test"],
      credentials: [{ fieldName: "X-Shop-Key", kind: "api_key", humanLabel: "API key" }],
      rationale: "test",
    });
    const candidate = draft.discovery.credentials[0]!;
    const connection = app.discovery.completeWithSelection(draft.id, {
      originIds: draft.discovery.origins.map(({ id }) => id),
      credentialIds: [candidate.id],
      credentialValues: { [candidate.id]: "old-shop-secret" },
    });
    const ciphertext = storedCiphertext(app, connection.credentialSetId);
    expect(onDisk()).toContain(ciphertext);

    app.discovery.replaceKeys(draft.id, { "X-Shop-Key": "new-shop-secret" });

    expect(onDisk()).not.toContain(ciphertext);
  });

  it("erases a deleted key from the journal once another reader has finished", async () => {
    vi.useFakeTimers();
    const app = fileApplication();
    const { connectionId, ciphertext } = connectionWithKey(app);
    const open = openReader();

    app.connections.delete(connectionId);

    expect(onDisk()).toContain(ciphertext);
    expect(app.db.pragma("busy_timeout", { simple: true })).toBe(5_000);
    open.exec("commit");
    open.close();
    reader = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDisk()).not.toContain(ciphertext);
  });

  it("does not throw inside a transaction and flushes once the transaction is over", async () => {
    vi.useFakeTimers();
    const app = fileApplication();
    const { connectionId, ciphertext } = connectionWithKey(app);
    let flushed: boolean | undefined;

    expect(() => app.db.transaction(() => {
      app.connections.delete(connectionId);
      flushed = flushErasedData(app.db);
    })()).not.toThrow();

    expect(flushed).toBe(false);
    expect(onDisk()).toContain(ciphertext);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onDisk()).not.toContain(ciphertext);
  });

  it("keeps one retry chain per database and warns without values when the journal stays busy", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const app = fileApplication();
    const { connectionId } = connectionWithKey(app);
    openReader();

    app.connections.delete(connectionId);
    expect(vi.getTimerCount()).toBe(1);
    expect(flushErasedData(app.db)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000);
    expect(warning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("Erased data may remain in the database journal until the next restart");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying silently once the database is closed", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const app = fileApplication();
    const { connectionId } = connectionWithKey(app);
    openReader();
    app.connections.delete(connectionId);

    app.db.close();
    application = undefined;
    await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000 + 120_000);

    expect(warning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a journal left behind by an earlier process when the database is opened", () => {
    directory = mkdtempSync(join(tmpdir(), "apiunicon-erasure-"));
    const path = join(directory, "apiunicon.sqlite");
    reader = new Database(path);
    reader.pragma("journal_mode = WAL");
    reader.pragma("secure_delete = ON");
    reader.exec("create table leftovers (value text)");
    reader.prepare("insert into leftovers values (?)").run("left-behind-secret");
    reader.exec("delete from leftovers");
    expect(onDisk()).toContain("left-behind-secret");

    openDatabase(path).close();

    expect(onDisk()).not.toContain("left-behind-secret");
  });

  it("leaves no trace of a replaced tunnel runtime key", async () => {
    class FakeTunnelClient extends EventEmitter implements SpawnedProcess {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      kill(): boolean {
        return true;
      }
    }
    const launch: ProcessLauncher = () => {
      const child = new FakeTunnelClient();
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    const app = fileApplication({ launchTunnelProcess: launch });
    writeFileSync(join(directory!, "tunnel-client"), "fake client", { mode: 0o700 });
    const server = buildHttpServer(app);
    const session = await setupAdmin(server, app);
    const configure = (runtimeKey: string) => server.inject({
      method: "POST", url: "/tunnel/configure",
      headers: { ...LOCAL, cookie: session.cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: form([["csrf", session.csrf], ["tunnelId", `tunnel_${"4".repeat(32)}`], ["runtimeKey", runtimeKey]]),
    });

    expect((await configure("old-runtime-key-value")).statusCode).toBe(303);
    const credentialSetId = app.tunnels.get()!.runtimeCredentialSetId;
    const ciphertext = storedCiphertext(app, credentialSetId);
    expect(onDisk()).toContain(ciphertext);
    expect((await configure("new-runtime-key-value")).statusCode).toBe(303);

    expect(onDisk()).not.toContain(ciphertext);
    await server.close();
  });
});
