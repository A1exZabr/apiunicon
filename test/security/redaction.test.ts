import { describe, expect, it } from "vitest";

import { redact } from "../../src/security/redaction.js";

describe("redact", () => {
  it("removes common and connection-specific secret fields recursively", () => {
    const value = {
      orderId: "order-7",
      api_key: "key-value",
      nested: {
        Authorization: "Bearer abc",
        customHeader: "header-secret",
        rows: [{ password: "password-value", amount: 42 }],
      },
    };

    expect(redact(value, ["customHeader"], [])).toEqual({
      orderId: "order-7",
      api_key: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        customHeader: "[REDACTED]",
        rows: [{ password: "[REDACTED]", amount: 42 }],
      },
    });
  });

  it("replaces known secret values embedded in otherwise ordinary strings", () => {
    const value = {
      message: "upstream rejected super-secret while processing order-7",
      safe: "order-7",
    };

    expect(redact(value, [], ["super-secret"])).toEqual({
      message: "upstream rejected [REDACTED] while processing order-7",
      safe: "order-7",
    });
  });

  it("stops at the depth boundary without invoking object prototypes", () => {
    const inherited = Object.create({ token: "prototype-secret" }) as Record<string, unknown>;
    inherited.safe = "visible";

    expect(redact(inherited, [], [])).toEqual({ safe: "visible" });
  });
});

describe("redact by key name", () => {
  it("keeps the cursors of the next page, which the assistant needs for the rest of a list", () => {
    const page = {
      items: [{ id: 1 }],
      nextPageToken: "page-2",
      next_token: "after-100",
      page_token: "page-3",
      continuationToken: "page-6",
      NextContinuationToken: "page-8",
      $skiptoken: "page-9",
      skipToken: "page-10",
      "prev-page-token": "page-1",
      syncToken: "sync-1",
      cursor: "after-7",
      meta: { pagination: { next_cursor: "page-4", pageToken: "page-5" } },
    };

    expect(redact(page, [], [])).toEqual(page);
  });

  it("still hides every key that carries a credential", () => {
    const value = {
      token: "t", access_token: "a", refresh_token: "r", id_token: "i", session_token: "s", csrfToken: "c", authToken: "x",
      api_key: "k", "x-api-key": "k", apiKey: "k", Authorization: "Bearer b", client_secret: "c", password: "p", cookie: "c",
      // A configured name is hidden whatever it is called, a cursor-like one included.
      nextPageToken: "n",
    };

    expect(redact(value, ["nextPageToken"], [])).toEqual(Object.fromEntries(Object.keys(value).map((key) => [key, "[REDACTED]"])));
  });

  it("marks what lies deeper than it looks as cut off, not as hidden", () => {
    let nested: Record<string, unknown> = { leaf: "visible" };
    for (let level = 0; level < 25; level += 1) nested = { child: nested };

    let current = redact(nested, [], []) as Record<string, unknown>;
    let depth = 0;
    while (typeof current.child === "object" && current.child !== null) {
      current = current.child as Record<string, unknown>;
      depth += 1;
    }
    expect(depth).toBe(20);
    expect(current.child).toBe("[TRUNCATED]");
    expect(JSON.stringify(redact(nested, [], []))).not.toContain("[REDACTED]");
  });
});
