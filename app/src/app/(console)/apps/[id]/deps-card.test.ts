import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./deps-scan-button", () => ({ DepsScanButton: () => null }));

import type { AppDepsView } from "@/lib/data/deps-db";
import { DependenciesCard } from "./deps-card";

const now = new Date("2026-10-24T08:00:00Z");
const repo = { id: "r1", fullName: "me/app" };
const render = (view: AppDepsView, devopsOff = false) =>
  renderToStaticMarkup(h(DependenciesCard, { app: { id: "a1", name: "app" }, view, canAct: true, owner: true, now, devopsOff }));
const view = (scan: AppDepsView["scan"], r: AppDepsView["repo"] = repo): AppDepsView => ({ repo: r, scan, vulns: [], writeConnected: true });

describe("DependenciesCard: 'Not scanned' with the reason, never a false 'None known' (owner 24 Oct)", () => {
  it("a clean successful scan says None known", () => {
    const html = render(view({ scannedAt: now, lockfilePath: "package-lock.json", packageCount: 10, error: null, note: null }));
    expect(html).toContain("None known");
    expect(html).not.toContain("Not scanned");
  });

  it("no lockfile found: Not scanned, not None known", () => {
    const html = render(view({ scannedAt: now, lockfilePath: null, packageCount: 0, error: null, note: "No package.json or lockfile at the repository root." }));
    expect(html).toContain("Not scanned");
    expect(html).toContain("no lockfile or package.json was found");
    expect(html).toContain("No package.json or lockfile at the repository root.");
    expect(html).not.toContain("None known");
  });

  it("a failed first scan shows the error, not None known", () => {
    const html = render(view({ scannedAt: now, lockfilePath: null, packageCount: 0, error: "GitHub answered 502.", note: null }));
    expect(html).toContain("Not scanned");
    expect(html).toContain("GitHub answered 502.");
    expect(html).not.toContain("None known");
  });

  // Review T4c Minor 5: no advisory table under "Not scanned".
  it("doesn't list old advisories under Not scanned", () => {
    const v = { ...view({ scannedAt: now, lockfilePath: null, packageCount: 0, error: "boom", note: null }), vulns: [{ package: "next", installedVersion: "16.0.0", vulnId: "GHSA-x", severity: "high" as const, fixedVersion: "16.0.1", summary: "s", aliases: [], dev: false, direct: true, firstSeenAt: now }] };
    const html = render(v);
    expect(html).toContain("Not scanned");
    expect(html).not.toContain("GHSA-x");
  });

  it("no linked repository", () => {
    const html = render(view(null, null));
    expect(html).toContain("Not scanned");
    expect(html).toContain("no linked repository");
  });

  it("DevOps off: the reason, and an older scan is marked as paused", () => {
    expect(render(view(null), true)).toContain("DevOps is off");
    const html = render(view({ scannedAt: now, lockfilePath: "package-lock.json", packageCount: 10, error: null, note: null }), true);
    expect(html).toContain("None known");
    expect(html).toContain("Scans pause while DevOps is off");
  });
});
