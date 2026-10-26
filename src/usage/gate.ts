// test and call run reads (test checks an adapter, call uses a working one); change runs a write the person confirmed.
export type CallMode = "test" | "call" | "change";

export type CallContext = { connectionId: string; operationId: string; mode: CallMode };

// What a host may limit and count. The core asks before acting and reports after; it never stores usage itself.
// To refuse, a method throws UsageLimitError with a message the AI passes on to the person.
export interface UsageGate {
  // May return a notice (for example, most of the month's calls are used) that is added to the call's result.
  beforeCall(context: CallContext): Promise<{ notice?: string }>;
  // dispatched is true when the request reached the external API, whatever it answered.
  // Hosts must not throw from it: it runs after the external call, and a throw would replace the result the AI already received.
  afterCall(context: CallContext & { dispatched: boolean }): Promise<void>;
  beforeDraft(): Promise<void>;
  // Asked before each documentation download: crawl pages, spec links the crawl follows, and URLs the AI attaches.
  // A refusal skips that download: an attached URL is rejected with reason daily_limit, and a crawl stops.
  // Text the AI sends itself is asked about once, when the first part of a new document arrives.
  beforeDocumentation(): Promise<void>;
  // Reports the body bytes actually read by each download, whatever happens to the document afterwards (stored,
  // duplicate, not a specification, over a storage limit); a download cut off at its byte limit reports the limit.
  // Answers whose body is not used (not 200 for an attached URL, not 2xx for a crawl page) are not reported.
  // Text the AI sends itself is reported once, with its byte size, when its last part arrives.
  // Hosts should not throw from it: the bytes were already read.
  afterDocumentation(bytes: number): Promise<void>;
}

export class UsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitError";
  }
}

// The host's refusal of a change because the person's plan does not include changing data. A kind of UsageLimitError,
// so code that knows only that one still reads it as a refusal; a change refused with it is refused for the plan, not
// for a limit, and the message is passed on to the person.
export class WritesNotAllowedError extends UsageLimitError {
  constructor(message: string) {
    super(message);
    this.name = "WritesNotAllowedError";
  }
}

export const unlimitedUsage: UsageGate = {
  beforeCall: async () => ({}),
  afterCall: async () => {},
  beforeDraft: async () => {},
  beforeDocumentation: async () => {},
  afterDocumentation: async () => {},
};
