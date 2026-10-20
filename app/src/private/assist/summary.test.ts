import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, payloadOf } from "@/lib/data/fake-db";
import type { SnapshotRec } from "./prompts";

const h = vi.hoisted(() => ({
  current: null as null | { db: () => unknown }, provider: vi.fn(), advice: vi.fn(), complete: vi.fn(),
}));
vi.mock("@/db/client", () => ({ db: () => (h.current as { db: () => unknown }).db() }));
vi.mock("./ports", () => ({ ports: { provider: h.provider, advice: h.advice, complete: h.complete, appSnapshot: vi.fn() } }));

import { adviceHash, decide, SUMMARY_KEY } from "./summary-logic";
import { readSummary, refreshSummary } from "./summary";

const recs: SnapshotRec[] = [
  { title: "Next.js 15 reaches end of life", app: "webs-ticketer", severity: "warning" },
  { title: "Monitor on / answers 401", app: "orbit-blog", severity: "info" },
];
const NOW = new Date("2026-10-13T03:02:00.000Z");
const stored = (hash: string) => ({ text: "Two items need action.", model: "gemini/gemini-3.8-flash", at: "2026-10-12T03:02:00.000Z", count: 2, hash });

beforeEach(() => {
  vi.resetAllMocks();
  h.provider.mockResolvedValue({ name: "Gemini", model: "gemini/gemini-3.8-flash" });
  h.advice.mockResolvedValue(recs);
  h.complete.mockResolvedValue({ text: " Upgrade webs-ticketer first. ", model: "gemini/gemini-3.8-flash", ms: 900 });
});

describe("adviceHash / decide", () => {
  it("ignores order and changes with content", () => {
    expect(adviceHash(recs)).toBe(adviceHash([...recs].reverse()));
    expect(adviceHash(recs)).not.toBe(adviceHash([recs[0]]));
    expect(adviceHash(recs)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("skips an empty list and an unchanged one, unless forced", () => {
    expect(decide([], null, false)).toBe("skip-empty");
    expect(decide([], null, true)).toBe("skip-empty");
    expect(decide(recs, stored(adviceHash(recs)), false)).toBe("skip-unchanged");
    expect(decide(recs, stored(adviceHash(recs)), true)).toBe("run");
    expect(decide(recs, stored("0".repeat(64)), false)).toBe("run");
    expect(decide(recs, null, false)).toBe("run");
  });
});

describe("refreshSummary (the daily step and Regenerate)", () => {
  it("is skipped when no provider is connected: no read, no model call", async () => {
    h.provider.mockResolvedValue(null);
    const f = fakeDb([]);
    h.current = f;
    expect(await refreshSummary(NOW, { force: false })).toEqual({ status: "no-provider" });
    expect(h.advice).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it("is skipped when the recommendations hash didn't change", async () => {
    const f = fakeDb([[{ value: stored(adviceHash(recs)) }]]);
    h.current = f;
    expect(await refreshSummary(NOW, { force: false })).toEqual({ status: "unchanged" });
    expect(h.complete).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(0);
  });

  it("is skipped when there is nothing to summarise", async () => {
    h.advice.mockResolvedValue([]);
    h.current = fakeDb([[]]);
    expect(await refreshSummary(NOW, { force: true })).toEqual({ status: "empty" });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("summarises a changed list and stores { text, model, at, count, hash } under advisor.ai_summary", async () => {
    const f = fakeDb([[{ value: stored("0".repeat(64)) }]]);
    h.current = f;
    const r = await refreshSummary(NOW, { force: false });
    expect(r.status).toBe("stored");
    const [messages, opts] = h.complete.mock.calls[0];
    expect(opts).toMatchObject({ purpose: "summary" });
    expect(messages[1].content).toContain("webs-ticketer");
    expect(f.writes.map((w) => w.kind)).toEqual(["insert"]);
    expect(payloadOf(f.writes[0].calls)).toEqual({
      key: SUMMARY_KEY,
      value: { text: "Upgrade webs-ticketer first.", model: "gemini/gemini-3.8-flash", at: NOW.toISOString(), count: 2, hash: adviceHash(recs) },
    });
  });

  it("Regenerate (force) summarises even when unchanged", async () => {
    const f = fakeDb([[{ value: stored(adviceHash(recs)) }]]);
    h.current = f;
    expect((await refreshSummary(NOW, { force: true })).status).toBe("stored");
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it("stores nothing when the model returns no text", async () => {
    h.complete.mockResolvedValue({ text: "   ", model: "m", ms: 1 });
    const f = fakeDb([[]]);
    h.current = f;
    await expect(refreshSummary(NOW, { force: false })).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });
});

describe("readSummary", () => {
  it("returns a valid stored value and null for a missing or malformed one", async () => {
    h.current = fakeDb([[{ value: stored("a".repeat(64)) }], [], [{ value: { text: 5 } }]]);
    expect(await readSummary()).toMatchObject({ count: 2 });
    expect(await readSummary()).toBeNull();
    expect(await readSummary()).toBeNull();
  });
});
