import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIONS_COPY } from "@/lib/copy/edition";

vi.mock("@/db/client", () => ({ db: () => { throw new Error("no database in tests"); } }));
vi.mock("@/lib/data/audit-db", () => ({ recordAction: vi.fn() }));

import {
  AUTO_ROLLBACK_OFF, AUTO_RUN_OFF, AutoRunInputError, parseAutoRollback, parseAutoRun, readAutoRollback, readAutoRun, SAFE_KINDS, validateAutoRollback, validateAutoRun,
  writeAutoRollback, writeAutoRun, parseAutoSecurity, readAutoSecurity, validateAutoSecurity, writeAutoSecurity,
} from "./proposals-settings";

const ACTOR = { userId: "user-1" };
const ALL_ON = { recheck: true, neon_wake: true, supabase_keepalive: true, supabase_restore: true, vercel_redeploy: true, vercel_rollback: true, github_bump_pr: true, domain_recheck: true, daily_rerun: false };

function deps(stored: unknown) {
  const state = { stored };
  return {
    state,
    read: vi.fn(async () => state.stored),
    write: vi.fn(async (v: unknown) => { state.stored = v; }),
    audit: vi.fn(async () => undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("readAutoRun", () => {
  it("missing or odd values read as all off", async () => {
    for (const raw of [null, undefined, "on", 1, [], [true], { recheck: "true" }, { recheck: 1 }]) {
      expect(await readAutoRun({ read: async () => raw })).toEqual(AUTO_RUN_OFF);
    }
  });

  it("keeps the safe kinds that are switched on, and a risky kind is always false whatever is stored", async () => {
    expect(await readAutoRun({ read: async () => ({ ...ALL_ON, extra: true }) })).toEqual({
      recheck: true, neon_wake: true, supabase_keepalive: true, supabase_restore: false, vercel_redeploy: false, vercel_rollback: false, github_bump_pr: false, domain_recheck: true, daily_rerun: false,
    });
    expect(Object.keys(parseAutoRun({ extra: true })).sort()).toEqual(Object.keys(ALL_ON).sort());
  });

  it("the safe kinds are the four idempotent ones", () => {
    expect(SAFE_KINDS).toEqual(["recheck", "neon_wake", "supabase_keepalive", "domain_recheck"]);
  });
});

describe("validateAutoRun", () => {
  it("refuses a non-object, an unknown kind or a non-boolean (a crafted request)", () => {
    for (const bad of [null, "x", 3, [true], { nope: true }, { recheck: "true" }, { recheck: 1 }, { __proto__: { recheck: true }, toString: true }]) {
      expect(() => validateAutoRun(bad)).toThrow(AutoRunInputError);
    }
  });
  it("forces a risky kind to false", () => {
    expect(validateAutoRun({ recheck: true, vercel_redeploy: true })).toEqual({ recheck: true, vercel_redeploy: false });
  });
});

describe("writeAutoRun", () => {
  it("merges into what is saved, saves the full setting and audits what changed", async () => {
    const d = deps({ recheck: true });
    const out = await writeAutoRun({ neon_wake: true }, ACTOR, d);
    expect(out).toEqual({ ...AUTO_RUN_OFF, recheck: true, neon_wake: true });
    expect(d.write).toHaveBeenCalledWith(out);
    expect(d.audit).toHaveBeenCalledWith({ message: ACTIONS_COPY.settingsAudit.autoRun, detail: "Wake Neon off → on", actorUserId: "user-1" });
  });

  it("a risky kind can't be switched on: it is saved false (and asking for it alone changes nothing)", async () => {
    const d = deps(null);
    expect(await writeAutoRun({ vercel_redeploy: true, vercel_rollback: true, supabase_restore: true }, ACTOR, d)).toEqual(AUTO_RUN_OFF);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();

    const d2 = deps({ vercel_redeploy: true }); // a hand-edited row
    expect(await writeAutoRun({ recheck: true }, ACTOR, d2)).toEqual({ ...AUTO_RUN_OFF, recheck: true });
    expect(d2.state.stored).toEqual({ ...AUTO_RUN_OFF, recheck: true });
  });

  it("invalid input throws before anything is read or written", async () => {
    const d = deps(null);
    await expect(writeAutoRun({ nope: true } as never, ACTOR, d)).rejects.toThrow(AutoRunInputError);
    await expect(writeAutoRun({ recheck: "yes" } as never, ACTOR, d)).rejects.toThrow(AutoRunInputError);
    expect(d.read).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("a failed audit write is logged and doesn't undo the change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps(null);
    d.audit.mockRejectedValue(new Error("db down"));
    expect(await writeAutoRun({ recheck: true }, ACTOR, d)).toEqual({ ...AUTO_RUN_OFF, recheck: true });
    expect(d.write).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("settings audit failed");
    warn.mockRestore();
  });
});

describe("auto-rollback setting", () => {
  it("parses what is stored: off and 30 min by default, the window kept only when 10–120 whole minutes", () => {
    expect(parseAutoRollback(null)).toEqual({ enabled: false, windowMin: 30 });
    expect(parseAutoRollback({ enabled: true, windowMin: 45 })).toEqual({ enabled: true, windowMin: 45 });
    expect(parseAutoRollback({ enabled: "yes", windowMin: 9 })).toEqual(AUTO_ROLLBACK_OFF);
    expect(parseAutoRollback({ enabled: true, windowMin: 121 }).windowMin).toBe(30);
    expect(parseAutoRollback({ enabled: true, windowMin: 10 }).windowMin).toBe(10);
    expect(parseAutoRollback({ enabled: true, windowMin: 120 }).windowMin).toBe(120);
    expect(parseAutoRollback({ enabled: true, windowMin: 30.5 }).windowMin).toBe(30);
    expect(parseAutoRollback([true])).toEqual(AUTO_ROLLBACK_OFF);
  });
  it("validates input strictly", () => {
    expect(validateAutoRollback({ enabled: true, windowMin: 60 })).toEqual({ enabled: true, windowMin: 60 });
    for (const bad of [null, [], { enabled: "on" }, { windowMin: 5 }, { windowMin: 121 }, { windowMin: "30" }, { other: true }]) {
      expect(() => validateAutoRollback(bad)).toThrow(AutoRunInputError);
    }
  });
  it("reads, merges, saves and audits what changed", async () => {
    const d = deps({ enabled: false, windowMin: 30 });
    expect(await readAutoRollback(d)).toEqual({ enabled: false, windowMin: 30 });
    const out = await writeAutoRollback({ enabled: true, windowMin: 45 }, ACTOR, d);
    expect(out).toEqual({ enabled: true, windowMin: 45 });
    expect(d.write).toHaveBeenCalledWith(out);
    expect(d.audit).toHaveBeenCalledWith({ message: ACTIONS_COPY.settingsAudit.autoRollback, detail: "Auto-rollback off → on, window 30 → 45 min", actorUserId: "user-1" });
    d.write.mockClear();
    d.audit.mockClear();
    await writeAutoRollback({ enabled: true }, ACTOR, d);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });
});

describe("automatic security fixes setting", () => {
  it("is ON by default for critical and high; a stored row decides", () => {
    expect(parseAutoSecurity(null)).toEqual({ enabled: true, severities: ["critical", "high"], sameMajorOnly: true });
    expect(parseAutoSecurity({ enabled: false, severities: ["critical"] })).toEqual({ enabled: false, severities: ["critical"], sameMajorOnly: true });
    expect(parseAutoSecurity({ enabled: true, severities: ["high", "critical"] }).severities).toEqual(["critical", "high"]);
    expect(parseAutoSecurity({ enabled: "yes", severities: ["moderate"] })).toEqual({ enabled: false, severities: ["critical", "high"], sameMajorOnly: true });
    expect(parseAutoSecurity({ enabled: true, severities: [], sameMajorOnly: false })).toEqual({ enabled: true, severities: [], sameMajorOnly: true });
  });
  it("validates input strictly; a major update can't be allowed", () => {
    expect(validateAutoSecurity({ enabled: false, severities: ["critical"] })).toEqual({ enabled: false, severities: ["critical"] });
    for (const bad of [null, { enabled: 1 }, { severities: ["moderate"] }, { severities: "critical" }, { sameMajorOnly: false }, { other: 1 }]) {
      expect(() => validateAutoSecurity(bad)).toThrow(AutoRunInputError);
    }
  });
  it("reads the default, saves and audits what changed", async () => {
    const d = deps(null);
    expect(await readAutoSecurity(d)).toEqual({ enabled: true, severities: ["critical", "high"], sameMajorOnly: true });
    const out = await writeAutoSecurity({ severities: ["critical"] }, ACTOR, d);
    expect(out).toEqual({ enabled: true, severities: ["critical"], sameMajorOnly: true });
    expect(d.audit).toHaveBeenCalledWith({ message: ACTIONS_COPY.settingsAudit.autoSecurity, detail: "severities critical+high → critical", actorUserId: "user-1" });
    d.audit.mockClear();
    await writeAutoSecurity({ enabled: false }, ACTOR, d);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ detail: "Automatic security fixes on → off" }));
  });
});
