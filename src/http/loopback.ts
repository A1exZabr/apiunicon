import type { FastifyRequest } from "fastify";

// The names a browser on this computer reaches the server by.
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

// The Host values the server answers: a loopback name with the server's own port. A page of another site whose DNS name
// now points to 127.0.0.1 still sends its own name (DNS rebinding), and another program on this computer has another
// port. A browser leaves out the default port 80.
export function loopbackHosts(port: number): ReadonlySet<string> {
  const hosts = LOOPBACK_NAMES.map((name) => `${name}:${port}`);
  return new Set(port === 80 ? [...hosts, ...LOOPBACK_NAMES] : hosts);
}

// Whether the connection itself comes from this computer, whatever address the server listens on.
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(v4);
}

// What the browser says about where a request comes from, by its Origin and Sec-Fetch-Site headers:
//   - "this_server": a page of this very server, at the Host the request was made to.
//   - "elsewhere": another site, or another program on this computer, which is another origin by its port. An Origin
//     of "null", as a sandboxed frame sends, is elsewhere too.
//   - "nothing": no page sent it. A request with neither header is not from a browser, and Sec-Fetch-Site "none" is
//     one the person started themselves.
// Every header that is sent has to agree: an Origin that is not this server's own is elsewhere, whatever
// Sec-Fetch-Site says, and the other way round.
export type RequestSource = "this_server" | "elsewhere" | "nothing";

export function requestSource(request: FastifyRequest): RequestSource {
  const { origin } = request.headers;
  const site = request.headers["sec-fetch-site"];
  if (origin !== undefined && origin !== `http://${request.headers.host ?? ""}`) return "elsewhere";
  if (site !== undefined && site !== "same-origin" && site !== "none") return "elsewhere";
  return site === "same-origin" || (site === undefined && origin !== undefined) ? "this_server" : "nothing";
}
