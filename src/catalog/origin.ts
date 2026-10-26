import { HttpsOriginSchema } from "../adapters/schema.js";

export const CATALOG_ORIGINS = { ru: "https://apiunicon.ru", other: "https://apiunicon.online" } as const;

// The local version has no language setting of its own (its pages are in English), so the language of the account it
// runs under picks the default cloud: the POSIX locale variables in their order of precedence. The macOS service copies
// LANG from the shell that installed it.
export function localLanguage(env: NodeJS.ProcessEnv): string {
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) => value !== undefined && value !== "") ?? "";
  return locale.slice(0, 2).toLocaleLowerCase("en-US");
}

// Whether APIUNICON_CATALOG_ORIGIN names the cloud. Only then does the address stay put whatever sign-in is stored.
export function catalogOriginExplicit(env: NodeJS.ProcessEnv): boolean {
  return env.APIUNICON_CATALOG_ORIGIN !== undefined && env.APIUNICON_CATALOG_ORIGIN !== "";
}

// The cloud whose shared catalog the local version uses. APIUNICON_CATALOG_ORIGIN replaces it; only an HTTPS origin is
// accepted, because the catalog key travels to it. Without it this is only the default: a process that cannot see the
// locale (an MCP client starts it with its own environment) follows the cloud that issued the stored keys instead,
// see CatalogSession.
export function catalogOrigin(env: NodeJS.ProcessEnv): string {
  const configured = env.APIUNICON_CATALOG_ORIGIN;
  if (configured !== undefined && catalogOriginExplicit(env)) {
    const parsed = HttpsOriginSchema.safeParse(configured);
    if (!parsed.success) {
      throw new Error("APIUNICON_CATALOG_ORIGIN must be an HTTPS origin, for example https://apiunicon.online");
    }
    return parsed.data;
  }
  return localLanguage(env) === "ru" ? CATALOG_ORIGINS.ru : CATALOG_ORIGINS.other;
}
