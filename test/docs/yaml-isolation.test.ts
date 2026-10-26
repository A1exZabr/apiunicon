import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseMachineDocument, parseYamlIsolated } from "../../src/docs/spec.js";
import { WB_STYLE_YAML } from "../fixtures/wb-style-spec.js";
import { watchWorkers, type WorkerWatch } from "../helpers/workers.js";

const MAX_YAML_BYTES = 2 * 1024 * 1024;

let workers: WorkerWatch;
beforeEach(() => {
  workers = watchWorkers();
});
afterEach(() => workers.stop());

// Tiny flow items cost the YAML parser hundreds of bytes of memory for each input byte.
function tinyItems(count: number): string {
  return `openapi: 3.0.0\ninfo: {title: Tiny}\npaths: {}\nx-items: [${"1,".repeat(count - 1)}1]\n`;
}

function mediumSpec(paths: number): string {
  return [
    "openapi: 3.0.0",
    "info:",
    "  title: Medium",
    "paths:",
    ...Array.from({ length: paths }, (_, index) => [
      `  /items/${index}:`,
      "    get:",
      `      operationId: getItem${index}`,
      "      responses:",
      "        '200':",
      "          description: ok",
    ]).flat(),
    "",
  ].join("\n");
}

// A valid spec of exactly `bytes` UTF-8 bytes, padded with a long description.
function paddedSpec(bytes: number, filler: string): string {
  const head = "openapi: 3.0.0\ninfo:\n  title: Padded\n  description: ";
  const tail = "\npaths: {}\n";
  const room = bytes - Buffer.byteLength(head + tail);
  const fillerBytes = Buffer.byteLength(filler);
  return `${head}${filler.repeat(Math.floor(room / fillerBytes))}${"x".repeat(room % fillerBytes)}${tail}`;
}

describe("parseYamlIsolated", () => {
  it("returns plain values and keeps aliased nodes shared instead of copying them", () => {
    const value = parseYamlIsolated("a: &a [1, 2]\nb: *a\n") as { a: unknown; b: unknown };
    expect(value).toEqual({ a: [1, 2], b: [1, 2] });
    expect(value.b).toBe(value.a);
  });

  it("returns null when the parser exceeds its memory limit, and the process carries on", async () => {
    const startedAt = performance.now();
    expect(parseYamlIsolated(tinyItems(40_000), { maxOldGenerationSizeMb: 16, timeoutMs: 1_000 })).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(workers.started).toHaveLength(1);
    // Without a listener of its own, the worker's error event would be thrown in the process.
    expect(workers.started[0]!.listenerCount("error")).toBeGreaterThan(0);
    const [error] = await once(workers.started[0]!, "error") as [unknown];
    expect(error).toMatchObject({ code: "ERR_WORKER_OUT_OF_MEMORY" });
  });

  it("stops the worker when the parse runs out of time", async () => {
    const input = mediumSpec(10_000);
    expect(Buffer.byteLength(input)).toBeLessThan(MAX_YAML_BYTES);
    expect(parseYamlIsolated(input, { timeoutMs: 1 })).toBeNull();
    expect(workers.started).toHaveLength(1);
    // Left running, the worker would take about a second to parse this document.
    await once(workers.started[0]!, "exit", { signal: AbortSignal.timeout(500) });
    // The same bytes under the same limits are not parsed again.
    expect(parseYamlIsolated(input, { timeoutMs: 1 })).toBeNull();
    expect(workers.started).toHaveLength(1);
  });

  it("does not start a worker for YAML over the byte cap", () => {
    expect(parseYamlIsolated(WB_STYLE_YAML, { maxBytes: 100 })).toBeNull();
    expect(workers.started).toHaveLength(0);
  });
});

describe("parseMachineDocument with untrusted YAML", () => {
  it("treats YAML over 2 MB as text without parsing it", () => {
    expect(parseMachineDocument(paddedSpec(MAX_YAML_BYTES, "x"))).toMatchObject({ format: "openapi3", title: "Padded" });
    expect(workers.started).toHaveLength(1);
    expect(parseMachineDocument(paddedSpec(MAX_YAML_BYTES + 1, "x"))).toBeNull();
    expect(workers.started).toHaveLength(1);
  });

  it("measures the YAML cap in UTF-8 bytes", () => {
    const input = paddedSpec(MAX_YAML_BYTES + 2, "я");
    expect(input.length).toBeLessThan(MAX_YAML_BYTES);
    expect(parseMachineDocument(input)).toBeNull();
    expect(workers.started).toHaveLength(0);
  });

  it("does not parse YAML again after the worker failed on the same bytes", () => {
    const aliases = Array.from({ length: 150 }, () => "*base").join(", ");
    const input = `openapi: 3.0.0\ninfo: {title: Repeated}\nbase: &base x\nitems: [${aliases}]\n`;
    expect(parseMachineDocument(input)).toBeNull();
    expect(workers.started).toHaveLength(1);
    expect(parseMachineDocument(input)).toBeNull();
    expect(workers.started).toHaveLength(1);
    // A document that parses is read again each time.
    parseMachineDocument(WB_STYLE_YAML);
    parseMachineDocument(WB_STYLE_YAML);
    expect(workers.started).toHaveLength(3);
  });

  it("still reads a normal YAML spec through the worker", () => {
    expect(parseMachineDocument(WB_STYLE_YAML)?.operations.map(({ method, path }) => `${method} ${path}`))
      .toEqual(["GET /api/v3/orders/new"]);
    expect(workers.started).toHaveLength(1);
  });
});
