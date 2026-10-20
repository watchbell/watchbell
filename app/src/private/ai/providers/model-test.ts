import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { CONSOLE_CLIENT, recordCall } from "@/private/ai/usage";
import { aiProviders } from "@/private/db/schema";
import { type OpenConnection, testGenerate } from "./adapter";
import { dropConnectionCache, openConnections } from "./providers-db";
import { type ModelTest, publicId, type StoredModel } from "./routing";

// Models › Test and Scan all (owner 14 Oct): which detected model names really answer. One tiny chat completion per
// model (testGenerate, 512 tokens, up to 45 s: router combos fall back through thinking models), four at a time, inside
// one Server Action's budget (Vercel Hobby: 60 s). Each result is stored on the model as lastTest (ok, ms, status,
// a short error: never the provider's body or the key) and each call is recorded as usage kind 'models'.

export const SCAN_CONCURRENCY = 4;
export const TEST_TIMEOUT_MS = 45_000;
export const TEST_MAX_TOKENS = 512;
export const SCAN_BUDGET_MS = 50_000; // leave room for the write inside maxDuration 60
const MIN_SLOT_MS = 5_000; // don't start a test with less time than this left

// "model not found (404)", "refused (403)", … Short, from the status and the adapter's error class only.
export function shortTestError(status: number, errorClass: string): string {
  if (status === 404) return "model not found (404)";
  if (status === 401) return "key rejected (401)";
  if (status === 403) return "refused (403)";
  if (status === 429) return "rate limited (429)";
  if (status === 400) return "bad request (400)";
  if (status === 408 || /timeout/i.test(errorClass)) return "timed out";
  if (status === 0) return "unreachable";
  if (status >= 500) return `server error (${status})`;
  return `failed (${status})`;
}

// Runs fn over items with at most `limit` running at once, in order; an item not started before the deadline is skipped
// (undefined in the result). `fn` gets the time left for that item.
export async function runPool<T, R>(items: T[], limit: number, deadline: number, fn: (item: T, msLeft: number) => Promise<R>, now: () => number = Date.now): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const left = deadline - now();
      if (left < MIN_SLOT_MS) return;
      out[i] = await fn(items[i], left);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// Never-tested models first, then the oldest results, so repeated Scans cover everything.
export function scanOrder(models: StoredModel[]): StoredModel[] {
  const at = (m: StoredModel) => (m.lastTest ? Date.parse(m.lastTest.at) || 0 : -1);
  return [...models].sort((a, b) => at(a) - at(b));
}

// One tiny completion with one model (Test, Scan all and the model sync), recorded as usage kind 'models'.
export async function testOneModel(conn: OpenConnection, m: StoredModel, msLeft: number, userAgent = "Watchbell console (model test)"): Promise<ModelTest> {
  const t0 = Date.now();
  const r = await testGenerate(conn, m.upstream, Math.min(TEST_TIMEOUT_MS, msLeft), TEST_MAX_TOKENS);
  const test: ModelTest = r.ok
    ? { ok: true, ms: r.ms, at: new Date().toISOString() }
    : { ok: false, ms: Date.now() - t0, status: r.status, error: shortTestError(r.status, r.errorClass), at: new Date().toISOString() };
  await recordCall({
    at: new Date(t0), keyId: null, client: { ...CONSOLE_CLIENT, userAgent }, providerId: conn.id, model: publicId(conn, m),
    kind: "models", tool: null, tokensIn: null, tokensOut: null, latencyMs: test.ms, status: r.ok ? 200 : r.status || 502,
    errorClass: r.ok ? null : `test · ${r.errorClass}`.slice(0, 120), stream: false,
  }, []).catch(() => { console.warn("model test usage not recorded"); });
  return test;
}

export type TestOutcome = { ok: true; tested: { id: string; test: ModelTest }[]; skipped: number } | { ok: false; error: string };

// `modelIds` null = every model of the connection (Scan all).
export async function testModels(providerId: string, modelIds: string[] | null, started: number = Date.now()): Promise<TestOutcome> {
  const conn = (await openConnections(started, true)).find((c) => c.id === providerId);
  if (!conn) return { ok: false, error: "That connection no longer exists, or its key can't be read." };
  // Scan all leaves out models the router no longer lists (model sync: removed).
  const wanted = modelIds === null ? scanOrder(conn.models.filter((m) => !m.removed)) : conn.models.filter((m) => modelIds.includes(m.id));
  if (wanted.length === 0) return { ok: false, error: "That model isn't on this connection's list. Refresh the models first." };
  const deadline = started + SCAN_BUDGET_MS;
  const results = await runPool(wanted, SCAN_CONCURRENCY, deadline, async (m, left) => ({ id: m.id, test: await testOneModel(conn, m, left) }));
  const tested = results.filter((x): x is { id: string; test: ModelTest } => !!x);
  if (tested.length) {
    // Re-read so a switch flipped meanwhile isn't undone; only lastTest changes.
    const fresh = (await openConnections(Date.now(), true)).find((c) => c.id === providerId);
    if (fresh) {
      const byId = new Map(tested.map((t) => [t.id, t.test]));
      const models = fresh.models.map((m) => (byId.has(m.id) ? { ...m, lastTest: byId.get(m.id) } : m));
      await db().update(aiProviders).set({ models, updatedAt: new Date() }).where(eq(aiProviders.id, providerId));
      dropConnectionCache();
    }
  }
  return { ok: true, tested, skipped: wanted.length - tested.length };
}
