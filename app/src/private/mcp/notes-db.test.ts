import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executed: [] as unknown[], answers: [] as unknown[], selectRows: [] as unknown[] as unknown[][], selectThrows: false }));
vi.mock("@/db/client", () => {
  const chain = () => {
    const b: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit"]) b[m] = () => b;
    b.then = (res: (v: unknown) => void, rej: (e: unknown) => void) => (h.selectThrows ? rej(new Error("boom")) : res(h.selectRows.shift() ?? []));
    return b;
  };
  return { db: () => ({ execute: async (q: unknown) => { h.executed.push(q); return h.answers.shift() ?? []; }, select: () => chain() }) };
});

import { allowedModels, answerQuestion, insertNote, NOTES_PER_HOUR, pendingQuestions, pruneAiNotes } from "./notes-db";
import { MCP_ALLOWED_MODELS } from "./scrub";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);
const now = new Date("2026-10-13T03:20:00Z");
const note = { title: "ticketer is down", body: "**/health** answers 503", severity: "crit" as const, appId: "a1", model: "gemini-3.8-flash", client: "antigravity/1.2" };

beforeEach(() => {
  h.executed.length = 0;
  h.answers.length = 0;
  h.selectRows.length = 0;
  h.selectThrows = false;
});

describe("insertNote (one statement)", () => {
  it("without a key (Watchpost's own advisor): key_id null, the budget counted per source", async () => {
    h.answers.push([{ hits: 1, id: "n9", pruned: 0 }]);
    expect(await insertNote(note, null, "watchpost", now)).toEqual({ ok: true, id: "n9" });
    const { params } = render(h.executed[0]);
    expect(params).toContain("ai-note:watchpost");
    expect(params).toContain(null);
  });
  it("counts the key's hour, inserts with the detected source, prunes beyond the newest 200", async () => {
    h.answers.push([{ hits: 1, id: "n1", pruned: 0 }]);
    expect(await insertNote(note, "k1", "antigravity", now)).toEqual({ ok: true, id: "n1" });
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("insert into ops.rate_limits");
    expect(sql).toContain("insert into ops.ai_notes");
    expect(sql).toMatch(/where hit\.count <= \$\d+/);
    expect(sql).toContain("delete from ops.ai_notes where exists (select 1 from ins)");
    expect(sql).toMatch(/order by created_at desc, id desc offset \$\d+/);
    expect(params).toContain("ai-note:k1");
    expect(params).toContain("2026-10-13T03:00:00.000Z"); // the hour window
    expect(params).toContain("antigravity");
    expect(params).toContain(NOTES_PER_HOUR);
    expect(params).toContain(199); // 199 old rows + the new one = 200 (R8)
  });

  it("the 21st note in an hour inserts nothing and says when to retry", async () => {
    h.answers.push([{ hits: 21, id: null, pruned: 0 }]);
    expect(await insertNote(note, "k1", "antigravity", now)).toEqual({ ok: false, reason: "rate_limited", retryAfter: 40 * 60 });
  });

  it("reads { rows } results too", async () => {
    h.answers.push({ rows: [{ hits: 2, id: "n2" }] });
    expect(await insertNote(note, "k1", "antigravity", now)).toEqual({ ok: true, id: "n2" });
  });
});

describe("pendingQuestions", () => {
  it("pending, last 7 days, oldest first, at most 20", async () => {
    h.answers.push([
      { id: "q1", context_kind: "app", context_id: "a1", question: "Why is it down?", created_at: "2026-10-13 02:00:00+00", requested_model: null, purpose: "ask" },
      { id: "q2", context_kind: "general", context_id: null, question: "ping", created_at: "2026-10-13 02:01:00+00", requested_model: "claude-sonnet-4-6", purpose: "ping" },
    ]);
    expect(await pendingQuestions(now)).toEqual([
      { id: "q1", contextKind: "app", contextId: "a1", question: "Why is it down?", createdAt: "2026-10-13T02:00:00.000Z", model: null, purpose: "ask" },
      { id: "q2", contextKind: "general", contextId: null, question: "ping", createdAt: "2026-10-13T02:01:00.000Z", model: "claude-sonnet-4-6", purpose: "ping" },
    ]);
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("requested_model, purpose");
    expect(sql).toContain("status = 'pending'");
    // Kantor Virtual's office questions (0023) are the local Claude Code hook's, never the MCP inbox's.
    expect(sql).toContain("purpose in ('ask', 'ping')");
    expect(sql).toContain("order by created_at asc");
    expect(params).toContain(20);
    expect(params).toContain("2026-10-06T03:20:00.000Z");
  });
});

describe("answerQuestion (compare-and-set)", () => {
  const ans = { text: "Roll back the last deploy.", client: "antigravity/1.2", model: "gemini-3.8-flash" };

  it("answers a pending question in one statement", async () => {
    h.answers.push([{ hits: 1, updated: 1, status: "pending", old: false }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toEqual({ ok: true });
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("update ops.ai_questions set status = 'answered'");
    expect(sql).toContain("status = 'pending' and purpose in ('ask', 'ping')");
    // An office question (purpose 'office') is not Antigravity's: it can't be answered here and reads as not found.
    expect(sql).toMatch(/where id = \$\d+::uuid and purpose in \('ask', 'ping'\)\) as status/);
    expect(params).toEqual(expect.arrayContaining(["ai-answer:k1", ans.text, ans.client, ans.model]));
  });

  it("already answered / expired / unknown / over the hourly budget", async () => {
    h.answers.push([{ hits: 1, updated: 0, status: "answered", old: false }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toEqual({ ok: false, reason: "answered" });
    h.answers.push([{ hits: 1, updated: 0, status: "expired", old: false }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toEqual({ ok: false, reason: "expired" });
    h.answers.push([{ hits: 1, updated: 0, status: "pending", old: true }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toEqual({ ok: false, reason: "expired" });
    h.answers.push([{ hits: 1, updated: 0, status: null, old: null }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toEqual({ ok: false, reason: "not_found" });
    h.answers.push([{ hits: 61, updated: 0, status: "pending", old: false }]);
    expect(await answerQuestion("q1", ans, "k1", now)).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});

describe("allowedModels", () => {
  it("uses the owner's ops.settings list when it is a string array", async () => {
    h.selectRows.push([{ value: ["Gemini", " claude ", 3, ""] }]);
    expect(await allowedModels()).toEqual(["gemini", "claude"]);
  });

  it("falls back to the default when missing, malformed or unreadable", async () => {
    h.selectRows.push([]);
    expect(await allowedModels()).toBe(MCP_ALLOWED_MODELS);
    h.selectRows.push([{ value: "gemini" }]);
    expect(await allowedModels()).toBe(MCP_ALLOWED_MODELS);
    h.selectThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await allowedModels()).toBe(MCP_ALLOWED_MODELS);
    warn.mockRestore();
  });
});

describe("pruneAiNotes (daily step)", () => {
  it("drops notes older than 30 days or beyond the newest 200, and questions older than 7, in one statement", async () => {
    await pruneAiNotes(now);
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("delete from ops.ai_notes where created_at <");
    expect(sql).toMatch(/or id in \(select id from ops\.ai_notes order by created_at desc, id desc offset \$2\)/);
    expect(sql).toContain("delete from ops.ai_questions where created_at <");
    expect(params).toEqual(["2026-09-13T03:20:00.000Z", 200, "2026-10-06T03:20:00.000Z"]);
  });
});
