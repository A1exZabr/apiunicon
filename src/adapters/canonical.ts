// Object keys sorted at every level, so two snapshots of one value compare equal however their JSON was written. The
// trust rule of changes and the approval of reads sent with POST both compare operations in this form.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
