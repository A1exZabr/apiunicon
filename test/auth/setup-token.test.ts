import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SetupToken, withSetupToken } from "../../src/auth/setup-token.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tokenPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "apiunicon-setup-token-"));
  directories.push(directory);
  return join(directory, "setup.token");
}

describe("the setup token", () => {
  it("is made once, private to this user, and the same for every process that asks", () => {
    const path = tokenPath();
    const first = new SetupToken(path).issue();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(new SetupToken(path).issue()).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("works once", () => {
    const token = new SetupToken(tokenPath());
    const issued = token.issue();

    expect(token.matches(issued)).toBe(true);
    expect(token.take(issued)).toBe(true);
    expect(token.matches(issued)).toBe(false);
    expect(token.take(issued)).toBe(false);
    // A new one is another token.
    expect(token.issue()).not.toBe(issued);
  });

  it("matches nothing without a file, and nothing but the token itself", () => {
    const path = tokenPath();
    const token = new SetupToken(path);
    expect(token.matches("A".repeat(43))).toBe(false);

    const issued = token.issue();
    for (const given of ["", issued.slice(1), `${issued}=`, issued.toLowerCase() === issued ? issued.toUpperCase() : issued.toLowerCase(), 42, null]) {
      expect(token.matches(given), String(given)).toBe(false);
    }
  });

  it("replaces a file that holds no token", () => {
    const path = tokenPath();
    writeFileSync(path, "not a token", { mode: 0o600 });
    const token = new SetupToken(path);

    expect(token.matches("not a token")).toBe(false);
    const issued = token.issue();
    expect(readFileSync(path, "utf8")).toBe(issued);
  });

  it("is added to a link only while there is one", () => {
    const link = "http://127.0.0.1:3210/confirm/change/7d3c5a3e-6c1e-4a52-9f4e-2f0c1b7d9e10?t=abc";

    expect(withSetupToken(link, null)).toBe(link);
    expect(withSetupToken(link, "S".repeat(43))).toBe(`${link}&setup=${"S".repeat(43)}`);
    expect(withSetupToken("http://127.0.0.1:3210/connections/x", "S".repeat(43))).toBe(`http://127.0.0.1:3210/connections/x?setup=${"S".repeat(43)}`);
  });
});
