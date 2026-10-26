import type { FastifyInstance } from "fastify";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import type { Application } from "../../src/index.js";

// The Host a browser on this computer sends to the test configuration's port, 3210.
export const LOCAL = { host: "127.0.0.1:3210" };

// A place for the setup token inside the test's own temporary home, as the state folder would hold it.
export function setupTokenPath(): string {
  return join(mkdtempSync(join(process.env.HOME ?? "", "setup-")), "setup.token");
}

type ResponseWithHeaders = {
  headers: Record<string, string | string[] | number | undefined>;
};

export function form(entries: Array<[string, string]>): string {
  const values = new URLSearchParams();
  for (const [key, value] of entries) values.append(key, value);
  return values.toString();
}

export function cookieHeader(response: ResponseWithHeaders): string {
  const setCookie = response.headers["set-cookie"];
  const values = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [String(setCookie)];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

export function cookieValue(cookies: string, name: string): string {
  const entry = cookies
    .split(/;\s*/u)
    .find((candidate) => candidate.startsWith(`${name}=`));
  if (!entry) throw new Error(`Cookie ${name} was not set`);
  return decodeURIComponent(entry.slice(name.length + 1));
}

// Creates the administrator as the person does: through the setup page, with the token the server printed.
export async function setupAdmin(
  server: FastifyInstance,
  application: Application,
  password = "correct horse battery staple",
): Promise<{ cookies: string; csrf: string }> {
  if (application.setupToken === null) throw new Error("The test configuration names no setupTokenPath");
  const response = await server.inject({
    method: "POST",
    url: "/setup",
    headers: { ...LOCAL, "content-type": "application/x-www-form-urlencoded" },
    payload: form([
      ["t", application.setupToken.issue()],
      ["password", password],
      ["confirmPassword", password],
    ]),
  });
  if (response.statusCode !== 303) {
    throw new Error(`Setup failed with ${response.statusCode}: ${response.body}`);
  }
  const cookies = cookieHeader(response);
  return { cookies, csrf: cookieValue(cookies, "apiunicon_csrf") };
}
