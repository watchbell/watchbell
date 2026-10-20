import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildStructuredQuery, listRootCollections, runFirestoreQuery } from "./firestore-query";

// Stage 9 slice 2b: the Firestore query builder needs nothing new for read-only access (the viewer service account
// already can't write), and it must never expose a write itself. Every request it can make is one of the two read RPCs.
const READ_RPCS = [":listCollectionIds", ":runQuery"];
const WRITE_WORDS = [":commit", ":batchWrite", ":beginTransaction", ":rollback", ":write", "createDocument", ":patch", "\"PATCH\"", "\"DELETE\"", "\"PUT\"", "newTransaction", "readWrite"];

describe("Firestore query builder is read-only", () => {
  it("only ever calls listCollectionIds and runQuery", async () => {
    const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
    const f = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: JSON.parse(String(init.body ?? "{}")) });
      return new Response(JSON.stringify(url.endsWith(":runQuery") ? [{ readTime: "2026-10-16T00:00:00Z" }] : { collectionIds: [] }), { status: 200 });
    });
    const opts = { fetch: f as unknown as typeof fetch };
    await listRootCollections("tok", "proj-1", opts);
    const built = buildStructuredQuery({ collection: "orders", where: [], orderBy: null, limit: 10 });
    expect(built.ok).toBe(true);
    if (built.ok) await runFirestoreQuery("tok", "proj-1", built.body, opts);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.method).toBe("POST");
      expect(READ_RPCS.some((r) => c.url.endsWith(r)), c.url).toBe(true);
      expect(c.url).toMatch(/^https:\/\/firestore\.googleapis\.com\/v1\/projects\/proj-1\/databases\/\(default\)\/documents:/);
      // No transaction options: a runQuery body is the structured query alone.
      expect(Object.keys(c.body).every((k) => k === "structuredQuery" || k === "pageSize"), JSON.stringify(c.body)).toBe(true);
    }
  });

  it("has no write method anywhere in the builder or its server half", () => {
    for (const rel of ["./firestore-query.ts", "../data/firestore-query-db.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const w of WRITE_WORDS) expect(src.includes(w), `${rel} mentions ${w}`).toBe(false);
      const methods = [...src.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
      expect(methods.every((m) => m === "POST"), rel).toBe(true);
      const urls = [...src.matchAll(/\$\{base\([^)]*\)\}(:[A-Za-z]+)/g)].map((m) => m[1]);
      for (const u of urls) expect(READ_RPCS).toContain(u);
      if (rel === "./firestore-query.ts") expect(urls.sort()).toEqual([":listCollectionIds", ":runQuery"]);
    }
  });
});
