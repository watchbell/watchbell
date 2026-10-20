import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Review Focus 1 (U6/U7): the public page and the badge must stay static (ISR), or every crawler hit becomes a render
// and a database read. Reading cookies(), headers() or searchParams anywhere in their tree turns them dynamic, and the
// session or console code has no business there anyway. The build's route list is the final word; this test catches it
// without a build by walking the local import graph of both entries.
const SRC = resolve(__dirname, "..", "..");
const PAGE = join(__dirname, "[slug]", "page.tsx");
const BADGE = join(__dirname, "[slug]", "badge", "[file]", "route.ts");

const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

function graph(entry: string): { files: string[]; specs: string[] } {
  const seen = new Set<string>();
  const specs = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const [, spec] of readFileSync(f, "utf8").matchAll(IMPORT)) {
      specs.add(spec);
      const next = resolveLocal(f, spec);
      if (next) queue.push(next);
    }
  }
  return { files: [...seen], specs: [...specs] };
}

const DYNAMIC = /\b(?:cookies|headers|draftMode|connection)\(\)|\bsearchParams\b|unstable_noStore|force-dynamic/;
const FORBIDDEN = ["next/headers", "@/lib/auth", "@/lib/supabase/server", "@/lib/supabase/proxy", "@/components/alias", "@/lib/data/monitors-db"];

describe.each([["page", PAGE], ["badge", BADGE]])("the public %s", (_n, entry) => {
  it("declares its cache window and renders every path at runtime", () => {
    const text = readFileSync(entry, "utf8");
    expect(text).toMatch(entry === PAGE ? /export const revalidate = 60;/ : /export const revalidate = 300;/);
    expect(text).toMatch(/export async function generateStaticParams\(\) \{\s*return \[\];/);
  });

  it("reads no cookies, headers or search params anywhere in its tree, and imports no session or console code", () => {
    const { files, specs } = graph(entry);
    // The walk really reaches the data layer (so a cookies() call down there would be caught).
    expect(files.map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"))).toEqual(expect.arrayContaining(["lib/data/public-status-db.ts", "lib/data/metrics-db.ts", "lib/data/maintenance-db.ts"]));
    for (const f of files) expect([f.slice(SRC.length + 1), DYNAMIC.test(readFileSync(f, "utf8").replace(/\/\/.*$/gm, ""))]).toEqual([f.slice(SRC.length + 1), false]);
    expect(specs.filter((s) => FORBIDDEN.includes(s))).toEqual([]);
  });
});
