import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetTimeZoneForTests, toLocalInput } from "@/lib/time";
import {
  activeFor, covers, hasEnded, durationText, DURATIONS_MIN, MAX_WINDOWS, maintenanceSet, nextOccurrence, occurrence, parseWindowForm, splitTarget, targetValue, type Window, windowText,
} from "./maintenance";

const w = (o: Partial<Window> = {}): Window => ({ id: "w", scope: "app", appId: "a1", monitorId: null, startsAt: new Date("2026-10-12T18:00:00Z"), durationMin: 60, weekly: false, note: null, ...o });
// 2026-10-12T18:00Z is Tue 13 Oct 01:00 WIB.

describe("weekly windows keep their local wall time across daylight saving (Europe/Berlin, 1.1)", () => {
  beforeEach(() => resetTimeZoneForTests("Europe/Berlin"));
  afterEach(() => resetTimeZoneForTests());
  // Created for Monday 19 Oct 2026 10:00 CEST (08:00Z); clocks go back on Sunday 25 Oct.
  const weekly = () => w({ scope: "all", appId: null, startsAt: new Date("2026-10-19T08:00:00Z"), durationMin: 60, weekly: true });

  it("repeats on 26 Oct at 10:00 CET, which is 09:00Z, not 08:00Z", () => {
    expect(occurrence(weekly(), new Date("2026-10-26T08:30:00Z"))).toBeNull(); // 09:30 CET: not yet
    expect(occurrence(weekly(), new Date("2026-10-26T09:00:00Z"))).toEqual({ start: new Date("2026-10-26T09:00:00Z"), end: new Date("2026-10-26T10:00:00Z") });
    expect(occurrence(weekly(), new Date("2026-10-26T09:59:00Z"))).not.toBeNull();
    expect(occurrence(weekly(), new Date("2026-10-26T10:00:00Z"))).toBeNull();
    expect(nextOccurrence(weekly(), new Date("2026-10-20T12:00:00Z"))).toEqual({ start: new Date("2026-10-26T09:00:00Z"), end: new Date("2026-10-26T10:00:00Z") });
  });

  it("keeps 10:00 for months, and goes back to 08:00Z when summer time returns", () => {
    expect(nextOccurrence(weekly(), new Date("2027-01-01T00:00:00Z"))?.start.toISOString()).toBe("2027-01-04T09:00:00.000Z");
    expect(nextOccurrence(weekly(), new Date("2027-03-25T00:00:00Z"))?.start.toISOString()).toBe("2027-03-29T08:00:00.000Z"); // after 28 Mar
    expect(occurrence(weekly(), new Date("2027-03-29T08:15:00Z"))?.start.toISOString()).toBe("2027-03-29T08:00:00.000Z");
  });

  it("reads and writes the dialog's start and the Every … text in local time", () => {
    const p = parseWindowForm({ scope: "all", start: "2026-10-19T10:00", durationMin: 60, weekly: true });
    expect(p.ok && p.value.startsAt.toISOString()).toBe("2026-10-19T08:00:00.000Z");
    expect(toLocalInput(new Date("2026-10-26T09:00:00Z"))).toBe("2026-10-26T10:00");
    const t = windowText(weekly(), new Date("2026-10-26T09:30:00Z"));
    expect(t.when).toBe("Every Monday 10:00–11:00");
    expect(t.status.text).toBe("Active · until 11:00");
    // Sunday 23:30 local is still Sunday, though it is Sunday 21:30Z or 22:30Z.
    expect(windowText(w({ startsAt: new Date("2026-10-25T22:30:00Z"), weekly: true }), new Date("2026-10-20T00:00:00Z")).when).toBe("Every Sunday 23:30–00:30");
  });

  it("after a repeat the spring-forward gap moved (02:30 → 03:30), the next one is back at 02:30", () => {
    // Sunday 22 Mar 2026 02:30 CET (01:30Z); clocks go forward on Sunday 29 Mar at 02:00.
    const sunday = w({ scope: "all", appId: null, startsAt: new Date("2026-03-22T01:30:00Z"), durationMin: 60, weekly: true });
    expect(occurrence(sunday, new Date("2026-03-29T01:45:00Z"))?.start.toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 03:30 CEST
    const next = nextOccurrence(sunday, new Date("2026-03-29T05:00:00Z"));
    expect(next?.start.toISOString()).toBe("2026-04-05T00:30:00.000Z"); // 5 Apr 02:30 CEST
    expect(windowText(sunday, new Date("2026-03-29T05:00:00Z")).status.text).toBe("Next: 5 Apr 02:30");
    expect(occurrence(sunday, new Date("2026-04-05T00:40:00Z"))?.start.toISOString()).toBe("2026-04-05T00:30:00.000Z");
  });

  it("a weekly window starts exactly once a week, never twice in the 25-hour week", () => {
    const starts = new Set<string>();
    for (let t = Date.parse("2026-10-19T00:00:00Z"); t < Date.parse("2026-11-10T00:00:00Z"); t += 15 * 60_000) {
      const o = occurrence(weekly(), new Date(t));
      if (o) starts.add(o.start.toISOString());
    }
    expect([...starts]).toEqual(["2026-10-19T08:00:00.000Z", "2026-10-26T09:00:00.000Z", "2026-11-02T09:00:00.000Z", "2026-11-09T09:00:00.000Z"]);
  });
});

describe("occurrence", () => {
  it("covers a one-off window from start to end", () => {
    expect(occurrence(w(), new Date("2026-10-12T17:59:00Z"))).toBeNull();
    expect(occurrence(w(), new Date("2026-10-12T18:30:00Z"))).toEqual({ start: new Date("2026-10-12T18:00:00Z"), end: new Date("2026-10-12T19:00:00Z") });
    expect(occurrence(w(), new Date("2026-10-12T19:00:00Z"))).toBeNull();
  });
  it("repeats a weekly window every 7 days", () => {
    const weekly = w({ weekly: true });
    expect(occurrence(weekly, new Date("2026-10-19T18:20:00Z"))?.start).toEqual(new Date("2026-10-19T18:00:00Z"));
    expect(occurrence(weekly, new Date("2026-10-20T18:20:00Z"))).toBeNull();
  });
  it("finds the next occurrence, and none after a one-off ended", () => {
    expect(nextOccurrence(w({ weekly: true }), new Date("2026-10-13T00:00:00Z"))?.start).toEqual(new Date("2026-10-19T18:00:00Z"));
    expect(nextOccurrence(w(), new Date("2026-10-13T00:00:00Z"))).toBeNull();
  });
  it("gives the first occurrence before a window starts, and the current one inside it", () => {
    expect(nextOccurrence(w(), new Date("2026-10-12T10:00:00Z"))).toEqual({ start: new Date("2026-10-12T18:00:00Z"), end: new Date("2026-10-12T19:00:00Z") });
    expect(nextOccurrence(w({ weekly: true }), new Date("2026-10-26T18:59:00Z"))?.start).toEqual(new Date("2026-10-26T18:00:00Z"));
  });
});

describe("covers", () => {
  it("all covers every monitor, app the monitors of that app, monitor only that one", () => {
    expect(covers(w({ scope: "all", appId: null }), { monitorId: "m9", appId: "a9" })).toBe(true);
    expect(covers(w(), { monitorId: "m9", appId: "a1" })).toBe(true);
    expect(covers(w(), { monitorId: "m9", appId: "a2" })).toBe(false);
    expect(covers(w({ scope: "monitor", appId: null, monitorId: "m1" }), { monitorId: "m1", appId: "a1" })).toBe(true);
    expect(covers(w({ scope: "monitor", appId: null, monitorId: "m1" }), { monitorId: "m2", appId: "a1" })).toBe(false);
  });
});

describe("activeFor and maintenanceSet", () => {
  const now = new Date("2026-10-12T18:30:00Z");
  it("matches by scope", () => {
    expect(activeFor([w()], { monitorId: "m1", appId: "a1" }, now)?.end).toEqual(new Date("2026-10-12T19:00:00Z"));
    expect(activeFor([w()], { monitorId: "m2", appId: "a2" }, now)).toBeNull();
    expect(activeFor([w({ scope: "all", appId: null })], { monitorId: "m2", appId: "a2" }, now)).not.toBeNull();
    expect(activeFor([w({ scope: "monitor", appId: null, monitorId: "m1" })], { monitorId: "m1", appId: "a9" }, now)).not.toBeNull();
  });
  it("names the window that ends last when two cover the monitor at once", () => {
    const long = w({ id: "long", scope: "all", appId: null, durationMin: 180 });
    expect(activeFor([w(), long], { monitorId: "m1", appId: "a1" }, now)?.window.id).toBe("long");
  });
  it("lists the monitors and apps inside a window right now", () => {
    expect(maintenanceSet([w()], [{ id: "m1", appId: "a1" }, { id: "m2", appId: "a2" }], now)).toEqual(new Set(["m1", "a1"]));
  });
  it("a window on one monitor doesn't put its app (and so its other monitors' alerts) in maintenance", () => {
    const one = w({ scope: "monitor", appId: null, monitorId: "m1" });
    expect(maintenanceSet([one], [{ id: "m1", appId: "a1" }, { id: "m2", appId: "a1" }], now)).toEqual(new Set(["m1"]));
  });
  it("puts an app under a whole-app window in maintenance even without an active monitor (review M2)", () => {
    expect(maintenanceSet([w()], [], now)).toEqual(new Set(["a1"]));
  });
  it("puts every app it is told about under an all-monitors window, monitors or not (review M2)", () => {
    expect(maintenanceSet([w({ scope: "all", appId: null })], [{ id: "m1", appId: "a1" }], now, ["a1", "a2"])).toEqual(new Set(["m1", "a1", "a2"]));
    expect(maintenanceSet([w({ scope: "all", appId: null })], [], new Date("2026-10-12T19:00:00Z"), ["a2"]).size).toBe(0);
  });
  it("is empty outside every window", () => {
    expect(maintenanceSet([w()], [{ id: "m1", appId: "a1" }], new Date("2026-10-12T19:00:00Z")).size).toBe(0);
  });
  it("allows at most 20 windows", () => {
    expect(MAX_WINDOWS).toBe(20);
  });
});

describe("parseWindowForm", () => {
  it("reads a WIB start and a duration", () => {
    expect(parseWindowForm({ scope: "app", targetId: "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f", start: "2026-10-13T22:00", durationMin: "90", weekly: false, note: " DNS move " }))
      .toEqual({ ok: true, value: { scope: "app", appId: "6f0d4c1e-7c55-4a0b-9d2e-1a2b3c4d5e6f", monitorId: null, startsAt: new Date("2026-10-13T15:00:00Z"), durationMin: 90, weekly: false, note: "DNS move" } });
  });
  it("rejects bad input", () => {
    expect(parseWindowForm({ scope: "app", targetId: "x", start: "", durationMin: "2", weekly: false })).toEqual({ ok: false, fieldErrors: {
      start: "Pick a start time.", durationMin: "Pick how long it lasts.", targetId: "Pick an application." } });
  });
  it("needs no target for all monitors, and a monitor id for one monitor", () => {
    const base = { start: "2026-10-13T22:00", durationMin: 30, weekly: true };
    expect(parseWindowForm({ ...base, scope: "all", targetId: "ignored" })).toMatchObject({ ok: true, value: { scope: "all", appId: null, monitorId: null, weekly: true, note: null } });
    expect(parseWindowForm({ ...base, scope: "monitor", targetId: "" })).toEqual({ ok: false, fieldErrors: { targetId: "Pick a monitor." } });
    expect(parseWindowForm({ ...base, scope: "everything" })).toEqual({ ok: false, fieldErrors: { scope: "Pick what it applies to." } });
  });
  it("rejects an impossible date and keeps the note to 120 characters", () => {
    expect(parseWindowForm({ scope: "all", start: "2026-13-40T22:00", durationMin: 30 })).toEqual({ ok: false, fieldErrors: { start: "Pick a start time." } });
    const r = parseWindowForm({ scope: "all", start: "2026-10-13T22:00", durationMin: 30, note: "x".repeat(300) });
    expect(r.ok && r.value.note?.length).toBe(120);
  });
});

describe("windowText", () => {
  it("writes a weekly window as its WIB weekday and a one-off as its date", () => {
    expect(windowText(w({ weekly: true }), new Date("2026-10-12T10:00:00Z")).when).toBe("Every Tuesday 01:00–02:00");
    expect(windowText(w({ durationMin: 90 }), new Date("2026-10-12T10:00:00Z")).when).toBe("13 Oct 01:00–02:30");
  });
  it("says Active until the end, Next before it, Over after a one-off", () => {
    expect(windowText(w(), new Date("2026-10-12T18:30:00Z")).status).toEqual({ state: "maint", text: "Active · until 02:00" });
    expect(windowText(w(), new Date("2026-10-12T10:00:00Z")).status).toEqual({ state: "off", text: "Next: 13 Oct 01:00" });
    expect(windowText(w(), new Date("2026-10-12T19:00:00Z")).status).toEqual({ state: "off", text: "Over" });
    expect(windowText(w({ weekly: true }), new Date("2026-10-12T19:00:00Z")).status).toEqual({ state: "off", text: "Next: 20 Oct 01:00" });
  });
});

describe("dialog helpers", () => {
  it("names the durations as the mockup does", () => {
    expect(DURATIONS_MIN.map(durationText)).toEqual(["30 min", "1 h", "1 h 30 min", "3 h", "6 h"]);
  });
  it("puts Applies to in one select value and reads it back as scope and target", () => {
    expect(targetValue(w({ scope: "all", appId: null }))).toBe("all");
    expect(targetValue(w())).toBe("app:a1");
    expect(targetValue(w({ scope: "monitor", appId: null, monitorId: "m1" }))).toBe("monitor:m1");
    expect(splitTarget("all")).toEqual({ scope: "all", targetId: "" });
    expect(splitTarget("app:a1")).toEqual({ scope: "app", targetId: "a1" });
    expect(splitTarget("monitor:m1")).toEqual({ scope: "monitor", targetId: "m1" });
    expect(splitTarget("bogus")).toEqual({ scope: "", targetId: "" });
  });
  it("gives a stored start back as the WIB datetime-local value it was typed as", () => {
    expect(toLocalInput(new Date("2026-10-13T15:00:00Z"))).toBe("2026-10-13T22:00");
    const p = parseWindowForm({ scope: "all", start: toLocalInput(new Date("2026-10-12T18:00:00Z")), durationMin: 60 });
    expect(p.ok && p.value.startsAt).toEqual(new Date("2026-10-12T18:00:00Z"));
  });
});

describe("hasEnded (review M4)", () => {
  it("is true for a one-off whose end has passed, never for a weekly window", () => {
    expect(hasEnded(w(), new Date("2026-10-12T19:00:00Z"))).toBe(true);
    expect(hasEnded(w(), new Date("2026-10-12T18:59:00Z"))).toBe(false);
    expect(hasEnded(w({ weekly: true }), new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });
});
