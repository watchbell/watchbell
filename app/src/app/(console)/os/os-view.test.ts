import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./os-actions", () => ({ scanNowAction: vi.fn() }));

import { DEMO_OS_SCAN } from "@/lib/os/demo";
import { OsView } from "./os-view";

const NOW = new Date("2026-11-11T05:00:00Z");
const render = (p: Partial<Parameters<typeof OsView>[0]> = {}) => renderToStaticMarkup(h(OsView, { initial: DEMO_OS_SCAN, owner: true, demo: false, now: NOW, ...p }));

describe("OS vulnerabilities page", () => {
  it("names the machine and asks for the pending kernel reboot", () => {
    const out = render();
    expect(out).toContain("Ubuntu 22.04.5 LTS");
    expect(out).toContain("Kernel 5.15.0-201.211 is installed, but 5.15.0-199.209 is still running. Reboot to run it.");
    expect(out).toContain("sudo reboot");
    expect(out).toContain('href="https://ubuntu.com/security/notices?release=jammy&amp;details=linux"');
  });
  it("lists the security updates with each CVE's score, Ubuntu priority, links, and a command to copy", () => {
    const out = render();
    expect(out).toContain("CVE-2026-111183");
    expect(out).toContain("9.8");
    expect(out).toContain("Ubuntu priority: medium");
    expect(out).toContain('href="https://ubuntu.com/security/CVE-2026-111183"');
    expect(out).toContain('href="https://ubuntu.com/security/notices/USN-9038-1"');
    expect(out).toContain('href="https://nvd.nist.gov/vuln/detail/CVE-2026-111183"');
    expect(out).toContain("sudo apt update &amp;&amp; sudo apt install --only-upgrade gstreamer1.0-gl gstreamer1.0-plugins-base libgstreamer-plugins-base1.0-0");
    expect(out).toContain("1.20.1-1ubuntu0.7");
    expect(out).toContain("1.20.1-1ubuntu0.8");
  });
  it("keeps other updates and OSV's no-fix-yet list folded away, with Ubuntu's tracker per package", () => {
    const out = render();
    expect(out).toMatch(/<details[^>]*>[\s\S]*Other updates \(2\)/);
    expect(out).toContain("316");
    expect(out).toContain('href="https://ubuntu.com/security/cves?package=mariadb-10.6&amp;version=jammy"');
  });
  it("only the owner sees Scan now; the demo says it doesn't scan", () => {
    expect(render()).toContain("Scan now");
    expect(render({ owner: false })).not.toContain("Scan now");
    expect(render({ demo: true })).toContain("Made-up data: the demo doesn&#x27;t scan.");
  });
  it("a failed scan says so above the last good results", () => {
    const out = render({ initial: { ...DEMO_OS_SCAN, error: "Couldn't list the installed packages (boom).", failedAt: "2026-11-11T04:00:00.000Z" } });
    expect(out).toContain("The last scan failed");
    expect(out).toContain("Couldn&#x27;t list the installed packages (boom).");
    expect(out).toContain("CVE-2026-111183");
  });
  it("not scanned yet: says so and offers the first scan", () => {
    const out = render({ initial: null });
    expect(out).toContain("Not scanned yet");
    expect(out).toContain("Scan now");
  });
  it("a first scan that failed shows the error and no all-clear (review I3)", () => {
    const failed = { ...DEMO_OS_SCAN, status: "error" as const, error: "Couldn't list the installed packages (dpkg-query isn't installed).", packages: 0, kernel: null, updates: [], backlog: { counts: {}, total: 0, error: null } };
    const out = render({ initial: failed });
    expect(out).toContain("The scan failed");
    expect(out).toContain("dpkg-query isn&#x27;t installed");
    expect(out).not.toContain("No security update is waiting");
    expect(out).not.toContain("No fix yet");
  });
  it("an unsupported system says what is supported", () => {
    const out = render({ initial: { ...DEMO_OS_SCAN, status: "unsupported", error: "OS checks run on Ubuntu for now; Debian is next.", updates: [] } });
    expect(out).toContain("OS checks run on Ubuntu for now; Debian is next.");
    expect(out).not.toContain("No security update is waiting");
  });
});
