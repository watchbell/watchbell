import { beforeEach, describe, expect, it, vi } from "vitest";
import { events, settings, storedLogs } from "@/db/schema";
import type { RuntimeLogLine } from "@/lib/providers/vercel-request-logs";
import { fakeDb, payloadOf } from "./fake-db";

const h = vi.hoisted(() => ({ current: null as null | { db: () => unknown }, read: vi.fn() }));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("@/lib/crypto", () => ({ openOrNull: () => "tok_abcdefghijklmnopqrstuvwxyz" }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ OPS_ENCRYPTION_KEY: "key" }) }));
vi.mock("@/lib/providers/vercel-request-logs", () => ({ readRequestLogs: h.read }));

import { DAILY_CAP, liveLogs, taskLogs } from "./logs-db";

const NOW = new Date("2026-10-13T12:00:00Z");
const acc = { id: "acc1", credentialCiphertext: "c", credentialIv: "i" };
const target = { appId: "a1", appName: "acme-shop", projectId: "p1", deploymentId: "d1", meta: { teamId: "team_a" } };
const line = (o: Partial<RuntimeLogLine>): RuntimeLogLine => ({
  rowId: "r1", at: new Date(NOW.getTime() - 60_000), level: "error", message: "boom", requestMethod: "GET", requestPath: "/courses?token=abc", statusCode: 500, source: "serverless", ...o,
});
const use = (results: unknown[][]) => {
  const f = fakeDb(results);
  h.current = f;
  return f;
};

beforeEach(() => {
  h.current = null;
  h.read.mockReset();
});

describe("taskLogs", () => {
  it("stores warning, error and fatal lines, scrubbed, once each", async () => {
    const f = use([[], [acc], [target], [], [], [], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [
      line({ rowId: "r1", message: "Authorization: Bearer abc.def-123 failed" }),
      line({ rowId: "r2", level: "info", message: "fine" }),
      line({ rowId: "r3", level: "warning", message: "mail someone@example.com bounced", requestPath: null }),
      line({ rowId: "r4", at: new Date(NOW.getTime() - 2 * 3_600_000), message: "from two hours ago", deploymentId: "dpl_old" }),
      line({ rowId: "r5", level: "fatal", message: "x".repeat(2500) }),
    ] });
    const errors: string[] = [];
    await taskLogs(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual([]);
    expect(h.read).toHaveBeenCalledWith("tok_abcdefghijklmnopqrstuvwxyz", "team_a", "p1", {
      since: new Date(NOW.getTime() - 24 * 3_600_000), until: NOW, now: NOW, levels: ["warning", "error", "fatal"], environment: "production", maxRows: 300,
    });
    const ins = f.writes.filter((w) => w.table === storedLogs);
    expect(ins).toHaveLength(1);
    const rows = payloadOf(ins[0].calls) as unknown as { rowId: string; message: string; requestPath: string | null; level: string; deploymentId: string }[];
    expect(rows.map((r) => [r.rowId, r.level, r.deploymentId])).toEqual([["r1", "error", "d1"], ["r3", "warning", "d1"], ["r4", "error", "dpl_old"], ["r5", "fatal", "d1"]]);
    expect(rows[0]).toMatchObject({ message: "Authorization: Bearer [hidden] failed", requestPath: "/courses" });
    expect(rows[1]).toMatchObject({ message: "mail [email] bounced", requestPath: null });
    expect(rows[3].message).toHaveLength(2000);
    expect(ins[0].calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
  });

  const min = 60_000;
  const sinceOf = () => (h.read.mock.calls[0][3] as { since: Date }).since;

  it("never stores a heartbeat ping token, in the path or in the message (B2)", async () => {
    const f = use([[], [acc], [target], [], [], [], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [
      line({ rowId: "p1", message: "GET /api/ping/hb_0123456789abcdef0123456789abcdef/fail → 503", requestPath: "/api/ping/hb_0123456789abcdef0123456789abcdef/fail?x=1", statusCode: 503 }),
    ] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    const ins = f.writes.filter((w) => w.table === storedLogs);
    const [row] = payloadOf(ins[0].calls) as unknown as { message: string; requestPath: string }[];
    expect(row).toMatchObject({ message: "GET /api/ping/hb_[hidden]/fail → 503", requestPath: "/api/ping/hb_[hidden]/fail" });
    expect(JSON.stringify(payloadOf(ins[0].calls))).not.toContain("0123456789abcdef");
  });

  it("reads from 5 minutes before the app's newest stored line, never further back than 24 hours", async () => {
    const newest = new Date(NOW.getTime() - 20 * min);
    use([[], [acc], [target], [], [{ id: "a1", at: newest }], [], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(h.read.mock.calls[0][3]).toMatchObject({ since: new Date(newest.getTime() - 5 * min), until: NOW });

    h.read.mockClear();
    use([[], [acc], [target], [], [{ id: "a1", at: new Date(NOW.getTime() - 5 * 86_400_000) }], [], []]);
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(sinceOf()).toEqual(new Date(NOW.getTime() - 24 * 3_600_000));
  });

  it("uses the app's read cursor when it is later than the newest stored line, so a quiet app reads only the gap", async () => {
    const cursorAt = new Date(NOW.getTime() - 5 * min);
    const f = use([[], [acc], [target], [], [], [{ key: "logs_read_cursor", value: { a1: cursorAt.toISOString(), gone: cursorAt.toISOString() } }], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(sinceOf()).toEqual(new Date(cursorAt.getTime() - 5 * min));
    const w = f.writes.filter((x) => x.table === settings);
    expect(w).toHaveLength(1);
    expect(payloadOf(w[0].calls)).toEqual({ key: "logs_read_cursor", value: { a1: NOW.toISOString() } });
    expect(w[0].calls.some((c) => c.method === "onConflictDoUpdate")).toBe(true);
  });

  it("takes the later of the cursor and the newest stored line, and ignores a junk cursor", async () => {
    const newest = new Date(NOW.getTime() - 3 * min);
    use([[], [acc], [target], [], [{ id: "a1", at: newest }], [{ key: "logs_read_cursor", value: { a1: new Date(NOW.getTime() - 40 * min).toISOString() } }], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(sinceOf()).toEqual(new Date(newest.getTime() - 5 * min));

    h.read.mockClear();
    use([[], [acc], [target], [], [], [{ key: "logs_read_cursor", value: { a1: "not a date", b: 5 } }], []]);
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(sinceOf()).toEqual(new Date(NOW.getTime() - 24 * 3_600_000));
  });

  it("moves the cursor only for apps whose read worked", async () => {
    const f = use([[], [acc], [target], [], [], [], []]);
    h.read.mockResolvedValue({ ok: false, kind: "transient", status: 400, error: "nope" });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(f.writes.filter((x) => x.table === settings)).toEqual([]);
  });

  it("says so when a read held more lines than the cap, but still stores what it got", async () => {
    const f = use([[], [acc], [target], [], [], [], []]);
    h.read.mockResolvedValue({ ok: true, more: true, lines: [line({ rowId: "r1" })] });
    const errors: string[] = [];
    await taskLogs(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual(["logs/acme-shop: more than 300 log lines since the last read; the oldest were skipped"]);
    expect(f.writes.filter((w) => w.table === storedLogs)).toHaveLength(1);
  });

  it("stores each line once across overlapping runs: lines the previous run stored are dropped", async () => {
    const run1 = [line({ rowId: "a:1" }), line({ rowId: "b:status", message: "GET /x → 504" })];
    const f1 = use([[], [acc], [target], [], [], [], []]);
    h.read.mockResolvedValueOnce({ ok: true, more: false, lines: run1 });
    await taskLogs(NOW, Date.now() + 20_000, []);
    const first = payloadOf(f1.writes.filter((w) => w.table === storedLogs)[0].calls) as unknown as { rowId: string }[];
    expect(first.map((r) => r.rowId)).toEqual(["a:1", "b:status"]);

    // The next run starts before the newest stored line, so it sees b:status again plus a new line.
    const f2 = use([[], [acc], [target], [], [{ id: "a1", at: run1[1].at }], [], first.filter((r) => r.rowId === "b:status")]);
    h.read.mockResolvedValueOnce({ ok: true, more: false, lines: [run1[1], line({ rowId: "c:1" })] });
    await taskLogs(new Date(NOW.getTime() + 300_000), Date.now() + 20_000, []);
    const second = payloadOf(f2.writes.filter((w) => w.table === storedLogs)[0].calls) as unknown as { rowId: string }[];
    expect(second.map((r) => r.rowId)).toEqual(["c:1"]);
  });

  it("does nothing when logs.disabled is set", async () => {
    const f = use([[{ key: "logs.disabled", value: true }]]);
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(h.read).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.queries).toHaveLength(1);
  });

  it("stops storing at the daily cap and records one LogCapReached event", async () => {
    const f = use([[], [acc], [target], [{ id: "a1", n: DAILY_CAP }], [], [], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [line({ rowId: "r1" })] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(f.writes.filter((w) => w.table === storedLogs)).toEqual([]);
    const evs = f.writes.filter((w) => w.table === events && w.kind === "insert");
    expect(evs).toHaveLength(1);
    expect(payloadOf(evs[0].calls)).toMatchObject({ resourceId: "a1", reason: "LogCapReached", kind: "warn", message: "Stored-log limit reached" });
  });

  it("reports a failed read and leaves the rest alone", async () => {
    const f = use([[], [acc], [target], [], [], []]);
    h.read.mockResolvedValue({ ok: false, kind: "auth", status: 403, error: "Vercel rejected this credential (403)." });
    const errors: string[] = [];
    await taskLogs(NOW, Date.now() + 20_000, errors);
    expect(errors).toEqual(["logs/acme-shop: Vercel rejected this credential (403)."]);
    expect(f.writes).toEqual([]);
  });

  it("skips an app when under 8.5 s of the run remain", async () => {
    use([[], [acc], [target], [], [], []]);
    const errors: string[] = [];
    await taskLogs(NOW, Date.now() + 1_000, errors);
    expect(h.read).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  // I6: a replayed hour must not double-count or trip the cap, and at the cap the newest lines win.
  it("skips lines that are already stored, so a replayed hour adds only what is new and never trips the cap", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => line({ rowId: `r${i}`, message: `m${i}` }));
    const stored = Array.from({ length: 15 }, (_, i) => ({ rowId: `r${i}` }));
    const f = use([[], [acc], [target], [{ id: "a1", n: DAILY_CAP - 10 }], [], [], stored]);
    h.read.mockResolvedValue({ ok: true, more: false, lines });
    await taskLogs(NOW, Date.now() + 20_000, []);
    const rows = payloadOf(f.writes.filter((w) => w.table === storedLogs)[0].calls) as unknown as { rowId: string }[];
    expect(rows.map((r) => r.rowId)).toEqual(["r15", "r16", "r17", "r18", "r19"]);
    expect(f.writes.filter((w) => w.table === events)).toEqual([]); // 990 + 5 new is still under the cap
  });

  it("stores nothing and raises no cap event when every line was stored before, even at the cap", async () => {
    const f = use([[], [acc], [target], [{ id: "a1", n: DAILY_CAP }], [], [], [{ rowId: "r1" }, { rowId: "r2" }]]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [line({ rowId: "r1" }), line({ rowId: "r2" })] });
    await taskLogs(NOW, Date.now() + 20_000, []);
    expect(f.writes.filter((w) => w.table !== settings)).toEqual([]); // only the read cursor moves
  });

  it("keeps the newest new lines when only some fit under the cap, and raises LogCapReached", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => line({ rowId: `n${i}` }));
    const f = use([[], [acc], [target], [{ id: "a1", n: DAILY_CAP - 2 }], [], [], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines });
    await taskLogs(NOW, Date.now() + 20_000, []);
    const rows = payloadOf(f.writes.filter((w) => w.table === storedLogs)[0].calls) as unknown as { rowId: string }[];
    expect(rows.map((r) => r.rowId)).toEqual(["n3", "n4"]);
    expect(f.writes.filter((w) => w.table === events && w.kind === "insert")).toHaveLength(1);
  });
});

describe("liveLogs", () => {
  it("merges the live read with the stored hour, scrubbed and deduped, oldest first", async () => {
    const stored = { l: { rowId: "r1", at: new Date(NOW.getTime() - 120_000), level: "error", message: "boom", requestMethod: "GET", requestPath: "/a", statusCode: 500 }, app: "acme-shop" };
    use([[acc], [target], [stored]]);
    h.read.mockResolvedValue({ ok: true, more: true, lines: [
      line({ rowId: "r1", at: new Date(NOW.getTime() - 120_000), message: "boom" }),
      line({ rowId: "r2", level: "info", at: new Date(NOW.getTime() - 30_000), message: "token=secret123 ok", requestPath: "/b?x=1" }),
    ] });
    const r = await liveLogs(NOW, null);
    expect(h.read).toHaveBeenCalledWith(expect.any(String), "team_a", "p1", {
      since: new Date(NOW.getTime() - 3_600_000), until: NOW, now: NOW, environment: "production", maxRows: 300, requests: true,
    });
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => [l.id, l.level, l.path, l.message])).toEqual([["r1", "error", "/courses", "boom"], ["r2", "info", "/b", "token=[hidden] ok"]]);
  });

  it("shows no heartbeat ping token in the live hour either (B2)", async () => {
    use([[acc], [target], []]);
    h.read.mockResolvedValue({ ok: true, more: false, lines: [
      line({ rowId: "p2", level: "info", message: "GET /api/ping/hb_0123456789abcdef0123456789abcdef → 200", requestPath: "/api/ping/hb_0123456789abcdef0123456789abcdef", statusCode: 200 }),
    ] });
    const r = await liveLogs(NOW, null);
    expect(r.lines.map((l) => [l.path, l.message])).toEqual([["/api/ping/hb_[hidden]", "GET /api/ping/hb_[hidden] → 200"]]);
  });

  it("names the app whose read failed", async () => {
    use([[acc], [target], []]);
    h.read.mockResolvedValue({ ok: false, kind: "transient", status: 502, error: "Vercel returned an error (502)." });
    const r = await liveLogs(NOW, null);
    expect(r.problems).toEqual(["acme-shop: Vercel returned an error (502)."]);
    expect(r.lines).toEqual([]);
  });

  it("has nothing to read without a Vercel account", async () => {
    use([[], []]);
    const r = await liveLogs(NOW, null);
    expect(h.read).not.toHaveBeenCalled();
    expect(r.lines).toEqual([]);
  });
});
