import { describe, expect, it } from "vitest";
import { firestoreFailure, firestoreState, quotaDayStart } from "./firebase";

describe("firestoreState", () => {
  it("names each outcome of the health read", () => {
    expect(firestoreState({ ok: true, data: { reachable: true, noDatabase: false, latencyMs: 84 } })).toEqual({ state: "ok", label: "Reachable · 84 ms" });
    expect(firestoreState({ ok: true, data: { reachable: false, noDatabase: true, latencyMs: 60 } })).toEqual({ state: "off", label: "No Firestore database" });
    expect(firestoreState({ ok: false, kind: "transient", reason: "RESOURCE_EXHAUSTED", error: "x" })).toEqual({ state: "err", label: "Daily quota used up" });
    expect(firestoreState({ ok: false, kind: "scope", error: "x" })).toEqual({ state: "err", label: "No access: needs datastore.viewer" });
    expect(firestoreState({ ok: false, kind: "transient", error: "x" })).toEqual({ state: "unknown", label: "Unknown" });
  });
});

describe("firestoreFailure", () => {
  it("names a missing role, a project with the API off and a used-up quota, from the kind and reason Google gave", () => {
    expect(firestoreFailure({ kind: "scope", reason: "PERMISSION_DENIED" })).toEqual({ state: "err", label: "No access: needs datastore.viewer" });
    expect(firestoreFailure({ kind: null, reason: "PERMISSION_DENIED" })).toEqual({ state: "err", label: "No access: needs datastore.viewer" }); // older snapshots
    expect(firestoreFailure({ kind: "scope", reason: "SERVICE_DISABLED" })).toEqual({ state: "err", label: "Firestore API is off in this project" });
    expect(firestoreFailure({ kind: "transient", reason: "RESOURCE_EXHAUSTED" })).toEqual({ state: "err", label: "Daily quota used up" });
  });
  it("leaves a timeout or a 5xx as Unknown, which is not an error state", () => {
    expect(firestoreFailure({ kind: "transient" })).toEqual({ state: "unknown", label: "Unknown" });
    expect(firestoreFailure({})).toEqual({ state: "unknown", label: "Unknown" });
  });
});

describe("quotaDayStart", () => {
  it("is midnight in Los Angeles, in summer and in winter time", () => {
    expect(quotaDayStart(new Date("2026-10-12T12:00:00Z"))).toEqual(new Date("2026-10-12T07:00:00Z"));
    expect(quotaDayStart(new Date("2026-12-01T05:00:00Z"))).toEqual(new Date("2026-11-30T08:00:00Z"));
  });
});
