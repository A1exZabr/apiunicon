import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("package build", () => {
  const pkg = readJson("package.json") as {
    scripts: Record<string, string>;
    exports: Record<string, string | Record<string, string>>;
  };

  it("builds from a clean dist with the build config", () => {
    expect(pkg.scripts.build).toMatch(/^rm -rf dist && tsc -p tsconfig\.build\.json(?: |$)/u);
  });

  it("compiles only the source, never the tests", () => {
    expect(readJson("tsconfig.build.json").include).toEqual(["src/**/*.ts"]);
  });

  it("exports modules with their types listed before the code", () => {
    const modules = pkg.exports["./*.js"];
    expect(modules).toEqual({ types: "./dist/src/*.d.ts", default: "./dist/src/*.js" });
    // Resolvers take the first matching condition, so types must come before default.
    expect(Object.keys(modules as Record<string, string>)).toEqual(["types", "default"]);
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });
});
