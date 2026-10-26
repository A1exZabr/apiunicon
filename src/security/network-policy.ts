import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { Agent, buildConnector, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

export type HostResolver = (hostname: string) => Promise<string[]>;
export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type NetworkPolicy = {
  allowedOrigins: readonly string[];
  resolver?: HostResolver;
  // A fake in tests. Without one, publicAddressFetch, which checks every address it connects to.
  fetchImpl?: FetchImplementation;
  timeoutMs: number;
  maxResponseBytes: number;
};

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkPolicyError";
  }
}

// The body was read up to the limit before the download was cut off, so callers that count bytes can charge it.
export class ResponseByteLimitError extends NetworkPolicyError {
  constructor() {
    super("Upstream response exceeded the configured byte limit");
    this.name = "ResponseByteLimitError";
  }
}

// The request reached the service before its 3xx came back, unlike a refusal before sending: a write may have been made.
export class RedirectBlockedError extends NetworkPolicyError {
  constructor(readonly status: number) {
    super("Outbound redirects are disabled");
    this.name = "RedirectBlockedError";
  }
}

export const systemResolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(({ address }) => address);
};

// An IP address as one number of 32 (IPv4) or 128 (IPv6) bits. Null for anything else, and for an IPv6 address with a
// zone (fe80::1%en0): a zone names an interface of this machine, so such an address is never public.
type IpAddress = { readonly bits: 32 | 128; readonly value: bigint };
type AddressBlock = IpAddress & { readonly prefix: number };

function parseIp(address: string): IpAddress | null {
  const version = isIP(address);
  if (version === 4) {
    return { bits: 32, value: address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n) };
  }
  if (version !== 6 || address.includes("%")) return null;
  // A dotted IPv4 tail (::ffff:127.0.0.1) is the last two groups written another way; "::" stands for the missing zeros.
  const hex = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/u, (_tail, a: string, b: string, c: string, d: string) =>
    `${(Number(a) * 256 + Number(b)).toString(16)}:${(Number(c) * 256 + Number(d)).toString(16)}`);
  const [head, tail] = hex.split("::");
  const groupsOf = (part: string | undefined): string[] => (part ? part.split(":") : []);
  const left = groupsOf(head);
  const right = groupsOf(tail);
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return { bits: 128, value: groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n) };
}

function block(cidr: string): AddressBlock {
  const [address = "", prefix = ""] = cidr.split("/");
  const parsed = parseIp(address);
  if (!parsed) throw new Error(`Invalid address block: ${cidr}`);
  return { ...parsed, prefix: Number(prefix) };
}

function contains(range: AddressBlock, address: IpAddress): boolean {
  const shift = BigInt(range.bits - range.prefix);
  return range.bits === address.bits && range.value >> shift === address.value >> shift;
}

// The IANA IPv4 special-purpose registry, plus multicast. 192.0.0.0/24 is refused whole, the two anycast addresses in
// it that the registry marks reachable included; the reachable AS112 and AMT blocks stay public.
const NON_PUBLIC_IPV4 = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // private use
  "100.64.0.0/10", // shared address space (carrier-grade NAT)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, cloud metadata among them
  "172.16.0.0/12", // private use
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation (TEST-NET-1)
  "192.88.99.0/24", // 6to4 relay anycast
  "192.168.0.0/16", // private use
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation (TEST-NET-2)
  "203.0.113.0/24", // documentation (TEST-NET-3)
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, the limited broadcast 255.255.255.255 among them
].map(block);

// IPv6 is public only inside global unicast 2000::/3, minus the IANA special-purpose blocks there. That leaves out
// loopback and unspecified, IPv4-mapped and IPv4-compatible forms (whatever IPv4 address they carry), NAT64
// 64:ff9b::/96 and 64:ff9b:1::/48, discard-only 100::/64, SRv6 5f00::/16, unique-local, link-local, site-local and
// multicast.
const GLOBAL_UNICAST_IPV6 = block("2000::/3");
const NON_PUBLIC_IPV6 = [
  "2001::/23", // IETF protocol assignments: Teredo, benchmarking, ORCHID, anycast services
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4, which carries an IPv4 address
  "3fff::/20", // documentation
].map(block);

function isPublicAddress(address: string): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  if (ip.bits === 32) return !NON_PUBLIC_IPV4.some((range) => contains(range, ip));
  return contains(GLOBAL_UNICAST_IPV6, ip) && !NON_PUBLIC_IPV6.some((range) => contains(range, ip));
}

export function assertPublicHttpsOriginLiteral(input: string | URL): string {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new NetworkPolicyError("API origin must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NetworkPolicyError("API origin cannot contain embedded credentials");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new NetworkPolicyError("API origin cannot contain a path, query, or fragment");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLocaleLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new NetworkPolicyError("API origin must use a public host");
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    throw new NetworkPolicyError("API origin cannot use a private or reserved address");
  }
  return url.origin;
}

// The host as an IP address when it is one, without the brackets an IPv6 literal keeps in URL.hostname; null for a name.
function ipLiteral(host: string): string | null {
  const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return isIP(address) === 0 ? null : address;
}

// Every address a connection to the host may be opened to, each one checked: an IP literal itself, never looked up, or
// all of the resolver's answers. One answer that is not public refuses the host, since any of them may be used.
async function publicAddresses(host: string, resolver: HostResolver): Promise<string[]> {
  const literal = ipLiteral(host);
  if (literal !== null) {
    if (!isPublicAddress(literal)) throw new NetworkPolicyError("Outbound URL cannot use a private or reserved address");
    return [literal];
  }
  const addresses = await resolver(host);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new NetworkPolicyError("Outbound host resolved to a non-public address");
  }
  return addresses;
}

// Refuses the URL before anything is sent, so the caller knows nothing left. Its address check is an early answer, not
// the guarantee: DNS may answer differently a moment later (a zero TTL is enough to rebind a name), so
// publicAddressFetch checks again, at connect time, the addresses each connection is actually opened to.
export async function assertPublicHttpsUrl(
  input: string | URL,
  resolver: HostResolver = systemResolver,
): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new NetworkPolicyError("Outbound URL must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new NetworkPolicyError("Outbound URL cannot contain embedded credentials");
  }
  await publicAddresses(url.hostname, resolver);
  return url;
}

// The lookup net.connect uses for each connection publicAddressFetch opens to a hostname. net connects only to the
// addresses it returns, and calls it on both of its paths: for one address, or for all of them when it races IPv4
// against IPv6 (autoSelectFamily, options.all). So the address checked is the address connected to, on every new
// connection, keep-alive reconnects included.
export function publicAddressLookup(resolver: HostResolver): LookupFunction {
  return (hostname, options, callback) => {
    publicAddresses(hostname, resolver).then(
      (addresses) => {
        const records = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) callback(null, records);
        else callback(null, records[0]!.address, records[0]!.family);
      },
      (error: Error) => callback(error, ""),
    );
  };
}

// net.connect never looks up an IP address, so a literal host skips publicAddressLookup and is checked here instead.
// HTTP/2 stays off, as in Node's own fetch.
function publicAddressConnector(resolver: HostResolver): buildConnector.connector {
  const connect = buildConnector({ allowH2: false, lookup: publicAddressLookup(resolver) });
  return (options, callback) => {
    const literal = ipLiteral(options.hostname);
    if (literal !== null && !isPublicAddress(literal)) {
      // Asynchronously, as a socket reports that it could not connect.
      process.nextTick(callback, new NetworkPolicyError("Outbound URL cannot use a private or reserved address"), null);
      return;
    }
    connect(options, callback);
  };
}

// One agent per resolver, so everything built on the same resolver shares one connection pool, as it shared the global
// fetch's.
const publicFetches = new WeakMap<HostResolver, FetchImplementation>();

// The fetch for real requests: undici's own, through an agent that checks every connection as it is opened. A refused
// connection rejects with the NetworkPolicyError itself, not with the TypeError undici wraps it in.
export function publicAddressFetch(resolver: HostResolver = systemResolver): FetchImplementation {
  const known = publicFetches.get(resolver);
  if (known) return known;
  const dispatcher = new Agent({ connect: publicAddressConnector(resolver) });
  const publicFetch: FetchImplementation = async (input, init) => {
    // guardedFetch passes a URL; a Request of the global fetch API is not one undici's fetch can read.
    if (input instanceof Request) throw new TypeError("publicAddressFetch takes a URL, not a Request");
    try {
      // One Fetch API, declared twice: by the DOM library for the callers, by undici for its fetch.
      const response = await undiciFetch(input, { ...(init as UndiciRequestInit), dispatcher });
      return response as unknown as Response;
    } catch (error) {
      if (error instanceof TypeError && error.cause instanceof NetworkPolicyError) throw error.cause;
      throw error;
    }
  };
  publicFetches.set(resolver, publicFetch);
  return publicFetch;
}

async function readBoundedBody(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ResponseByteLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

export async function guardedFetch(
  input: string | URL,
  init: RequestInit,
  policy: NetworkPolicy,
): Promise<Response> {
  const resolver = policy.resolver ?? systemResolver;
  const url = await assertPublicHttpsUrl(input, resolver);
  const allowedOrigins = new Set(policy.allowedOrigins.map((origin) => new URL(origin).origin));
  if (!allowedOrigins.has(url.origin)) {
    throw new NetworkPolicyError(`Outbound URL is not on an approved origin: ${url.origin}`);
  }

  const timeoutSignal = AbortSignal.timeout(policy.timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const fetchImpl = policy.fetchImpl ?? publicAddressFetch(resolver);
  const response = await fetchImpl(url, { ...init, redirect: "manual", signal });
  if (response.status >= 300 && response.status < 400) {
    throw new RedirectBlockedError(response.status);
  }
  const body = await readBoundedBody(response, policy.maxResponseBytes);
  // 204 and 205 have no body by definition, and the Response constructor refuses one, even an empty one.
  const bodiless = response.status === 204 || response.status === 205;
  return new Response(bodiless ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
