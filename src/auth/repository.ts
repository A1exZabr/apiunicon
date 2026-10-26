import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { hashPassword, verifyPassword } from "./password.js";

const ADMIN_ID = "local-admin";

// Wrong passwords before the sign-in locks, the first lock, and the longest one. Each wrong password after the lock ran
// out doubles it.
const FREE_ATTEMPTS = 5;
const FIRST_LOCK_MS = 60_000;
const LONGEST_LOCK_MS = 60 * 60_000;

// The sign-in is locked after too many wrong passwords; retryAfterMs says for how long yet.
export class SignInLockedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Too many wrong passwords");
    this.name = "SignInLockedError";
  }
}

export type WebSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
};

export type AuthLogin = {
  token: string;
  csrfToken: string;
  session: WebSession;
};

type AuthOptions = {
  now?: () => Date;
  sessionTtlMs?: number;
};

type AdminRow = {
  password_hash: string;
  password_salt: string;
};

type SessionRow = {
  id: string;
  created_at: string;
  expires_at: string;
  csrf_token_hash: string;
};

function token(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeDigestEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function toSession(row: Pick<SessionRow, "id" | "created_at" | "expires_at">): WebSession {
  return { id: row.id, createdAt: row.created_at, expiresAt: row.expires_at };
}

export class AuthRepository {
  private readonly now: () => Date;
  private readonly sessionTtlMs: number;
  // The lock is kept in memory: a restart of the service is the person's own act.
  private failures = 0;
  private lockedUntil = 0;
  private signIns: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: Database.Database,
    options: AuthOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  }

  isSetup(): boolean {
    return Boolean(
      this.db.prepare("select 1 from admin_credentials where id = ?").get(ADMIN_ID),
    );
  }

  async setup(password: string): Promise<void> {
    if (password.length < 12) throw new Error("Password must contain at least 12 characters");
    if (this.isSetup()) throw new Error("Administrator is already configured");
    const stored = await hashPassword(password);
    const timestamp = this.now().toISOString();
    try {
      this.db
        .prepare(
          `insert into admin_credentials
            (id, password_hash, password_salt, created_at, updated_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(ADMIN_ID, stored.hash, stored.salt, timestamp, timestamp);
    } catch (error) {
      if (this.isSetup()) throw new Error("Administrator is already configured");
      throw error;
    }
  }

  // One sign-in at a time, so a burst of guesses is counted in order and the lock holds from the fifth wrong one on.
  login(password: string): Promise<AuthLogin> {
    const attempt = this.signIns.then(() => this.attempt(password));
    this.signIns = attempt.catch(() => undefined);
    return attempt;
  }

  private async attempt(password: string): Promise<AuthLogin> {
    const wait = this.lockedUntil - this.now().getTime();
    if (wait > 0) throw new SignInLockedError(wait);
    const admin = this.db
      .prepare(
        "select password_hash, password_salt from admin_credentials where id = ?",
      )
      .get(ADMIN_ID) as AdminRow | undefined;
    if (
      !admin ||
      !(await verifyPassword(password, {
        hash: admin.password_hash,
        salt: admin.password_salt,
      }))
    ) {
      this.failed();
      throw new Error("Invalid credentials");
    }
    this.failures = 0;
    this.lockedUntil = 0;

    // Each sign-in clears the sessions that have run out, so the table holds only those that can still sign in.
    this.deleteExpired();
    const sessionToken = token();
    const csrfToken = token();
    const createdAt = this.now();
    const session: WebSession = {
      id: randomUUID(),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.sessionTtlMs).toISOString(),
    };
    this.db
      .prepare(
        `insert into web_sessions
          (id, token_hash, csrf_token_hash, expires_at, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        digest(sessionToken),
        digest(csrfToken),
        session.expiresAt,
        session.createdAt,
      );
    return { token: sessionToken, csrfToken, session };
  }

  authenticate(sessionToken: string): WebSession | null {
    if (!sessionToken) return null;
    const row = this.db
      .prepare(
        `select id, created_at, expires_at, csrf_token_hash
         from web_sessions where token_hash = ? and expires_at > ?`,
      )
      .get(digest(sessionToken), this.now().toISOString()) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  verifyCsrf(sessionId: string, csrfToken: string): boolean {
    if (!csrfToken) return false;
    const row = this.db
      .prepare(
        `select csrf_token_hash from web_sessions
         where id = ? and expires_at > ?`,
      )
      .get(sessionId, this.now().toISOString()) as Pick<SessionRow, "csrf_token_hash"> | undefined;
    return Boolean(row && safeDigestEqual(row.csrf_token_hash, digest(csrfToken)));
  }

  // Locking the workspace signs out every browser, not only the one that asked.
  endAllSessions(): void {
    this.db.prepare("delete from web_sessions").run();
  }

  private failed(): void {
    this.failures += 1;
    if (this.failures < FREE_ATTEMPTS) return;
    const lock = Math.min(FIRST_LOCK_MS * 2 ** (this.failures - FREE_ATTEMPTS), LONGEST_LOCK_MS);
    this.lockedUntil = this.now().getTime() + lock;
  }

  private deleteExpired(): void {
    this.db.prepare("delete from web_sessions where expires_at <= ?").run(this.now().toISOString());
  }
}
