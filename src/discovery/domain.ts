import { getDomain } from "tldts";

// Hosts that give every customer a subdomain for its API documentation, such as acme.readme.io. The public suffix list
// does not name them, so the registrable domain of each customer's site is the host's own (readme.io), and one customer
// would pass for another. On these hosts the whole host name is the site.
export const SHARED_DOCUMENTATION_HOSTS: ReadonlySet<string> = new Set([
  "apiary.io",
  "apidog.io",
  "archbee.io",
  "bump.sh",
  "docsie.io",
  "document360.io",
  "gitbook.io",
  "helpscoutdocs.com",
  "mintlify.app",
  "mintlify.dev",
  "postman.co",
  "readme.io",
  "redoc.ly",
  "redocly.app",
  "stoplight.io",
  "theneo.io",
]);

// The site an address belongs to, which decides whether two addresses are one service's: the registrable domain, aware
// of the public suffix list and its private part, or the whole host name on a shared documentation host. Every rule
// that trusts an address for being on the documentation link's site goes through it: the provenance of a document, the
// preselected destinations, the domain of a catalog entry, and the reuse of an adapter.
export function registrableDomain(url: string): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLocaleLowerCase("en-US");
  } catch {
    return null;
  }
  const domain = getDomain(hostname, { allowPrivateDomains: true })?.toLocaleLowerCase("en-US");
  if (!domain) return null;
  return SHARED_DOCUMENTATION_HOSTS.has(domain) ? hostname.replace(/\.$/u, "") : domain;
}

export function sameRegistrableDomain(left: string, right: string): boolean {
  const leftDomain = registrableDomain(left);
  return leftDomain !== null && leftDomain === registrableDomain(right);
}

// "https://dev.wildberries.ru/docs" -> "Wildberries": a readable service name when the documents disagree on one.
export function serviceNameFromDomain(url: string): string | null {
  const name = registrableDomain(url)?.split(".")[0];
  return name ? name.charAt(0).toLocaleUpperCase("en-US") + name.slice(1) : null;
}
