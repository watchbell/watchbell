import { describe, expect, it } from "vitest";
import { depsCoverage } from "./coverage";

const at = new Date("2026-10-24T08:00:00Z");
const repo = { id: "r1", fullName: "me/app" };
const ok = { scannedAt: at, lockfilePath: "package-lock.json", packageCount: 120, error: null, note: null };

describe("depsCoverage (owner 24 Oct: 'Not scanned' with the reason, never a false 'None known')", () => {
  it("a successful scan with a lockfile covers the app", () => {
    expect(depsCoverage({ repo, scan: ok }, false)).toEqual({ scanned: true, paused: false });
  });

  it("no linked repository", () => {
    const c = depsCoverage({ repo: null, scan: null }, false);
    expect(c.scanned).toBe(false);
    if (!c.scanned) expect(c.reason).toBe("no-repo");
  });

  it("DevOps off and never scanned: the reason is DevOps, not 'not yet'", () => {
    const c = depsCoverage({ repo, scan: null }, true);
    expect(c).toEqual({ scanned: false, reason: "devops-off" });
  });

  it("a first scan that failed is not a scan (it used to show 'None known')", () => {
    const c = depsCoverage({ repo, scan: { scannedAt: at, lockfilePath: null, packageCount: 0, error: "GitHub said 500", note: null } }, false);
    expect(c).toEqual({ scanned: false, reason: "failed" });
  });

  it("no lockfile or package.json found: not scanned", () => {
    const c = depsCoverage({ repo, scan: { ...ok, lockfilePath: null, packageCount: 0, note: "No package.json or lockfile at the repository root." } }, false);
    expect(c).toEqual({ scanned: false, reason: "no-lockfile" });
  });

  it("never scanned yet", () => {
    expect(depsCoverage({ repo, scan: null }, false)).toEqual({ scanned: false, reason: "not-yet" });
    expect(depsCoverage({ repo, scan: { ...ok, scannedAt: null } }, false)).toEqual({ scanned: false, reason: "not-yet" });
  });

  it("an older successful scan with DevOps off is kept, marked paused", () => {
    expect(depsCoverage({ repo, scan: ok }, true)).toEqual({ scanned: true, paused: true });
  });

  it("a later failure keeps the earlier successful scan", () => {
    expect(depsCoverage({ repo, scan: { ...ok, error: "rate limited" } }, false)).toEqual({ scanned: true, paused: false });
  });

  it("package.json ranges (no lockfile, packages read) are a scan", () => {
    expect(depsCoverage({ repo, scan: { ...ok, lockfilePath: "package.json", packageCount: 12 } }, false).scanned).toBe(true);
  });
});
