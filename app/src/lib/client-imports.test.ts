import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Review I1 (U3): no client component may reach a Node built-in or a server-only module through its imports, or the
// build ships a polyfill (or fails) and server code ends up in a browser chunk. This walks the static import graph of
// every "use client" file in src (value imports only; `import type` is erased) and checks each module it reaches.
const SRC = resolve(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

// Value imports and re-exports: `import x from "…"`, `import "…"`, `export … from "…"`; not `import type` / `export type`.
const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function reach(entry: string): { file: string; spec: string }[] {
  const bad: { file: string; spec: string }[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    // A "use server" module reaches the browser only as action references, never its code or imports.
    if (f !== entry && /^\s*["']use server["']/.test(text)) continue;
    for (const [, spec] of text.matchAll(IMPORT)) {
      if (spec.startsWith("node:") || spec === "server-only" || spec === "crypto") bad.push({ file: f.slice(SRC.length + 1), spec });
      const local = resolveLocal(f, spec);
      if (local) queue.push(local);
    }
  }
  return bad;
}

describe("client components' import graph", () => {
  const clients = files(SRC).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

  it("finds the client components (sanity)", () => {
    expect(clients.some((f) => f.endsWith(join("uptime", "monitor-dialog.tsx")))).toBe(true);
    expect(clients.length).toBeGreaterThan(10);
  });

  it("reaches no Node built-in and no server-only module", () => {
    const bad = clients.flatMap((c) => reach(c).map((b) => `${c.slice(SRC.length + 1)} → ${b.file}: ${b.spec}`));
    expect(bad).toEqual([]);
  });

  it("keeps the heartbeat token code server-only", () => {
    expect(readFileSync(join(SRC, "lib", "heartbeat-token.ts"), "utf8")).toMatch(/^import "server-only";/);
    expect(readFileSync(join(SRC, "lib", "heartbeat.ts"), "utf8")).not.toMatch(/node:crypto/);
  });
});
