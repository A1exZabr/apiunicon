import { afterEach, describe, expect, it } from "vitest";

import { ChangeSettings, SKIP_CONFIRMATION_KEY } from "../../src/changes/settings.js";
import { migrateDatabase, openDatabase } from "../../src/db/database.js";

describe("change settings", () => {
  const databases: Array<ReturnType<typeof openDatabase>> = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("does not skip confirmation until told, remembers the setting and reads anything but true as not skipping", () => {
    const db = openDatabase(":memory:");
    databases.push(db);
    migrateDatabase(db);
    const settings = new ChangeSettings(db, () => new Date("2026-10-25T10:00:00.000Z"));

    expect(settings.skipsConfirmationEverywhere()).toBe(false);
    settings.setSkipConfirmationEverywhere(true);
    expect(new ChangeSettings(db).skipsConfirmationEverywhere()).toBe(true);
    expect(db.prepare("select value_json, updated_at from app_settings where key = ?").get(SKIP_CONFIRMATION_KEY))
      .toEqual({ value_json: "true", updated_at: "2026-10-25T10:00:00.000Z" });
    settings.setSkipConfirmationEverywhere(false);
    expect(settings.skipsConfirmationEverywhere()).toBe(false);
    expect((db.prepare("select count(*) as n from app_settings").get() as { n: number }).n).toBe(1);

    for (const stored of ['"yes"', "1", '"true"', "{}", "not json"]) {
      db.prepare("update app_settings set value_json = ? where key = ?").run(stored, SKIP_CONFIRMATION_KEY);
      expect(settings.skipsConfirmationEverywhere(), stored).toBe(false);
    }
  });
});
