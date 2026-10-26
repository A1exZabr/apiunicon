import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ManagedState } from "../../src/bootstrap/state.js";
import { loadConfig, localBaseUrl } from "../../src/config.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";
import { buildApplication } from "../../src/index.js";

describe("application configuration", () => {
  it("rejects a missing master key so the service cannot start without encryption", () => {
    expect(() => loadConfig({ APIUNICON_DB_PATH: ":memory:" })).toThrow(
      /APIUNICON_MASTER_KEY/,
    );
  });

  it("accepts exactly 32 decoded master-key bytes", () => {
    const config = loadConfig({
      APIUNICON_DB_PATH: ":memory:",
      APIUNICON_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    });

    expect(config.dbPath).toBe(":memory:");
    expect(config.masterKey).toEqual(Buffer.alloc(32, 7));
    expect(config.httpHost).toBe("127.0.0.1");
  });

  it("uses managed state when secret environment overrides are absent", () => {
    const state: ManagedState = {
      stateDir: "/tmp/apiunicon-managed",
      binDir: "/tmp/apiunicon-managed/bin",
      dbPath: "/tmp/apiunicon-managed/apiunicon.sqlite",
      masterKeyPath: "/tmp/apiunicon-managed/master.key",
      masterKey: Buffer.alloc(32, 9),
      mcpToken: "M".repeat(43),
      setupTokenPath: "/tmp/apiunicon-managed/setup.token",
    };

    const config = loadConfig({}, state);

    expect(config.stateDir).toBe(state.stateDir);
    expect(config.binDir).toBe(state.binDir);
    expect(config.dbPath).toBe(state.dbPath);
    expect(config.masterKey).toEqual(state.masterKey);
    expect(config.mcpToken).toBe(state.mcpToken);
    expect(config.setupTokenPath).toBe(state.setupTokenPath);
  });

  it("reads settings from APIUNICON_ variables and defaults the rest", () => {
    const key = Buffer.alloc(32, 7).toString("base64");

    expect(loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_HTTP_PORT: "4100" }).httpPort).toBe(4100);
  });

  it("keeps its files in the documented state folder without the managed state, never in the working directory", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const home = { APIUNICON_MASTER_KEY: key, HOME: "/Users/example" };
    expect(loadConfig(home)).toMatchObject({
      stateDir: "/Users/example/.apiunicon",
      binDir: "/Users/example/.apiunicon/bin",
      dbPath: "/Users/example/.apiunicon/apiunicon.sqlite",
    });
    expect(loadConfig({ ...home, APIUNICON_HOME: "/srv/apiunicon" })).toMatchObject({
      stateDir: "/srv/apiunicon", binDir: "/srv/apiunicon/bin", dbPath: "/srv/apiunicon/apiunicon.sqlite",
    });
    expect(loadConfig({ ...home, APIUNICON_DB_PATH: "/data/apiunicon.sqlite" }).dbPath).toBe("/data/apiunicon.sqlite");
  });

  it("builds its own addresses for the loopback host it listens on", () => {
    expect(localBaseUrl({ httpHost: "127.0.0.1", httpPort: 3210 })).toBe("http://127.0.0.1:3210");
    expect(localBaseUrl({ httpHost: "::1", httpPort: 3210 })).toBe("http://[::1]:3210");
    expect(localBaseUrl({ httpHost: "localhost", httpPort: 4100 })).toBe("http://localhost:4100");
    const key = Buffer.alloc(32, 7).toString("base64");
    const application = buildApplication({ ...loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_HTTP_HOST: "::1" }), dbPath: ":memory:" });
    expect(application.keyEntryBaseUrl).toBe("http://[::1]:3210");
    expect(new URL(application.keyEntryBaseUrl).host).toBe("[::1]:3210");
    application.db.close();
  });

  it("listens only on a loopback address", () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_HTTP_HOST: host }).httpHost).toBe(host);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "10.0.0.5", "example.com", "127.0.0.1.nip.io"]) {
      expect(() => loadConfig({ APIUNICON_MASTER_KEY: key, APIUNICON_HTTP_HOST: host }), host)
        .toThrow(/APIUNICON_HTTP_HOST must be a loopback address/u);
    }
  });
});

describe("database migrations", () => {
  it("creates all persistent domain tables", () => {
    const db = openDatabase(":memory:");
    migrateDatabase(db);

    const names = db
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;

    expect(names.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "documentation_sources",
        "documentation_chunks",
        "adapters",
        "connections",
        "connection_drafts",
        "credential_sets",
        "credential_fields",
        "knowledge_events",
        "execution_audits",
        "app_settings",
        "admin_credentials",
        "web_sessions",
        "jobs",
        "tunnel_config",
        "tunnel_events",
      ]),
    );

    db.close();
  });

  it("can run migrations twice without changing the schema", () => {
    const db = openDatabase(":memory:");

    expect(() => {
      migrateDatabase(db);
      migrateDatabase(db);
    }).not.toThrow();

    db.close();
  });

  it("takes the write lock before it reads the version, so two processes starting at once take turns", () => {
    const path = join(mkdtempSync(join(process.env.HOME ?? "", "database-")), "apiunicon.sqlite");
    const service = openDatabase(path);
    migrateDatabase(service);
    const other = openDatabase(path);
    other.pragma("busy_timeout = 0");

    // While another process writes, the migration waits for the lock rather than reading a version that may be stale.
    service.exec("begin immediate");
    expect(() => migrateDatabase(other)).toThrow(/locked|busy/iu);
    service.exec("rollback");
    expect(() => migrateDatabase(other)).not.toThrow();
    expect(other.pragma("user_version", { simple: true })).toBe(service.pragma("user_version", { simple: true }));

    other.close();
    service.close();
  });

  it("overwrites deleted content so erased keys do not linger in the file", () => {
    const db = openDatabase(":memory:");

    expect(db.pragma("secure_delete", { simple: true })).toBe(1);

    db.close();
  });
});
