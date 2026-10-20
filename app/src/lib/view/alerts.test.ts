import { describe, expect, it } from "vitest";
import { notifiedText, ruleState, sevLabel, silenceUntil, tookText } from "./alerts";

const now = new Date("2026-10-13T12:44:00Z"); // 19:44 WIB
const a = { pending: null, notifiedOpen: true, lastNotifiedAt: now, causedBy: null, silencedUntil: null, silencedUntilResolved: false };

describe("alert labels", () => {
  it("labels severities", () => expect(sevLabel("critical")).toBe("Critical"));
  it("says how the alert was notified", () => {
    expect(notifiedText(a, now)).toEqual({ state: "ok", text: "Sent 19:44" });
    expect(notifiedText({ ...a, notifiedOpen: false, pending: "open" }, now)).toEqual({ state: "build", text: "Sending…" });
    expect(notifiedText({ ...a, notifiedOpen: false, causedBy: "CollectorStale" }, now)).toEqual({ state: "off", text: "Muted" });
    expect(notifiedText({ ...a, silencedUntilResolved: true }, now)).toEqual({ state: "off", text: "Silenced until resolved" });
    expect(notifiedText({ ...a, silencedUntil: new Date(now.getTime() + 30 * 60_000) }, now)).toEqual({ state: "off", text: "Silenced until 20:14" });
    expect(notifiedText({ ...a, notifiedOpen: false, lastNotifiedAt: null }, now)).toEqual({ state: "off", text: "Digest only" });
  });
  it("describes a rule's state", () => {
    expect(ruleState({ enabled: true, firing: 2, hasData: true })).toEqual({ state: "err", text: "Firing · 2" });
    expect(ruleState({ enabled: true, firing: 0, hasData: true })).toEqual({ state: "off", text: "Inactive" });
    expect(ruleState({ enabled: true, firing: 0, hasData: false })).toEqual({ state: "unknown", text: "No data yet" });
    expect(ruleState({ enabled: false, firing: 0, hasData: true })).toEqual({ state: "off", text: "Disabled" });
  });
  it("formats durations and silences", () => {
    expect(tookText(new Date(0), new Date(6 * 60_000))).toBe("6 min");
    expect(tookText(new Date(0), new Date((2 * 24 + 4) * 3_600_000))).toBe("2 d 4 h");
    expect(silenceUntil("1h", now)).toEqual({ silencedUntil: new Date(now.getTime() + 3_600_000), silencedUntilResolved: false });
    expect(silenceUntil("resolved", now)).toEqual({ silencedUntil: null, silencedUntilResolved: true });
  });
});
