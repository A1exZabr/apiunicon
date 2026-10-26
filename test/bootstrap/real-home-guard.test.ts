import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureManagedState } from "../../src/bootstrap/state.js";
import { openDatabase } from "../../src/db/database.js";

describe("tests never touch the real home", () => {
  it("runs every test file with a temporary HOME outside the real home", () => {
    expect(homedir()).toContain("apiunicon-test-home-");
    expect(relative(userInfo().homedir, homedir()).startsWith("..")).toBe(true);
  });

  it("refuses a state folder inside the real home and creates nothing there", () => {
    const folder = join(userInfo().homedir, ".apiunicon-guard-check-do-not-create");

    expect(() => ensureManagedState({ APIUNICON_HOME: folder })).toThrow(/real home/u);
    expect(existsSync(folder)).toBe(false);
  });

  it("refuses a database file inside the real home and creates nothing there", () => {
    const folder = join(userInfo().homedir, ".apiunicon-guard-check-do-not-create");
    const path = join(folder, "apiunicon.sqlite");

    expect(() => openDatabase(path)).toThrow(/real home/u);
    expect(existsSync(folder)).toBe(false);
  });

  const projectInRealHome = !relative(userInfo().homedir, process.cwd()).startsWith("..");
  it.runIf(projectInRealHome)("refuses a relative database path when the project is in the real home", () => {
    expect(() => openDatabase("./guard-check-do-not-create.sqlite")).toThrow(/real home/u);
    expect(existsSync(join(process.cwd(), "guard-check-do-not-create.sqlite"))).toBe(false);
  });

  it("still opens in-memory databases", () => {
    const db = openDatabase(":memory:");
    db.close();
  });
});
