import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { fakeDb, payloadOf, whereOf } from "@/lib/data/fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown } }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));

import { enqueue, enqueuePings, latestFor, listThread, MAX_PENDING, QUESTION_TTL_MS, questionForKey, questionForOwner, THREAD_LIMIT, threadView, viewOf } from "./questions-db";
import { EMPTY_BOOK } from "@/lib/view/display-name";

const NOW = new Date("2026-10-13T03:00:00.000Z");
const APP = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174000";
const base = { id: "q1", status: "pending" as const, answer: null, client: null, model: null, requestedModel: null, createdAt: new Date(NOW.getTime() - 60_000), answeredAt: null };

beforeEach(() => { h.current = null; });

describe("viewOf", () => {
  it("shows a pending question older than 7 days as expired", () => {
    expect(viewOf(base, NOW).status).toBe("pending");
    expect(viewOf({ ...base, createdAt: new Date(NOW.getTime() - QUESTION_TTL_MS - 1) }, NOW).status).toBe("expired");
    expect(viewOf({ ...base, status: "answered", createdAt: new Date(NOW.getTime() - QUESTION_TTL_MS - 1) }, NOW).status).toBe("answered");
  });
});

describe("latestFor", () => {
  it("returns the newest question of that app, one row read", async () => {
    const f = fakeDb([[{ ...base, status: "answered", answer: "Roll back.", client: "antigravity/1.4", model: "gemini-3.8-flash", answeredAt: NOW }]]);
    h.current = f;
    const q = await latestFor("app", APP, NOW);
    expect(q).toMatchObject({ status: "answered", answer: "Roll back.", client: "antigravity/1.4", model: "gemini-3.8-flash" });
    expect(f.queries[0].find((c) => c.method === "limit")?.args[0]).toBe(1);
  });
  it("is null when the app has no question", async () => {
    h.current = fakeDb([[]]);
    expect(await latestFor("app", APP, NOW)).toBeNull();
  });
});

describe("enqueue", () => {
  it("inserts a pending question with the creator and the context", async () => {
    const f = fakeDb([[]], [[{ id: "new-1" }]]);
    h.current = f;
    expect(await enqueue({ kind: "app", contextId: APP, question: "Why is x down?", by: "user-1", now: NOW })).toEqual({ ok: true, id: "new-1", reused: false });
    expect(f.writes.map((w) => w.kind)).toEqual(["insert"]);
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ contextKind: "app", contextId: APP, question: "Why is x down?", status: "pending", createdBy: "user-1" });
  });
  it("cuts the question to the table's 2000-character limit", async () => {
    const f = fakeDb([[]], [[{ id: "n" }]]);
    h.current = f;
    await enqueue({ kind: "app", contextId: APP, question: "x".repeat(3000), by: "u", now: NOW });
    expect((payloadOf(f.writes[0].calls)?.question as string).length).toBe(2000);
  });
  it("reuses the app's waiting question instead of adding another", async () => {
    const f = fakeDb([[{ id: "q-old", contextId: APP }, { id: "q-2", contextId: OTHER }]]);
    h.current = f;
    expect(await enqueue({ kind: "app", contextId: APP, question: "q", by: "u", now: NOW })).toEqual({ ok: true, id: "q-old", reused: true });
    expect(f.writes).toHaveLength(0);
  });
  it(`refuses when ${MAX_PENDING} are already waiting`, async () => {
    const waiting = Array.from({ length: MAX_PENDING }, (_, i) => ({ id: `q${i}`, contextId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    const f = fakeDb([waiting]);
    h.current = f;
    const r = await enqueue({ kind: "app", contextId: APP, question: "q", by: "u", now: NOW });
    expect(r.ok).toBe(false);
    expect(f.writes).toHaveLength(0);
  });
});

const sqlOf = (calls: Parameters<typeof whereOf>[0]) => new PgDialect().sqlToQuery(whereOf(calls)!.getSQL() as never);

describe("enqueue a general question (Ask page, API)", () => {
  it("inserts kind general with a null context", async () => {
    const f = fakeDb([[{ id: "q-app", contextId: APP, question: "x", by: "user-1" }]], [[{ id: "g1" }]]);
    h.current = f;
    expect(await enqueue({ kind: "general", contextId: null, question: "Anything expiring?", by: "user-1", now: NOW })).toEqual({ ok: true, id: "g1", reused: false });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ contextKind: "general", contextId: null, question: "Anything expiring?", createdBy: "user-1" });
  });
  it("does not treat two different general questions as the same one", async () => {
    const f = fakeDb([[{ id: "g-old", contextId: null, question: "Other question", by: "user-1" }]], [[{ id: "g2" }]]);
    h.current = f;
    expect(await enqueue({ kind: "general", contextId: null, question: "New question", by: "user-1", now: NOW })).toMatchObject({ reused: false });
    expect(f.writes).toHaveLength(1);
  });
  it("reuses the same waiting question from the same asker (a double click, a retried request)", async () => {
    const f = fakeDb([[{ id: "g-old", contextId: null, question: "Same?", by: "key-1" }]]);
    h.current = f;
    expect(await enqueue({ kind: "general", contextId: null, question: "Same?", by: "key-1", now: NOW })).toEqual({ ok: true, id: "g-old", reused: true });
    expect(f.writes).toHaveLength(0);
  });
  it("asks again when someone else asked the same text", async () => {
    const f = fakeDb([[{ id: "g-old", contextId: null, question: "Same?", by: "user-1" }]], [[{ id: "g3" }]]);
    h.current = f;
    expect(await enqueue({ kind: "general", contextId: null, question: "Same?", by: "key-1", now: NOW })).toMatchObject({ id: "g3", reused: false });
  });
});

describe("threadView (the Ask page's list)", () => {
  const row = (over: Record<string, unknown>) => ({ ...base, question: "q", kind: "general" as const, contextId: null, ...over });
  const book = { db: [{ id: "db-1", name: "prod-main", alias: "db-a" }], app: [] };

  it("labels general as null, an app by its name, an alert by its title with database names aliased", () => {
    const out = threadView([
      row({ id: "g" }),
      row({ id: "a", kind: "app", contextId: APP }),
      row({ id: "al", kind: "alert", contextId: OTHER }),
    ], [{ id: APP, name: "orbit-blog" }], [{ id: OTHER, title: "prod-main paused", message: "", causedBy: null, resourceId: null }], book, NOW);
    expect(out.map((i) => [i.id, i.kind, i.label])).toEqual([["g", "general", null], ["a", "app", "orbit-blog"], ["al", "alert", "db-a paused"]]);
    expect(out[0]).not.toHaveProperty("contextId");
  });
  it("never shows an id for an app or alert that is gone", () => {
    const out = threadView([row({ kind: "app", contextId: APP }), row({ kind: "alert", contextId: OTHER })], [], [], EMPTY_BOOK, NOW);
    expect(out.map((i) => i.label)).toEqual(["A removed app", "A cleared alert"]);
  });
  it("carries the answer, who answered, and shows an old pending question as expired", () => {
    const [a, b] = threadView([
      row({ status: "answered", answer: "**Roll back.**", client: "antigravity/1.4", model: "claude-sonnet-4-6", answeredAt: NOW }),
      row({ id: "old", createdAt: new Date(NOW.getTime() - QUESTION_TTL_MS - 1) }),
    ], [], [], EMPTY_BOOK, NOW);
    expect(a).toMatchObject({ status: "answered", answer: "**Roll back.**", client: "antigravity/1.4", model: "claude-sonnet-4-6", question: "q" });
    expect(b.status).toBe("expired");
  });
});

describe("listThread", () => {
  it("reads the newest 50 of the last 7 days, then only the apps and alerts they point at", async () => {
    const f = fakeDb([
      [{ ...base, question: "q1", kind: "app", contextId: APP }, { ...base, id: "q2", question: "q2", kind: "general", contextId: null }],
      [{ id: APP, name: "orbit-blog" }],
    ]);
    h.current = f;
    const out = await listThread(NOW, EMPTY_BOOK);
    expect(out.map((i) => i.label)).toEqual(["orbit-blog", null]);
    expect(f.queries[0].find((c) => c.method === "limit")?.args[0]).toBe(THREAD_LIMIT);
    expect(sqlOf(f.queries[0]).params).toContainEqual(new Date(NOW.getTime() - QUESTION_TTL_MS).toISOString());
    expect(f.queries).toHaveLength(2); // no alert read when no question is about an alert
  });
  it("reads nothing else when there are no questions", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    expect(await listThread(NOW, EMPTY_BOOK)).toEqual([]);
    expect(f.queries).toHaveLength(1);
  });
});

describe("questionForKey (GET /api/v1/ai/questions/{id})", () => {
  it("reads one general question asked by that key in the last 7 days", async () => {
    const f = fakeDb([[{ ...base, question: "Anything expiring?" }]]);
    h.current = f;
    expect(await questionForKey("q1", "key-1", NOW)).toMatchObject({ id: "q1", status: "pending", question: "Anything expiring?" });
    const q = sqlOf(f.queries[0]);
    expect(q.params).toEqual(expect.arrayContaining(["q1", "key-1", "general"]));
    expect(q.sql).toContain("created_by");
  });
  it("is null when the key didn't ask it", async () => {
    h.current = fakeDb([[]]);
    expect(await questionForKey("q1", "key-2", NOW)).toBeNull();
  });
});

describe("Antigravity models (owner 13 Oct)", () => {
  it("a general question carries the picked model and purpose ask", async () => {
    const f = fakeDb([[]], [[{ id: "g1" }]]);
    h.current = f;
    await enqueue({ kind: "general", contextId: null, question: "Hi?", by: "user-1", now: NOW, model: "gemini-3.8-flash-high" });
    expect(payloadOf(f.writes[0].calls)).toMatchObject({ requestedModel: "gemini-3.8-flash-high", purpose: "ask" });
    const q = sqlOf(f.queries[0]);
    expect(q.sql).toContain('"purpose" = $');
    expect(q.params).toContain("ask");
  });
  it("the same text for another model is a new question", async () => {
    const f = fakeDb([[{ id: "g-old", contextId: null, question: "Same?", by: "user-1", model: null }]], [[{ id: "g2" }]]);
    h.current = f;
    expect(await enqueue({ kind: "general", contextId: null, question: "Same?", by: "user-1", now: NOW, model: "claude-sonnet-4-6" })).toMatchObject({ id: "g2", reused: false });
    h.current = fakeDb([[{ id: "g-old", contextId: null, question: "Same?", by: "user-1", model: "claude-sonnet-4-6" }]]);
    expect(await enqueue({ kind: "general", contextId: null, question: "Same?", by: "user-1", now: NOW, model: "claude-sonnet-4-6" })).toMatchObject({ id: "g-old", reused: true });
  });
  it("enqueuePings inserts one ping per model, skipping models whose ping still waits", async () => {
    const f = fakeDb([[{ model: "gemini-3.8-flash-high" }]], [[]]);
    h.current = f;
    expect(await enqueuePings(["gemini-3.8-flash-high", "claude-sonnet-4-6"], "user-1", NOW)).toEqual({ queued: ["claude-sonnet-4-6"], waiting: ["gemini-3.8-flash-high"] });
    expect(f.writes).toHaveLength(1);
    expect(payloadOf(f.writes[0].calls)).toEqual([{ contextKind: "general", contextId: null, question: "ping", status: "pending", createdBy: "user-1", createdAt: NOW, requestedModel: "claude-sonnet-4-6", purpose: "ping" }]);
    const q = sqlOf(f.queries[0]);
    expect(q.params).toEqual(expect.arrayContaining(["pending", "ping", "gemini-3.8-flash-high", "claude-sonnet-4-6", new Date(NOW.getTime() - 10 * 60_000).toISOString()]));
  });
  it("enqueuePings writes nothing when every ping still waits, or for no models", async () => {
    const f = fakeDb([[{ model: "a" }]]);
    h.current = f;
    expect(await enqueuePings(["a"], "u", NOW)).toEqual({ queued: [], waiting: ["a"] });
    expect(f.writes).toHaveLength(0);
    expect(await enqueuePings([], "u", NOW)).toEqual({ queued: [], waiting: [] });
  });
  it("the Ask thread and a key's read-back leave pings out", async () => {
    const f = fakeDb([[]]);
    h.current = f;
    await listThread(NOW, EMPTY_BOOK);
    expect(sqlOf(f.queries[0]).params).toContain("ask");
    const g = fakeDb([[]]);
    h.current = g;
    await questionForKey("q1", "key-1", NOW);
    expect(sqlOf(g.queries[0]).params).toContain("ask");
  });
});

describe("questionForOwner (the Playground's status poll)", () => {
  it("reads one ask-purpose question by id, asked by that member", async () => {
    const f = fakeDb([[{ ...base, status: "answered", answer: "Two apps.", model: "gemini-3.8-flash", answeredAt: NOW }]]);
    h.current = f;
    expect(await questionForOwner("q1", "user-1", NOW)).toMatchObject({ id: "q1", status: "answered", answer: "Two apps.", model: "gemini-3.8-flash", answeredAt: NOW });
    const q = sqlOf(f.queries[0]);
    expect(q.params).toEqual(expect.arrayContaining(["q1", "user-1", "ask"]));
    expect(q.sql).toContain("created_by");
    expect(q.sql).toContain('"purpose" = $');
    expect(f.queries[0].find((c) => c.method === "limit")?.args[0]).toBe(1);
  });
  it("shows an old pending question as expired", async () => {
    h.current = fakeDb([[{ ...base, createdAt: new Date(NOW.getTime() - QUESTION_TTL_MS - 1) }]]);
    expect((await questionForOwner("q1", "user-1", NOW))?.status).toBe("expired");
  });
  it("is null for a ping, another member's question or an unknown id", async () => {
    h.current = fakeDb([[]]);
    expect(await questionForOwner("q1", "user-2", NOW)).toBeNull();
  });
});
