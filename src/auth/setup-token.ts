import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";

import { createFileOnce } from "../bootstrap/files.js";
import { isLinkToken, newLinkToken } from "../security/one-time-token.js";

// The token that lets the person create the local administrator. It lives in the state folder, readable by this user
// alone, only while there is no administrator, and is spent by the setup. Whoever creates the administrator first owns
// the workspace, so a page in the browser, even one that reached this port, must not be able to: the setup page asks
// for this token, which no page can read. It reaches the person in the link the server prints when it starts, and in the
// links the person's own assistant gets while there is no administrator yet, so that assistant holds it too.
export class SetupToken {
  constructor(private readonly path: string) {}

  // The token, made on first use. Two processes that ask at once get the same one: it appears whole or not at all
  // (createFileOnce).
  issue(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = this.read();
      if (current !== null) return current;
      const token = newLinkToken();
      if (createFileOnce(this.path, token)) return token;
      // Another process was first, or the file holds no token and is replaced.
      if (this.read() === null) this.discard();
    }
    throw new Error("The setup token could not be written");
  }

  // Whether the given value is the token, compared in constant time. Without a token nothing matches.
  matches(given: unknown): boolean {
    const current = this.read();
    if (current === null || typeof given !== "string" || !isLinkToken(given)) return false;
    return timingSafeEqual(digest(current), digest(given));
  }

  // Spends the token if it is the given one, at once, so two setups sent with it cannot both pass.
  take(given: unknown): boolean {
    if (!this.matches(given)) return false;
    this.discard();
    return true;
  }

  discard(): void {
    rmSync(this.path, { force: true });
  }

  private read(): string | null {
    try {
      const token = readFileSync(this.path, "utf8").trim();
      return isLinkToken(token) ? token : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// A link that leads through the sign-in, carrying the setup token while there is no administrator: the person who opens
// the first such link creates the administrator on the way and comes back to the link.
export function withSetupToken(url: string, token: string | null): string {
  if (token === null) return url;
  const link = new URL(url);
  link.searchParams.set("setup", token);
  return link.toString();
}
