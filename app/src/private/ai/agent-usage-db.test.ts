import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ executed: [] as unknown[], results: [] as unknown[], recordCall: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => ({ execute: async (q: unknown) => { h.executed.push(q); return h.results.shift() ?? []; } }) }));
vi.mock("./usage", () => ({ recordCall: h.recordCall }));

import { ACTIVITY_REPORTS_PER_HOUR, recordRuns, saveActivity, USAGE_REPORTS_PER_HOUR } from "./agent-usage-db";
import type { CallRecord } from "./usage";

const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);
const now = new Date("2026-10-13T10:20:00Z");
const rec = { at: now, keyId: "k1", client: null, providerId: null, model: "gemini-3.8-flash", kind: "agent", tool: "ask", tokensIn: 1, tokensOut: 1, latencyMs: 1, status: 200, errorClass: null, stream: false } as CallRecord;

beforeEach(() => { h.executed.length = 0; h.results.length = 0; h.recordCall.mockReset(); h.recordCall.mockResolvedValue(undefined); });

describe("recordRuns", () => {
  it("counts the key's hourly budget once, then writes one recordCall per run", async () => {
    h.results.push([{ count: 3 }]);
    expect(await recordRuns([rec, { ...rec, tool: "ping" }], "k1", now)).toEqual({ ok: true, recorded: 2 });
    expect(h.executed).toHaveLength(1);
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("insert into ops.rate_limits");
    expect(params).toEqual(["ai-usage:k1", "2026-10-13T10:00:00.000Z"]);
    expect(h.recordCall).toHaveBeenCalledTimes(2);
    expect(h.recordCall.mock.calls[1]).toEqual([{ ...rec, tool: "ping" }, []]);
  });
  it("past the budget writes nothing and says when to retry", async () => {
    h.results.push([{ count: USAGE_REPORTS_PER_HOUR + 1 }]);
    expect(await recordRuns([rec], "k1", now)).toEqual({ ok: false, reason: "rate_limited", retryAfter: 2400 });
    expect(h.recordCall).not.toHaveBeenCalled();
  });
});

describe("saveActivity", () => {
  const activity = { running: { model: "gemini-3.8-flash", purpose: "ask" as const, startedAt: now.toISOString() }, updatedAt: now.toISOString() };
  it("replaces antigravity.activity in ONE statement with the budget check", async () => {
    h.results.push([{ hits: 1, saved: 1 }]);
    expect(await saveActivity(activity, "k1", now)).toEqual({ ok: true });
    const { sql, params } = render(h.executed[0]);
    expect(sql).toContain("insert into ops.rate_limits");
    expect(sql).toContain("insert into ops.settings");
    expect(sql).toContain("on conflict (key) do update set value = excluded.value");
    expect(params).toEqual(expect.arrayContaining(["ai-activity:k1", "antigravity.activity", JSON.stringify(activity), ACTIVITY_REPORTS_PER_HOUR]));
  });
  it("reports the limit when nothing was saved", async () => {
    h.results.push([{ hits: ACTIVITY_REPORTS_PER_HOUR + 1, saved: 0 }]);
    expect(await saveActivity(activity, "k1", now)).toMatchObject({ ok: false, reason: "rate_limited" });
  });
});
