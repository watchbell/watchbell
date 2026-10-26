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

  // 1.2.3 (owner 26 Oct): dev-only advisories are local tooling; they are counted apart and say they don't reach
  // production, so leftovers like drizzle-kit's esbuild don't read as an open production problem.
  const adv = (pkg: string, severity: "high" | "moderate", dev: boolean) =>
    ({ package: pkg, installedVersion: "1.0.0", vulnId: `GHSA-${pkg}`, severity, fixedVersion: null, summary: "s", aliases: [], dev, direct: !dev, firstSeenAt: now });
  const scanned = { scannedAt: now, lockfilePath: "package-lock.json", packageCount: 10, error: null, note: null };

  it("only dev-only advisories: production reads None known, the dev ones are counted apart with no production impact", () => {
    const html = render({ ...view(scanned), vulns: [adv("esbuild", "moderate", true), adv("drizzle-kit", "moderate", true)] });
    expect(html).toContain("In production");
    expect(html).toContain("None known");
    expect(html).toContain("Development tools");
    expect(html).toContain("Local development only, no production impact. Not alerted.");
    expect(html).toContain("dev only, local");
  });

  it("production and dev-only advisories: each row has its own count", () => {
    const html = render({ ...view(scanned), vulns: [adv("zod", "high", false), adv("esbuild", "moderate", true)] });
    expect(html).not.toContain("None known");
    const prodRow = html.split("In production</dt><dd>")[1]?.split("</dd>")[0] ?? "";
    expect(prodRow).toContain(">1</span>");
    expect(prodRow).not.toContain("Local development only");
    expect(html).toContain("Local development only, no production impact.");
  });

  it("no dev-only advisories: no Development tools row", () => {
    const html = render({ ...view(scanned), vulns: [adv("zod", "high", false)] });
    expect(html).toContain("In production");
    expect(html).not.toContain("Development tools");
  });

  it("DevOps off: the reason, and an older scan is marked as paused", () => {
    expect(render(view(null), true)).toContain("DevOps is off");
    const html = render(view({ scannedAt: now, lockfilePath: "package-lock.json", packageCount: 10, error: null, note: null }), true);
    expect(html).toContain("None known");
    expect(html).toContain("Scans pause while DevOps is off");
  });
});
