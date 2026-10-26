import type Database from "better-sqlite3";

// The person's account-wide choice to let changes run without confirmation in every connection.
export const SKIP_CONFIRMATION_KEY = "changes.skip_confirmation";

// Settings of changing data that are not a connection's own. They live in app_settings, as the catalog's do. Only the
// person changes them, in a form of the local workspace; no tool of the assistant reaches this.
export class ChangeSettings {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // true only when the stored JSON is exactly true: no row, or anything else in it, keeps confirmation on, since a
  // damaged value must not let changes through unseen.
  skipsConfirmationEverywhere(): boolean {
    const row = this.db.prepare("select value_json from app_settings where key = ?").get(SKIP_CONFIRMATION_KEY) as
      | { value_json: string }
      | undefined;
    if (!row) return false;
    try {
      return JSON.parse(row.value_json) === true;
    } catch {
      return false;
    }
  }

  setSkipConfirmationEverywhere(skip: boolean): void {
    this.db.prepare(
      `insert into app_settings (key, value_json, updated_at) values (?, ?, ?)
       on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(SKIP_CONFIRMATION_KEY, JSON.stringify(skip), this.now().toISOString());
  }
}
