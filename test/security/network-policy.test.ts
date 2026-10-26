import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NetworkPolicyError,
  RedirectBlockedError,
  assertPublicHttpsOriginLiteral,
  assertPublicHttpsUrl,
  guardedFetch,
  publicAddressFetch,
  publicAddressLookup,
  type HostResolver,
} from "../../src/security/network-policy.js";

const publicResolver: HostResolver = async () => ["8.8.8.8"];

describe("outbound network policy", () => {
  it.each([
    ["plain HTTP", "http://api.example.test/orders", ["203.0.113.10"]],
    ["embedded credentials", "https://user:pass@api.example.test/orders", ["203.0.113.10"]],
    ["loopback IPv4", "https://api.example.test/orders", ["127.0.0.1"]],
    ["private IPv4", "https://api.example.test/orders", ["10.20.30.40"]],
    ["metadata address", "https://api.example.test/orders", ["169.254.169.254"]],
    ["loopback IPv6", "https://api.example.test/orders", ["::1"]],
    ["unique-local IPv6", "https://api.example.test/orders", ["fd00::10"]],
  ])("rejects %s", async (_label, url, addresses) => {
    await expect(assertPublicHttpsUrl(url, async () => addresses)).rejects.toBeInstanceOf(
      NetworkPolicyError,
    );
  });

  it("refuses only 198.51.100.0/24 of 198.51.x.x, the documentation range TEST-NET-2", async () => {
    const resolvingTo = (address: string): HostResolver => async () => [address];
    for (const address of ["198.51.100.7", "198.51.100.255", "203.0.113.10", "192.0.2.1"]) {
      await expect(assertPublicHttpsUrl("https://api.example.test/", resolvingTo(address)), address)
        .rejects.toBeInstanceOf(NetworkPolicyError);
      expect(() => assertPublicHttpsOriginLiteral(`https://${address}`), address).toThrow(NetworkPolicyError);
    }
    for (const address of ["198.51.0.1", "198.51.99.20", "198.51.101.20", "198.51.255.1"]) {
      await expect(assertPublicHttpsUrl("https://api.example.test/", resolvingTo(address)), address).resolves.toBeInstanceOf(URL);
      expect(assertPublicHttpsOriginLiteral(`https://${address}`), address).toBe(`https://${address}`);
    }
  });

  it("resolves and accepts an HTTPS URL whose host has only public addresses", async () => {
    const url = await assertPublicHttpsUrl(
      "https://api.example.test/orders?limit=10",
      publicResolver,
    );

    expect(url.toString()).toBe("https://api.example.test/orders?limit=10");
  });

  it("rejects an origin that the connection did not approve", async () => {
    await expect(
      guardedFetch("https://evil.example.test/orders", {}, {
        allowedOrigins: ["https://api.example.test"],
        resolver: publicResolver,
        fetchImpl: async () => new Response("ok"),
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toThrow(/approved origin/i);
  });

  it("rejects redirects instead of following them", async () => {
    await expect(
      guardedFetch("https://api.example.test/orders", {}, {
        allowedOrigins: ["https://api.example.test"],
        resolver: publicResolver,
        fetchImpl: async (_input, init) => {
          expect(init?.redirect).toBe("manual");
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.test/steal" },
          });
        },
        timeoutMs: 1_000,
        maxResponseBytes: 1_024,
      }),
    ).rejects.toThrow(/redirect/i);
  });

  // The request was sent before the 3xx came back, so a caller must be able to tell it from a refusal before sending.
  it.each([301, 302, 303, 307, 308])("raises RedirectBlockedError for a %s answer, and not for a refusal before sending", async (status) => {
    const policy = {
      allowedOrigins: ["https://api.example.test"],
      resolver: publicResolver,
      fetchImpl: async () => new Response(null, { status, headers: { location: "https://api.example.test/next" } }),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };

    const error = await guardedFetch("https://api.example.test/orders", { method: "POST" }, policy).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedirectBlockedError);
    expect(error).toBeInstanceOf(NetworkPolicyError);
    expect(error).toMatchObject({ name: "RedirectBlockedError", message: "Outbound redirects are disabled", status });

    const refused = await guardedFetch("https://other.example.test/orders", {}, policy).catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(NetworkPolicyError);
    expect(refused).not.toBeInstanceOf(RedirectBlockedError);
  });

  // Wildberries answers 204 when a report has no rows for the period; that is an answer, not a failure of ours.
  it.each([204, 205])("passes on a %s answer, which has no body by definition", async (status) => {
    const response = await guardedFetch("https://api.example.test/reports", { method: "POST" }, {
      allowedOrigins: ["https://api.example.test"],
      resolver: publicResolver,
      fetchImpl: async () => new Response(null, { status }),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
  });

  it("resolves the hostname again for every request", async () => {
    let resolutionCount = 0;
    const resolver: HostResolver = async () => {
      resolutionCount += 1;
      return ["8.8.8.8"];
    };
    const policy = {
      allowedOrigins: ["https://api.example.test"],
      resolver,
      fetchImpl: async () => new Response("ok"),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };

    await guardedFetch("https://api.example.test/one", {}, policy);
    await guardedFetch("https://api.example.test/two", {}, policy);

    expect(resolutionCount).toBe(2);
  });
});

// Every block the check refuses, with an address inside it, against the IANA special-purpose registries. Addresses just
// outside a block are in PUBLIC_ADDRESSES.
const NON_PUBLIC_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ["0.0.0.0/8, this network", "0.0.0.0"],
  ["0.0.0.0/8, this network", "0.255.255.255"],
  ["10.0.0.0/8, private use", "10.0.0.1"],
  ["10.0.0.0/8, private use", "10.255.255.255"],
  ["100.64.0.0/10, shared address space", "100.64.0.1"],
  ["100.64.0.0/10, shared address space", "100.127.255.255"],
  ["127.0.0.0/8, loopback", "127.0.0.1"],
  ["127.0.0.0/8, loopback", "127.255.255.254"],
  ["169.254.0.0/16, link-local", "169.254.169.254"],
  ["172.16.0.0/12, private use", "172.16.0.1"],
  ["172.16.0.0/12, private use", "172.31.255.255"],
  ["192.0.0.0/24, IETF protocol assignments", "192.0.0.1"],
  ["192.0.0.0/24, IETF protocol assignments", "192.0.0.170"],
  ["192.0.2.0/24, documentation", "192.0.2.1"],
  ["192.88.99.0/24, 6to4 relay anycast", "192.88.99.1"],
  ["192.88.99.0/24, 6to4 relay anycast", "192.88.99.255"],
  ["192.168.0.0/16, private use", "192.168.1.1"],
  ["198.18.0.0/15, benchmarking", "198.18.0.1"],
  ["198.18.0.0/15, benchmarking", "198.19.255.255"],
  ["198.51.100.0/24, documentation", "198.51.100.7"],
  ["203.0.113.0/24, documentation", "203.0.113.10"],
  ["224.0.0.0/4, multicast", "224.0.0.1"],
  ["224.0.0.0/4, multicast", "239.255.255.255"],
  ["240.0.0.0/4, reserved", "240.0.0.1"],
  ["255.255.255.255, limited broadcast", "255.255.255.255"],
  ["::/128, unspecified", "::"],
  ["::1/128, loopback", "::1"],
  ["::1/128, loopback, written out", "0:0:0:0:0:0:0:1"],
  ["::/96, IPv4-compatible", "::127.0.0.1"],
  ["::/96, IPv4-compatible", "::7f00:1"],
  ["::/96, IPv4-compatible, of a public IPv4 address", "::8.8.8.8"],
  ["::ffff:0:0/96, IPv4-mapped", "::ffff:127.0.0.1"],
  ["::ffff:0:0/96, IPv4-mapped", "::ffff:7f00:1"],
  ["::ffff:0:0/96, IPv4-mapped, uppercase", "::FFFF:A00:1"],
  ["::ffff:0:0/96, IPv4-mapped, of a public IPv4 address", "::ffff:8.8.8.8"],
  ["64:ff9b::/96, NAT64", "64:ff9b::7f00:1"],
  ["64:ff9b::/96, NAT64, of a public IPv4 address", "64:ff9b::8.8.8.8"],
  ["64:ff9b:1::/48, local-use NAT64", "64:ff9b:1::a00:1"],
  ["100::/64, discard-only", "100::1"],
  ["1fff:ffff::1, just below 2000::/3", "1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001::/32, Teredo", "2001:0:4136:e378:8000:63bf:3fff:fdd2"],
  ["2001::/23, IETF protocol assignments: benchmarking", "2001:2::1"],
  ["2001::/23, IETF protocol assignments: ORCHIDv2", "2001:20::1"],
  ["2001::/23, IETF protocol assignments, last address", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001:db8::/32, documentation", "2001:db8::1"],
  ["2001:db8::/32, documentation, uppercase", "2001:DB8:FFFF::1"],
  ["2002::/16, 6to4", "2002:7f00:1::"],
  ["2002::/16, 6to4", "2002:ffff:ffff::1"],
  ["3fff::/20, documentation", "3fff::1"],
  ["3fff::/20, documentation", "3fff:fff:ffff::1"],
  ["4000::1, just above 2000::/3", "4000::1"],
  ["5f00::/16, SRv6 SIDs", "5f00::1"],
  ["fc00::/7, unique-local", "fc00::1"],
  ["fc00::/7, unique-local", "fd00::10"],
  ["fe80::/10, link-local", "fe80::1"],
  ["fec0::/10, site-local", "fec0::1"],
  ["ff00::/8, multicast", "ff02::1"],
];

const PUBLIC_ADDRESSES: ReadonlyArray<readonly [string, string]> = [
  ["Google DNS", "8.8.8.8"],
  ["Cloudflare DNS", "1.1.1.1"],
  ["just below 10.0.0.0/8", "9.255.255.255"],
  ["just above 10.0.0.0/8", "11.0.0.1"],
  ["just below 100.64.0.0/10", "100.63.255.255"],
  ["just above 100.64.0.0/10", "100.128.0.1"],
  ["just above 127.0.0.0/8", "128.0.0.1"],
  ["just above 169.254.0.0/16", "169.255.0.1"],
  ["just below 172.16.0.0/12", "172.15.255.255"],
  ["just above 172.16.0.0/12", "172.32.0.1"],
  ["just above 192.0.0.0/24", "192.0.1.1"],
  ["just above 192.0.2.0/24", "192.0.3.1"],
  ["just below 192.88.99.0/24", "192.88.98.255"],
  ["just above 192.88.99.0/24", "192.88.100.1"],
  ["just below 192.168.0.0/16", "192.167.255.255"],
  ["just above 192.168.0.0/16", "192.169.0.1"],
  ["just below 198.18.0.0/15", "198.17.255.255"],
  ["just above 198.18.0.0/15", "198.20.0.1"],
  ["just below 198.51.100.0/24", "198.51.99.1"],
  ["just above 198.51.100.0/24", "198.51.101.1"],
  ["just below 203.0.113.0/24", "203.0.112.255"],
  ["just above 203.0.113.0/24", "203.0.114.1"],
  ["just below 224.0.0.0/4", "223.255.255.255"],
  ["Cloudflare DNS", "2606:4700:4700::1111"],
  ["Google", "2a00:1450:4001::200e"],
  ["Google, uppercase", "2A00:1450:4001::200E"],
  ["Google, written out", "2a00:1450:4001:0:0:0:0:200e"],
  ["Google DNS", "2001:4860:4860::8888"],
  ["Cloudflare DNS, with a dotted tail", "2606:4700:4700::1.1.1.1"],
  ["the first address of 2000::/3", "2000::1"],
  ["just above 2001::/23", "2001:200::1"],
  ["just below 2001:db8::/32", "2001:db7:ffff::1"],
  ["just above 2001:db8::/32", "2001:db9::1"],
  ["just above 2002::/16", "2003::1"],
  ["just above 3fff::/20", "3fff:1000::1"],
];

const literalOrigin = (address: string): string => (address.includes(":") ? `https://[${address}]` : `https://${address}`);

describe("public address check", () => {
  it.each(NON_PUBLIC_ADDRESSES)("refuses %s: %s", async (_label, address) => {
    await expect(assertPublicHttpsUrl("https://api.example.test/", async () => [address]))
      .rejects.toBeInstanceOf(NetworkPolicyError);
    expect(() => assertPublicHttpsOriginLiteral(literalOrigin(address))).toThrow(NetworkPolicyError);
  });

  it.each(PUBLIC_ADDRESSES)("accepts %s: %s", async (_label, address) => {
    await expect(assertPublicHttpsUrl("https://api.example.test/", async () => [address])).resolves.toBeInstanceOf(URL);
    expect(assertPublicHttpsOriginLiteral(literalOrigin(address))).toBe(new URL(literalOrigin(address)).origin);
  });

  // A URL rewrites an IPv6 literal before the check sees it: [::127.0.0.1] becomes [::7f00:1].
  it.each([
    "https://[::ffff:127.0.0.1]",
    "https://[::127.0.0.1]",
    "https://[0:0:0:0:0:0:7f00:1]",
    "https://[64:ff9b::7f00:1]",
    "https://[64:ff9b::127.0.0.1]",
    "https://[2002:7f00:1::]",
    "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
    "https://[::FFFF:10.0.0.1]",
  ])("refuses the URL literal %s", (origin) => {
    expect(() => assertPublicHttpsOriginLiteral(origin)).toThrow(NetworkPolicyError);
  });

  // A zone names an interface of this machine; a URL refuses one itself, a resolver's answer is refused here.
  it.each(["fe80::1%en0", "2606:4700:4700::1111%en0", "2606:4700:4700::1111%1"])("refuses the zoned address %s", async (address) => {
    await expect(assertPublicHttpsUrl("https://api.example.test/", async () => [address]))
      .rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("refuses a host when any one of its addresses is not public", async () => {
    await expect(assertPublicHttpsUrl("https://api.example.test/", async () => ["8.8.8.8", "2606:4700:4700::1111", "fd00::1"]))
      .rejects.toBeInstanceOf(NetworkPolicyError);
  });
});

// The check that counts is the one made as a connection is opened. These tests open no connection: every address below
// is refused before a socket connects, and the one listener, on loopback, only proves nothing reached it.
describe("address check at connect time", () => {
  let listener: Server;
  let port = 0;
  let connections = 0;

  beforeAll(async () => {
    listener = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    port = (listener.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    expect(connections).toBe(0);
  });

  const neverAsked: HostResolver = async (hostname) => {
    throw new Error(`An IP literal was looked up: ${hostname}`);
  };

  const lookupWith = (resolver: HostResolver, all: boolean) =>
    new Promise<{ error: Error | null; address: string | LookupAddress[]; family?: number | undefined }>((resolve) => {
      publicAddressLookup(resolver)("api.example.test", { all }, (error, address, family) => resolve({ error, address, family }));
    });

  it("refuses at connect time a host that DNS rebinds to loopback after the early check passed", async () => {
    const asked: string[] = [];
    const rebinding: HostResolver = async (hostname) => {
      asked.push(hostname);
      return asked.length === 1 ? ["8.8.8.8"] : ["127.0.0.1"];
    };
    const origin = `https://rebind.example.test:${port}`;

    // No fetchImpl: the fetch that real requests use.
    const error = await guardedFetch(`${origin}/orders`, {}, {
      allowedOrigins: [origin],
      resolver: rebinding,
      timeoutMs: 5_000,
      maxResponseBytes: 1_024,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NetworkPolicyError);
    expect(error).not.toBeInstanceOf(RedirectBlockedError);
    // Once for the early check, once more by the connection itself, which got the loopback answer and stopped there.
    expect(asked).toEqual(["rebind.example.test", "rebind.example.test"]);
    expect(connections).toBe(0);
  });

  it("refuses a connection when any one of the addresses DNS gives is not public", async () => {
    const mixed: HostResolver = async () => ["8.8.8.8", "2606:4700:4700::1111", "127.0.0.1"];

    await expect(publicAddressFetch(mixed)(`https://mixed.example.test:${port}/`)).rejects.toBeInstanceOf(NetworkPolicyError);
    for (const all of [true, false]) {
      expect((await lookupWith(mixed, all)).error, `all: ${all}`).toBeInstanceOf(NetworkPolicyError);
    }
    expect(connections).toBe(0);
  });

  it("hands net exactly the addresses it checked, all of them when net races IPv4 against IPv6", async () => {
    const dualStack: HostResolver = async () => ["8.8.8.8", "2606:4700:4700::1111"];

    expect(await lookupWith(dualStack, true)).toEqual({
      error: null,
      address: [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }],
      family: undefined,
    });
    expect(await lookupWith(dualStack, false)).toEqual({ error: null, address: "8.8.8.8", family: 4 });
  });

  // net.connect never looks an IP address up, so the connection checks a literal host itself.
  it.each(["127.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "[fd00::1]"])("refuses to connect to the literal host %s", async (host) => {
    await expect(publicAddressFetch(neverAsked)(`https://${host}:${port}/`)).rejects.toBeInstanceOf(NetworkPolicyError);
    expect(connections).toBe(0);
  });

  it.each(["[::1]", "[fd00::1]", "127.0.0.1"])("refuses the literal host %s before anything is sent, without DNS", async (host) => {
    await expect(assertPublicHttpsUrl(`https://${host}/orders`, neverAsked)).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("accepts a public IPv6 literal without looking it up", async () => {
    const url = "https://[2606:4700:4700::1111]/orders";
    await expect(assertPublicHttpsUrl(url, neverAsked)).resolves.toBeInstanceOf(URL);

    const response = await guardedFetch(url, {}, {
      allowedOrigins: ["https://[2606:4700:4700::1111]"],
      resolver: neverAsked,
      fetchImpl: async () => new Response("ok"),
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    });
    expect(await response.text()).toBe("ok");
  });

  it("refuses a redirect to a host that resolves to a private address, and the hop on its own", async () => {
    const asked: string[] = [];
    const resolver: HostResolver = async (hostname) => {
      asked.push(hostname);
      return hostname === "internal.example.test" ? ["10.0.0.7"] : ["8.8.8.8"];
    };
    let sent = 0;
    const policy = {
      allowedOrigins: ["https://api.example.test", "https://internal.example.test"],
      resolver,
      fetchImpl: async () => {
        sent += 1;
        return new Response(null, { status: 302, headers: { location: "https://internal.example.test/admin" } });
      },
      timeoutMs: 1_000,
      maxResponseBytes: 1_024,
    };

    await expect(guardedFetch("https://api.example.test/orders", {}, policy)).rejects.toBeInstanceOf(RedirectBlockedError);
    expect(asked).toEqual(["api.example.test"]);
    // A caller that follows the redirect itself starts a new request, checked like any other: refused before it is sent.
    const hop = await guardedFetch("https://internal.example.test/admin", {}, policy).catch((caught: unknown) => caught);
    expect(hop).toBeInstanceOf(NetworkPolicyError);
    expect(hop).not.toBeInstanceOf(RedirectBlockedError);
    expect(sent).toBe(1);
  });
});
