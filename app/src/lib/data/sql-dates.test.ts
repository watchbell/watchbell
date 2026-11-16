import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 1.8.0 hotfix: a JS Date put straight into a raw sql`` template works on PGlite (tests, demo) but the postgres-js
// driver on the cloud console can't serialise it, so the query throws ("This page didn't load" on All workspaces once
// a second workspace existed). Raw templates take an ISO string cast to timestamptz instead, as create-db.ts does.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe("raw sql templates never take a Date object", () => {
  it("passes dates to sql`` as ISO strings", () => {
    const bad: string[] = [];
    for (const file of sources(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/sql(?:<[^`>]*>)?`[^`]*`/g)) {
        for (const [, expr] of m[0].matchAll(/\$\{([^}]*)\}/g)) {
          if (/^\s*new Date\(/.test(expr) && !expr.includes("toISOString")) bad.push(`${file}: \${${expr}}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
