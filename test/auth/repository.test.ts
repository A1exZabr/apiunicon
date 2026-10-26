import { afterEach, describe, expect, it } from "vitest";

import { AuthRepository, SignInLockedError } from "../../src/auth/repository.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRepository(now = new Date("2026-08-23T06:00:00.000Z")): AuthRepository {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  return new AuthRepository(database, { now: () => now, sessionTtlMs: 12 * 60 * 60 * 1000 });
}

describe("local administrator sessions", () => {
  it("sets up one administrator and refuses a second setup", async () => {
    const auth = createRepository();

    expect(auth.isSetup()).toBe(false);
    await auth.setup("correct horse battery staple");

    expect(auth.isSetup()).toBe(true);
    await expect(auth.setup("another correct battery staple")).rejects.toThrow(
      /already configured/,
    );
  });

  it("requires a password of at least twelve characters", async () => {
    const auth = createRepository();

    await expect(auth.setup("too-short")).rejects.toThrow(/12 characters/);
    expect(auth.isSetup()).toBe(false);
  });

  it("creates a hashed session and validates its separate CSRF token", async () => {
    const auth = createRepository();
    await auth.setup("correct horse battery staple");

    const login = await auth.login("correct horse battery staple");

    expect(login.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(login.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(login.token).not.toBe(login.csrfToken);
    expect(auth.authenticate(login.token)?.id).toBe(login.session.id);
    expect(auth.verifyCsrf(login.session.id, login.csrfToken)).toBe(true);
    expect(auth.verifyCsrf(login.session.id, "wrong-token")).toBe(false);
    const stored = databases[0]!
      .prepare("select token_hash, csrf_token_hash from web_sessions")
      .all();
    expect(JSON.stringify(stored)).not.toContain(login.token);
    expect(JSON.stringify(stored)).not.toContain(login.csrfToken);
  });

  it("rejects a wrong password without creating a session", async () => {
    const auth = createRepository();
    await auth.setup("correct horse battery staple");

    await expect(auth.login("incorrect password here")).rejects.toThrow(/Invalid credentials/);
    const count = databases[0]!
      .prepare("select count(*) as count from web_sessions")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("expires and revokes sessions, and a sign-in deletes the expired ones", async () => {
    let now = new Date("2026-08-23T06:00:00.000Z");
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database);
    const auth = new AuthRepository(database, {
      now: () => now,
      sessionTtlMs: 1000,
    });
    const sessionIds = () => (database.prepare("select id from web_sessions order by created_at").all() as Array<{ id: string }>)
      .map(({ id }) => id);
    await auth.setup("correct horse battery staple");
    const expired = await auth.login("correct horse battery staple");
    now = new Date("2026-08-23T06:00:00.500Z");
    const live = await auth.login("correct horse battery staple");
    expect(sessionIds()).toEqual([expired.session.id, live.session.id]);
    now = new Date("2026-08-23T06:00:01.200Z");

    expect(auth.authenticate(expired.token)).toBeNull();
    // A wrong password deletes nothing.
    await expect(auth.login("incorrect password here")).rejects.toThrow(/Invalid credentials/);
    expect(sessionIds()).toEqual([expired.session.id, live.session.id]);

    const active = await auth.login("correct horse battery staple");
    expect(sessionIds()).toEqual([live.session.id, active.session.id]);
    expect(auth.authenticate(live.token)?.id).toBe(live.session.id);
    expect(auth.authenticate(active.token)).not.toBeNull();
    auth.endAllSessions();
    expect(auth.authenticate(active.token)).toBeNull();
    expect(auth.authenticate(live.token)).toBeNull();
    expect(sessionIds()).toEqual([]);
  });

  it("counts a burst of guesses in order and never locks for longer than an hour", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateDatabase(database);
    let now = Date.parse("2026-08-23T06:00:00.000Z");
    const auth = new AuthRepository(database, { now: () => new Date(now) });
    await auth.setup("correct horse battery staple");

    // Sent all at once, as a script would: the five that are checked fail, and the rest find the lock.
    const burst = await Promise.allSettled(Array.from({ length: 8 }, () => auth.login("wrong password here")));
    const reasons = burst.map((result) => (result.status === "rejected" ? (result.reason as Error).name : "signed in"));
    expect(reasons).toEqual([...Array(5).fill("Error"), ...Array(3).fill("SignInLockedError")]);

    const locks: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      const refused = await auth.login("correct horse battery staple").catch((error: unknown) => error);
      if (!(refused instanceof SignInLockedError)) throw new Error("expected the lock");
      locks.push(refused.retryAfterMs);
      now += refused.retryAfterMs;
      await expect(auth.login("wrong password here")).rejects.toThrow(/Invalid credentials/u);
    }
    expect(locks).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60, 60].map((minutes) => minutes * 60_000));
  });
});
