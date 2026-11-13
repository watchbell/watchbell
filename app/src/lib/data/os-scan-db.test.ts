import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ db: vi.fn() }));

import type { OsScan } from "@/lib/os/scan";
import { loadOsScan, type OsScanDeps, osState, readStored, runOsScan } from "./os-scan-db";

const ok = (over: Partial<OsScan> = {}): OsScan => ({
  status: "ok", system: "Ubuntu 22.04.5 LTS", ecosystem: "Ubuntu:22.04:LTS", codename: "jammy", packages: 1476, kernel: null,
  updates: [], backlog: { counts: {}, total: 0, error: null }, aptListsAgeHours: 1, scannedAt: "2026-11-11T09:00:00.000Z", error: null, ...over,
});

function deps(stored: unknown, next: OsScan, state: "on" | "off-cloud" | "demo" = "on"): OsScanDeps & { saved: unknown[] } {
  const saved: unknown[] = [];
  return { saved, state: () => state, scan: async () => next, read: async () => stored, write: async (v) => { saved.push(v); } };
}

describe("osState", () => {
  it("self-hosted only; the demo shows made-up data", () => {
    expect(osState({ WATCHBELL_MODE: "cloud" })).toBe("off-cloud");
    expect(osState({ WATCHBELL_MODE: "demo" })).toBe("demo");
    expect(osState({ WATCHBELL_MODE: "selfhost" })).toBe("on");
  });
});

describe("runOsScan", () => {
  it("stores a new scan", async () => {
    const d = deps(null, ok());
    expect(await runOsScan(d)).toEqual({ ok: true, data: ok() });
    expect(d.saved).toEqual([ok()]);
  });
  it("a failed scan keeps the last good findings and says when and why it failed", async () => {
    const good = ok({ updates: [{ source: "x", binaries: ["x"], installed: "1", candidate: "2", pockets: ["jammy-security"], security: true, fixes: [], error: null }] });
    const d = deps(good, ok({ status: "error", error: "Couldn't list the installed packages (boom).", scannedAt: "2026-11-12T09:00:00.000Z" }));
    const r = await runOsScan(d);
    expect(r).toEqual({ ok: true, data: { ...good, error: "Couldn't list the installed packages (boom).", failedAt: "2026-11-12T09:00:00.000Z" } });
  });
  it("refuses in the cloud edition and in the demo", async () => {
    expect(await runOsScan(deps(null, ok(), "off-cloud"))).toEqual({ ok: false, error: "OS checks are part of the self-hosted edition." });
    expect((await runOsScan(deps(null, ok(), "demo"))).ok).toBe(false);
  });
});

describe("loadOsScan / readStored", () => {
  it("reads a stored scan, and nothing for junk", async () => {
    expect(await loadOsScan(deps(ok(), ok()))).toEqual(ok());
    expect(readStored({ status: "ok" })).toBeNull();
    expect(readStored("x")).toBeNull();
    expect(readStored(null)).toBeNull();
  });
});
