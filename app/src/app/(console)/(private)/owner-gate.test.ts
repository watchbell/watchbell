import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R2: every page of the private feature is the owner's alone. The (private) layout's gate is NOT enough: a layout
// does not stop its page from running or from appearing in the RSC payload (Next 16 docs, guides/authentication
// "Layouts and auth checks"), and a client navigation fetches the page segment without the layout. So each page must
// call pageGate("owner") itself, before it reads anything.
const ROOT = join(__dirname);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return pages(p);
    return n === "page.tsx" ? [p] : [];
  });
}

describe("(private) pages gate themselves", () => {
  const files = pages(ROOT);
  it("finds the private pages", () => expect(files.length).toBeGreaterThanOrEqual(10));

  it.each(files.map((f) => [f.slice(ROOT.length + 1), f]))("%s calls pageGate(\"owner\") before any other await", (_n, file) => {
    const src = readFileSync(file, "utf8");
    const body = src.slice(src.indexOf("export default async function"));
    expect(body.length).toBeLessThan(src.length);
    const gate = body.indexOf("await pageGate(\"owner\")");
    expect(gate).toBeGreaterThan(-1);
    const firstAwait = body.search(/\bawait\b/);
    expect(firstAwait).toBe(gate);
    expect(body).toMatch(/if \(!gate\.ok\) return <NoAccess role=\{gate\.member\.role\} \/>;/);
  });
});
