import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No test may read or write the real home directory. The data folder, the master key, and the macOS service files all
// resolve from HOME, so every test file gets its own empty one and none of the service's own variables.
process.env.HOME = mkdtempSync(join(tmpdir(), "apiunicon-test-home-"));
for (const name of Object.keys(process.env)) {
  if (name.startsWith("APIUNICON_")) delete process.env[name];
}
