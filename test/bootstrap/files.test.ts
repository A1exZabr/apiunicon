import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SetupToken } from "../../src/auth/setup-token.js";
import { createFileOnce } from "../../src/bootstrap/files.js";
import { ensureManagedState } from "../../src/bootstrap/state.js";

// What runs the next time a file is linked into place, just before it is: another process at that very moment.
const meanwhile = vi.hoisted(() => ({ next: null as null | ((draft: string, target: string) => void) }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (existing: string, target: string) => {
      const run = meanwhile.next;
      meanwhile.next = null;
      run?.(String(existing), String(target));
      actual.linkSync(existing, target);
    },
  };
});

const directories: string[] = [];

afterEach(() => {
  meanwhile.next = null;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "apiunicon-files-"));
  directories.push(directory);
  return directory;
}

describe("files made once", () => {
  it("appear only whole, and a second writer gets false and leaves the first one's", () => {
    const path = join(folder(), "mcp.token");
    const seen: Array<{ target: boolean; draft: string }> = [];
    meanwhile.next = (draft, target) => seen.push({ target: existsSync(target), draft: readFileSync(draft, "utf8") });

    expect(createFileOnce(path, "first\n")).toBe(true);
    expect(createFileOnce(path, "second\n")).toBe(false);

    // When the file was put in place, the draft held all of it and the target did not exist yet.
    expect(seen).toEqual([{ target: false, draft: "first\n" }]);
    expect(readFileSync(path, "utf8")).toBe("first\n");
    expect(readdirSync(join(path, ".."))).toEqual(["mcp.token"]);
  });

  it("give two processes that start at once the same master key and MCP token, and neither reads an empty file", () => {
    const home = join(folder(), "state");
    let other: ReturnType<typeof ensureManagedState> | undefined;
    // The other process starts while this one is about to put its master key in place: it finds no key, not an empty
    // one, and makes its own, with this one's draft in the folder.
    meanwhile.next = (_draft, target) => {
      expect(basename(target)).toBe("master.key");
      expect(existsSync(target)).toBe(false);
      other = ensureManagedState({ APIUNICON_HOME: home });
    };

    const state = ensureManagedState({ APIUNICON_HOME: home });

    expect(other).toBeDefined();
    expect(state.masterKey).toEqual(other!.masterKey);
    expect(state.mcpToken).toBe(other!.mcpToken);
    expect(readdirSync(home).sort()).toEqual(["bin", "master.key", "mcp.token"]);
  });

  it("give two processes that ask at once the same setup token", () => {
    const path = join(folder(), "setup.token");
    let other: string | undefined;
    meanwhile.next = (_draft, target) => {
      expect(existsSync(target)).toBe(false);
      other = new SetupToken(path).issue();
    };

    const token = new SetupToken(path).issue();

    expect(token).toBe(other);
    expect(new SetupToken(path).matches(token)).toBe(true);
    expect(readdirSync(join(path, ".."))).toEqual(["setup.token"]);
  });
});
