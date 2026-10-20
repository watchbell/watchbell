import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { registry as none } from "./extensions-none";

// R1: the private feature (src/private, the (console)/(private) pages, /api/v1, /api/office, /api/runner) plugs into the
// core through ONE point: @/lib/extensions → @ext/registry. Deleting those folders must leave a core that type-checks,
// tests and builds.
const APP = resolve(__dirname, "../..");
const SRC = join(APP, "src");
// /api/office (Kantor Virtual, owner 14 Oct) is the owner-session side of the private feature's office; /api/runner
// (ruling P3) is the VM runner's side of src/private/runner.
const PRIVATE_ROOTS = [
  join(SRC, "private"), join(SRC, "app", "(console)", "(private)"), join(SRC, "app", "api", "v1"), join(SRC, "app", "api", "office"), join(SRC, "app", "api", "runner"),
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return PRIVATE_ROOTS.includes(p) ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

// Every module specifier: import/export … from "x", import "x", import("x"), vi.mock("x"), require("x").
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\bmock\(\s*|\brequire\(\s*)["'`]([^"'`]+)["'`]/g;
const specs = (text: string) => [...text.matchAll(SPEC)].map((m) => m[1]);

describe("private feature boundary (R1)", () => {
  const core = files(SRC);
  const rel = (f: string) => relative(SRC, f).split(sep).join("/");

  it("walks the core (sanity)", () => {
    expect(core.some((f) => rel(f) === "lib/extensions.ts")).toBe(true);
    expect(core.some((f) => rel(f).startsWith("private/"))).toBe(false);
    expect(core.length).toBeGreaterThan(100);
  });

  it("imports @ext/registry only from lib/extensions.ts", () => {
    const hits = core.filter((f) => rel(f) !== "lib/extensions.ts" && rel(f) !== "lib/extensions.test.ts" && specs(readFileSync(f, "utf8")).some((s) => s === "@ext/registry"));
    expect(hits.map(rel)).toEqual([]);
  });

  it("never imports private code or /api/v1 from the core", () => {
    const bad = core.flatMap((f) => specs(readFileSync(f, "utf8"))
      .filter((s) => s.startsWith("@/private") || s.includes("/private/") || s.includes("api/v1/") || s.endsWith("api/v1"))
      .map((s) => `${rel(f)}: ${s}`));
    expect(bad).toEqual([]);
  });

  it("falls back to an empty registry", () => {
    expect(none).toEqual({ nav: [], palette: [] });
  });

  it("wires the @ext/registry alias with the none fallback in every config", () => {
    const ts = JSON.parse(readFileSync(join(APP, "tsconfig.json"), "utf8"));
    // Next (Turbopack) accepts only one target for a non-wildcard path, so tsconfig names src/private/registry.ts only. The
    // public export leaves this config as it is: registry.public.ts lands there as src/private/registry.ts, so the alias
    // resolves in the public edition too. extensions-none is the fallback the aliases in next.config.ts and
    // vitest.config.mts use when that file is absent.
    expect(ts.compilerOptions.paths["@ext/registry"]).toEqual(["./src/private/registry.ts"]);
    for (const name of ["next.config.ts", "vitest.config.mts"]) {
      const text = readFileSync(join(APP, name), "utf8");
      expect(text, name).toContain("@ext/registry");
      expect(text, name).toContain("./src/private/registry.ts");
      expect(text, name).toContain("./src/lib/extensions-none.ts");
    }
    expect(readFileSync(join(APP, "drizzle.config.ts"), "utf8")).toContain("./src/private/db/!(*.test).ts");
  });
});
