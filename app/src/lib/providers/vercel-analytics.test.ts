import { describe, expect, it, vi } from "vitest";
import { readPageViews } from "./vercel-analytics";

const NOW = new Date("2026-10-13T12:30:00Z");
const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz";
const range = { since: new Date("2026-10-12T13:00:00Z"), until: NOW };
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const count = (pageviews = 120, visitors = 40) => json({ data: { pageviews, visitors }, query: {}, version: 1 });
const aggregate = (data: unknown) => json({ data, query: {}, version: 1 });
const off = () => json({ error: { code: "bad_request", message: "Web Analytics is not enabled for this project" } }, { status: 400 });

type Answers = { count?: () => Response | Error; aggregate?: () => Response | Error };
// Answers by path, so the order of the two parallel calls doesn't matter.
function api(answers: Answers): typeof fetch & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const kind = new URL(url).pathname.endsWith("/count") ? "count" : "aggregate";
    const a = (answers[kind] ?? (() => (kind === "count" ? count() : aggregate([]))))();
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const urlOf = (f: ReturnType<typeof vi.fn>, kind: "count" | "aggregate") => new URL((f.mock.calls.map((c) => c[0] as string).find((u) => new URL(u).pathname.endsWith(`/${kind}`)))!);
const hang = () => vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as unknown as typeof fetch;
const read = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => readPageViews(TOKEN, "team_a", "prj_1", { ...range, fetch, ...extra });

describe("readPageViews request", () => {
  it("asks api.vercel.com for the count and the hourly aggregate with the bearer token, team, project and ISO bounds", async () => {
    const f = api({});
    const r = await read(f);
    expect(r).toEqual({ ok: true, enabled: true, total: 120, visitors: 40, hourly: [] });
    expect(f).toHaveBeenCalledTimes(2);
    const c = urlOf(f, "count");
    const a = urlOf(f, "aggregate");
    expect(`${c.origin}${c.pathname}`).toBe("https://api.vercel.com/v1/query/web-analytics/visits/count");
    expect(`${a.origin}${a.pathname}`).toBe("https://api.vercel.com/v1/query/web-analytics/visits/aggregate");
    expect(Object.fromEntries(c.searchParams)).toEqual({ projectId: "prj_1", teamId: "team_a", since: "2026-10-12T13:00:00.000Z", until: "2026-10-13T12:30:00.000Z" });
    expect(Object.fromEntries(a.searchParams)).toEqual({ projectId: "prj_1", teamId: "team_a", by: "hour", since: "2026-10-12T13:00:00.000Z", until: "2026-10-13T12:30:00.000Z" });
    expect(f.mock.calls[0][1]).toMatchObject({ headers: { Authorization: `Bearer ${TOKEN}` }, cache: "no-store" });
  });
});

describe("readPageViews answers", () => {
  it("parses the hourly series: sorted, hour-aligned, duplicates in one hour summed, rows without a usable timestamp skipped", async () => {
    const f = api({ aggregate: () => aggregate([
      { timestamp: "2026-10-13T11:00:00.000Z", pageviews: 7, visitors: 3 },
      { timestamp: "2026-10-13T09:00:00.000Z", pageviews: 2 },
      { timestamp: "2026-10-13T09:30:00.000Z", pageviews: 3 },
      { timestamp: "not a date", pageviews: 99 },
      { pageviews: 5 },
      { timestamp: "2026-10-13T10:00:00.000Z", pageviews: 0 },
      "junk",
    ]) });
    const r = await read(f);
    expect(r).toMatchObject({ ok: true, enabled: true, total: 120, visitors: 40 });
    expect((r as { hourly: unknown }).hourly).toEqual([
      { at: new Date("2026-10-13T09:00:00Z"), views: 5 },
      { at: new Date("2026-10-13T10:00:00Z"), views: 0 },
      { at: new Date("2026-10-13T11:00:00Z"), views: 7 },
    ]);
  });

  it("keeps at most the newest 24 hours", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 12, 0) + i * 3_600_000).toISOString(), pageviews: i }));
    const r = await read(api({ aggregate: () => aggregate(rows) }));
    const hourly = (r as { hourly: { views: number }[] }).hourly;
    expect(hourly).toHaveLength(24);
    expect(hourly[0].views).toBe(6);
    expect(hourly[23].views).toBe(29);
  });

  it("reports 0 views as an enabled project, not an empty state", async () => {
    expect(await read(api({ count: () => count(0, 0) }))).toEqual({ ok: true, enabled: true, total: 0, visitors: 0, hourly: [] });
  });

  it("treats the 400 'Web Analytics is not enabled' as enabled: false, from either call", async () => {
    for (const answers of [{ count: off, aggregate: off }, { count: off }, { aggregate: off }]) {
      expect(await read(api(answers))).toEqual({ ok: true, enabled: false });
    }
  });

  it("treats any other 400 as a transient failure, not as 'off'", async () => {
    const bad = () => json({ error: { message: "since must be before until" } }, { status: 400 });
    expect(await read(api({ count: bad, aggregate: bad }))).toMatchObject({ ok: false, kind: "transient", status: 400 });
  });
});

describe("readPageViews failures", () => {
  it.each([401, 403])("a %s is an auth failure, even when the other call answered", async (status) => {
    expect(await read(api({ count: () => json({}, { status }) }))).toMatchObject({ ok: false, kind: "auth", status });
  });

  it("auth wins over a transient failure of the other call", async () => {
    expect(await read(api({ count: () => json({}, { status: 500 }), aggregate: () => json({}, { status: 401 }) }))).toMatchObject({ ok: false, kind: "auth", status: 401 });
  });

  it("a 429 is transient and carries Retry-After (60 s when absent or bad)", async () => {
    expect(await read(api({ aggregate: () => json({}, { status: 429, headers: { "Retry-After": "17" } }) }))).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 17 });
    expect(await read(api({ aggregate: () => json({}, { status: 429, headers: { "Retry-After": "soon" } }) }))).toMatchObject({ ok: false, kind: "transient", status: 429, retryAfterS: 60 });
  });

  it("other non-2xx answers are transient", async () => {
    for (const status of [404, 500, 502, 503]) {
      expect(await read(api({ count: () => json({}, { status }) }))).toMatchObject({ ok: false, kind: "transient", status });
    }
  });

  it("a network error is transient", async () => {
    expect(await read(api({ count: () => new Error("ECONNRESET") }))).toMatchObject({ ok: false, kind: "transient" });
  });

  it("an hourly series that isn't JSON, or isn't the known shape, is a format failure", async () => {
    const cases: [string, Answers][] = [
      ["not json", { aggregate: () => new Response("<html>", { status: 200 }) }],
      ["series not an array", { aggregate: () => json({ data: "x" }) }],
      ["series without data", { aggregate: () => json([]) }],
      ["count field renamed", { aggregate: () => json({ data: [{ timestamp: "2026-10-13T09:00:00Z", views: 4 }] }) }],
      ["both unreadable", { count: () => json({ nope: 1 }), aggregate: () => json({ data: "x" }) }],
    ];
    for (const [name, answers] of cases) expect(await read(api(answers)), name).toMatchObject({ ok: false, kind: "format" });
  });

  // The count call's success shape was never seen live: when it doesn't parse but the hours do, the read still works.
  it("uses the sum of the hours as the total and leaves visitors unknown when the count answer isn't the expected shape", async () => {
    const hours = () => aggregate([{ timestamp: "2026-10-13T10:00:00.000Z", pageviews: 4 }, { timestamp: "2026-10-13T11:00:00.000Z", pageviews: 6 }]);
    const bad: [string, () => Response][] = [
      ["not json", () => new Response("<html>", { status: 200 })],
      ["no data", () => json({ nope: 1 })],
      ["string count", () => json({ data: { pageviews: "12", visitors: 3 } })],
      ["negative count", () => json({ data: { pageviews: -1, visitors: 3 } })],
      ["visitors missing", () => json({ data: { pageviews: 12 } })],
    ];
    for (const [name, count] of bad) {
      const r = await read(api({ count, aggregate: hours }));
      expect(r, name).toEqual({ ok: true, enabled: true, total: 10, visitors: null, hourly: [
        { at: new Date("2026-10-13T10:00:00Z"), views: 4 }, { at: new Date("2026-10-13T11:00:00Z"), views: 6 },
      ] });
    }
  });

  it("still fails when the count call fails for a real reason (transient, auth), even if the hours parsed", async () => {
    expect(await read(api({ count: () => json({}, { status: 500 }), aggregate: () => aggregate([]) }))).toMatchObject({ ok: false, kind: "transient", status: 500 });
    expect(await read(api({ count: () => json({}, { status: 403 }), aggregate: () => aggregate([]) }))).toMatchObject({ ok: false, kind: "auth" });
  });

  it("says off when either call says 'not enabled', even if the other one failed", async () => {
    for (const other of [() => json({}, { status: 500 }), () => json({}, { status: 401 }), () => json({}, { status: 429 }), () => new Error("ECONNRESET"), () => json({ nope: 1 })]) {
      expect(await read(api({ count: off, aggregate: other }))).toEqual({ ok: true, enabled: false });
      expect(await read(api({ count: other, aggregate: off }))).toEqual({ ok: true, enabled: false });
    }
  });

  it("never puts the token in a result: not in a failure, a thrown network error's text, or a success", async () => {
    const leaky = () => new Error(`connect failed for Bearer ${TOKEN}`);
    const answers: Answers[] = [
      { count: () => json({}, { status: 401 }) }, { count: () => json({}, { status: 403 }) }, { aggregate: () => json({}, { status: 429 }) },
      { count: () => json({}, { status: 500 }) }, { count: () => json({ error: { message: `bad token ${TOKEN}` } }, { status: 400 }) },
      { count: leaky }, { aggregate: leaky }, { aggregate: () => new Response(`<html>${TOKEN}</html>`, { status: 200 }) },
      { count: () => json({ nope: TOKEN }), aggregate: () => json({ data: TOKEN }) }, { count: off }, {},
    ];
    for (const a of answers) expect(JSON.stringify(await read(api(a)))).not.toContain(TOKEN);
    expect(JSON.stringify(await read(hang(), { timeoutMs: 20 }))).not.toContain(TOKEN);
  });

  it("gives up after the timeout with a transient failure", async () => {
    expect(await read(hang(), { timeoutMs: 20 })).toMatchObject({ ok: false, kind: "transient", error: expect.stringContaining("in time") });
  });

  it("says it was cancelled when the caller's signal aborts", async () => {
    const ctrl = new AbortController();
    const p = read(hang(), { signal: ctrl.signal });
    ctrl.abort();
    expect(await p).toMatchObject({ ok: false, kind: "transient", error: expect.stringContaining("cancelled") });
  });
});
