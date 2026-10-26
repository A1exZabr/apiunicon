import { userInfo } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

// Under tests nothing may live inside the real home directory: a test that resolved to it once overwrote a real master
// key. The real home comes from the user database, not from HOME, which tests replace.
export function refuseRealHomeUnderTests(path: string, what: string): void {
  if (process.env.VITEST === undefined) return;
  const fromHome = relative(userInfo().homedir, resolve(path));
  if (fromHome === "" || (!fromHome.startsWith("..") && !isAbsolute(fromHome))) {
    throw new Error(`Tests must not use ${what} in the real home directory: ${path}`);
  }
}
