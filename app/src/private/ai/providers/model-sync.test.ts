import { describe, expect, it } from "vitest";
import {
  applyTestResults, checkDue, CHECK_EVERY_MS, isNewModel, nextSyncAt, pendingIds, PENDING_RETRY_MS, planModelSync, readSyncState, SYNC_EVERY_MS,
  syncDue, syncMessage, syncStatusText,
} from "./model-sync";
import type { StoredModel } from "./routing";

const NOW = new Date("2026-10-16T06:00:00.000Z");
const AT = NOW.toISOString();
const L = (id: string, o: object = {}) => ({ id, upstream: id, ...o });
const M = (id: string, o: Partial<StoredModel> = {}): StoredModel => ({ id, upstream: id, enabled: true, ...o });
const ok = (at: string) => ({ ok: true, ms: 900, at });
const bad = (at: string, error = "server error (503)") => ({ ok: false, ms: 300, status: 503, error, at });

describe("planModelSync", () => {
  it("adds a new id off and pending, keeps known ids with their switch and lastTest", () => {
    const prev = [M("a", { enabled: false, lastTest: ok("2026-10-15T00:00:00.000Z") }), M("b")];
    const p = planModelSync(prev, [L("a", { ctx: 1000 }), L("b"), L("c")], NOW);
    expect(p.models).toEqual([
      { id: "a", upstream: "a", ctx: 1000, enabled: false, lastTest: ok("2026-10-15T00:00:00.000Z") },
      M("b"),
      { id: "c", upstream: "c", enabled: false, pending: true, addedAt: AT },
    ]);
    expect(p).toMatchObject({ added: ["c"], removed: [], returned: [], toTest: ["c"], toRetest: [] });
  });

  it("marks a vanished id removed and off (kept for history), once", () => {
    const prev = [M("a"), M("gone", { lastTest: ok("2026-10-15T00:00:00.000Z") })];
    const p = planModelSync(prev, [L("a")], NOW);
    expect(p.models[1]).toEqual({ id: "gone", upstream: "gone", enabled: false, removed: true, removedAt: AT, lastTest: ok("2026-10-15T00:00:00.000Z") });
    expect(p.removed).toEqual(["gone"]);
    const again = planModelSync(p.models, [L("a")], new Date(NOW.getTime() + 60_000));
    expect(again.removed).toEqual([]);
    expect(again.models[1]).toEqual(p.models[1]);
  });

  it("un-removes an id that comes back and queues it for a test (off until it passes)", () => {
    const prev = [M("back", { enabled: false, removed: true, removedAt: "2026-10-10T00:00:00.000Z", lastTest: ok("2026-10-09T00:00:00.000Z") })];
    const p = planModelSync(prev, [L("back")], NOW);
    expect(p.models).toEqual([{ id: "back", upstream: "back", enabled: false, pending: true, lastTest: ok("2026-10-09T00:00:00.000Z") }]);
    expect(p).toMatchObject({ returned: ["back"], toTest: ["back"] });
  });

  it("never queues or switches a model the owner turned off by hand, nor a manual id", () => {
    const prev = [
      M("off", { enabled: false, manualOff: true, lastTest: bad("2026-10-01T00:00:00.000Z") }),
      M("offback", { enabled: false, manualOff: true, removed: true }),
      M("combo", { manual: true, lastTest: bad("2026-10-01T00:00:00.000Z") }),
    ];
    const p = planModelSync(prev, [L("off"), L("offback")], NOW);
    expect(p.models.find((m) => m.id === "off")).toEqual(prev[0]);
    expect(p.models.find((m) => m.id === "offback")).toEqual({ id: "offback", upstream: "offback", enabled: false, manualOff: true });
    expect(p.models.at(-1)).toEqual(prev[2]);
    expect(p.toTest).toEqual([]);
    expect(p.toRetest).toEqual([]);
  });

  it("re-tests at most 3 failed models, oldest test first; caps new tests", () => {
    const prev = [
      M("f1", { enabled: false, lastTest: bad("2026-10-15T04:00:00.000Z") }), M("f2", { lastTest: bad("2026-10-15T01:00:00.000Z") }),
      M("f3", { enabled: false, lastTest: bad("2026-10-15T03:00:00.000Z") }), M("f4", { enabled: false, lastTest: bad("2026-10-15T02:00:00.000Z") }),
      M("fine", { lastTest: ok("2026-10-01T00:00:00.000Z") }),
    ];
    const listed = [...prev.map((m) => L(m.id)), ...Array.from({ length: 10 }, (_, i) => L(`n${i}`))];
    const p = planModelSync(prev, listed, NOW);
    expect(p.toRetest).toEqual(["f2", "f4", "f3"]);
    expect(p.toTest).toHaveLength(8);
    expect(pendingIds(p.models)).toHaveLength(10);
    expect(planModelSync(prev, listed, NOW, { maxNew: 2, maxRetest: 1 })).toMatchObject({ toTest: ["n0", "n1"], toRetest: ["f2"] });
  });
});

describe("applyTestResults", () => {
  it("turns a passing new model on and reports it ready; a failing one stays off with the short error", () => {
    const models = [M("new", { enabled: false, pending: true, addedAt: AT }), M("bad", { enabled: false, pending: true })];
    const r = applyTestResults(models, [{ id: "new", test: ok(AT) }, { id: "bad", test: bad(AT, "server error (503)") }]);
    expect(r.models).toEqual([{ id: "new", upstream: "new", enabled: true, addedAt: AT, lastTest: ok(AT) }, { id: "bad", upstream: "bad", enabled: false, lastTest: bad(AT) }]);
    expect(r.ready).toEqual(["new"]);
  });

  it("a failed model that passes its re-test is turned on (Argon once Google opens it); a re-test that fails changes only lastTest", () => {
    const models = [M("ag/gemini-4-argon-high", { enabled: false, lastTest: bad("2026-10-15T00:00:00.000Z") }), M("still", { enabled: true, lastTest: bad("2026-10-15T00:00:00.000Z") })];
    const r = applyTestResults(models, [{ id: "ag/gemini-4-argon-high", test: ok(AT) }, { id: "still", test: bad(AT) }]);
    expect(r.models[0]).toMatchObject({ enabled: true, lastTest: { ok: true } });
    expect(r.models[1]).toEqual({ id: "still", upstream: "still", enabled: true, lastTest: bad(AT) });
    expect(r.ready).toEqual(["ag/gemini-4-argon-high"]);
  });

  it("the owner's manualOff wins over a pass (switched off meanwhile); removed and manual models are left alone", () => {
    const models = [M("x", { enabled: false, manualOff: true, pending: true }), M("gone", { enabled: false, removed: true }), M("combo", { manual: true })];
    const r = applyTestResults(models, ["x", "gone", "combo"].map((id) => ({ id, test: ok(AT) })));
    expect(r.models).toEqual([{ id: "x", upstream: "x", enabled: false, manualOff: true, lastTest: ok(AT) }, models[1], models[2]]);
    expect(r.ready).toEqual([]);
  });

  it("a passing model that was already working is not reported again", () => {
    const r = applyTestResults([M("a", { lastTest: ok("2026-10-15T00:00:00.000Z") })], [{ id: "a", test: ok(AT) }]);
    expect(r.ready).toEqual([]);
  });
});

describe("throttle", () => {
  it("is due when never run, after 6 h, or after 5 min while new models wait", () => {
    expect(syncDue(NOW, { lastRunAt: null })).toBe(true);
    const at = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
    expect(syncDue(NOW, { lastRunAt: at(SYNC_EVERY_MS - 60_000) })).toBe(false);
    expect(syncDue(NOW, { lastRunAt: at(SYNC_EVERY_MS) })).toBe(true);
    expect(syncDue(NOW, { lastRunAt: at(PENDING_RETRY_MS - 1000), pending: true })).toBe(false);
    expect(syncDue(NOW, { lastRunAt: at(PENDING_RETRY_MS), pending: true })).toBe(true);
  });
  it("the in-memory slot reads the stored state at most once per 5 min", () => {
    expect(checkDue(NOW, null)).toBe(true);
    expect(checkDue(NOW, NOW.getTime() - CHECK_EVERY_MS + 1000)).toBe(false);
    expect(checkDue(NOW, NOW.getTime() - CHECK_EVERY_MS)).toBe(true);
  });
  it("reads a stored state defensively", () => {
    expect(readSyncState(null)).toEqual({ lastRunAt: null });
    expect(readSyncState({ lastRunAt: "nope", pending: "yes" })).toMatchObject({ lastRunAt: null, pending: false });
    expect(readSyncState({ lastRunAt: AT, pending: true, error: "x".repeat(300) })).toMatchObject({ lastRunAt: AT, pending: true, error: "x".repeat(200) });
  });
  it("status text and next run", () => {
    expect(syncStatusText({ lastRunAt: null }, NOW)).toBe("Auto-sync: on · not synced yet · next within minutes");
    const two = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    expect(syncStatusText({ lastRunAt: two }, NOW)).toBe("Auto-sync: on · last sync 2 h ago · next in 4 h");
    expect(syncStatusText({ lastRunAt: two, pending: true }, NOW)).toBe("Auto-sync: on · last sync 2 h ago · next within minutes");
    expect(nextSyncAt({ lastRunAt: AT })?.toISOString()).toBe(new Date(NOW.getTime() + SYNC_EVERY_MS).toISOString());
  });
});

describe("syncMessage", () => {
  it("one line per ready model and one per connection with removed models, HTML-escaped", () => {
    expect(syncMessage([{ name: "9Router", ready: ["ag/gemini-4-argon-high", "cx/gpt<5>"], removed: ["old-a", "old-b"] }])).toBe(
      "✅ New model ready to use: ag/gemini-4-argon-high\n✅ New model ready to use: cx/gpt&lt;5&gt;\n🗑 Model removed from 9Router: old-a, old-b",
    );
  });
  it("nothing to say → null", () => {
    expect(syncMessage([{ name: "9Router", ready: [], removed: [] }])).toBeNull();
    expect(syncMessage([])).toBeNull();
  });
});

describe("isNewModel", () => {
  it("is new for 7 days after a refresh first saw it", () => {
    expect(isNewModel({ addedAt: AT }, NOW)).toBe(true);
    expect(isNewModel({ addedAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() }, NOW)).toBe(false);
    expect(isNewModel({}, NOW)).toBe(false);
  });
});

describe("syncMessage in Indonesian", () => {
  it("translates both line kinds, still escaped", () => {
    expect(syncMessage([{ name: "9Router", ready: ["cx/gpt<5>"], removed: ["old-a"] }], "id")).toBe(
      "✅ Model baru siap dipakai: cx/gpt&lt;5&gt;\n🗑 Model dihapus dari 9Router: old-a",
    );
  });
});
