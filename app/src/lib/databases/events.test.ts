import { describe, expect, it } from "vitest";
import { classifyFailure, databaseEvent, goodState } from "./events";

const at = new Date("2026-10-12T02:12:00Z");
const ev = (kind: "supabase_project" | "neon_project" | "firestore", prev: Parameters<typeof databaseEvent>[0]["prev"], next: Parameters<typeof databaseEvent>[0]["next"], label = "x") =>
  databaseEvent({ kind, resourceId: "r1", prev, next, label, at });

describe("databaseEvent (D5)", () => {
  it("records Supabase pauses, comebacks, ill health and failures", () => {
    expect(ev("supabase_project", "ok", "paused")).toEqual({ resourceId: "r1", type: "database", reason: "DatabasePaused", kind: "paused", message: "Supabase project paused", detail: "Status changed to INACTIVE", at });
    expect(ev("supabase_project", "build", "ok")).toMatchObject({ kind: "ok", message: "Supabase project active again", detail: "Status changed to ACTIVE_HEALTHY" });
    expect(ev("supabase_project", "ok", "warn", "Active unhealthy")).toMatchObject({ kind: "warn", message: "Supabase project unhealthy" });
    expect(ev("supabase_project", "build", "err", "Restore failed")).toMatchObject({ kind: "err", message: "Supabase project: restore failed" });
  });
  it("is quiet for transitional states, first sight, unknown and no change", () => {
    expect(ev("supabase_project", "paused", "build")).toBeNull();
    expect(ev("supabase_project", null, "paused")).toBeNull();
    expect(ev("supabase_project", "ok", "unknown")).toBeNull();
    expect(ev("supabase_project", "ok", "ok")).toBeNull();
  });
  it("leaves Neon's scale-to-zero alone and records a suspended compute", () => {
    expect(ev("neon_project", "ok", "idle")).toBeNull();
    expect(ev("neon_project", "idle", "ok")).toBeNull();
    expect(ev("neon_project", "idle", "err", "CU-hours used up")).toMatchObject({ kind: "err", message: "Neon compute suspended", detail: "CU-hours used up" });
    expect(ev("neon_project", "err", "idle")).toMatchObject({ kind: "ok", message: "Neon compute available again" });
  });
  it("records Firestore outages, quota and recovery", () => {
    expect(ev("firestore", "ok", "err", "Daily quota used up")).toMatchObject({ kind: "err", message: "Firestore daily quota used up" });
    expect(ev("firestore", "ok", "err", "No access: needs datastore.viewer")).toMatchObject({ kind: "err", message: "Firestore not reachable" });
    expect(ev("firestore", "err", "ok")).toMatchObject({ kind: "ok", message: "Firestore reachable again" });
  });
});

describe("goodState (D6)", () => {
  it("looks through unknown to the last good state", () => {
    expect(goodState(null)).toBeNull();
    expect(goodState({ state: "paused", data: {} })).toBe("paused");
    expect(goodState({ state: "unknown", data: { lastGoodState: "idle" } })).toBe("idle");
    expect(goodState({ state: "unknown", data: { lastGoodState: "nonsense" } })).toBeNull();
  });
});

describe("classifyFailure", () => {
  it("flips the account only for a rejected credential, or a scope gap on the account-wide list", () => {
    expect(classifyFailure({ kind: "auth" }, false)).toBe("auth");
    expect(classifyFailure({ kind: "scope" }, true)).toBe("auth");
    expect(classifyFailure({ kind: "scope" }, false)).toBe("column");
    expect(classifyFailure({ kind: "transient" }, true)).toBe("unknown");
    expect(classifyFailure({ kind: "format" }, false)).toBe("unknown");
  });
});
