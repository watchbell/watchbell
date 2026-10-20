import { afterEach, describe, expect, it, vi } from "vitest";
import { resetTimeZoneForTests } from "@/lib/time";
import type { Finding, SecurityRow } from "@/lib/security/types";
import { checkNowText, cveTag, securityBanners, securityNote } from "./security";

const f = (id: string, severity: Finding["severity"], fixed: string | null = null): Finding => ({ id, cve: null, summary: "", severity, fixed });
const row = (over: Partial<SecurityRow>): SecurityRow => ({ version: "15.1.0", status: "ok", findings: [], reason: null, checkedAt: new Date(0), ...over });
const vuln = row({ status: "vulnerable", findings: [f("GHSA-1", "CRITICAL", "15.2.3"), f("GHSA-2", "MODERATE", "15.4.5")] });

describe("securityBanners", () => {
  it("one per vulnerable app: danger for CRITICAL/HIGH, warning otherwise, danger first", () => {
    const b = securityBanners([
      { id: "a1", name: "low-app", gone: false, security: row({ status: "vulnerable", version: "14.2.3", findings: [f("GHSA-9", "LOW", "14.2.24")] }) },
      { id: "a2", name: "nova-wallet", gone: false, security: vuln },
      { id: "a3", name: "clean", gone: false, security: row({}) },
      { id: "a4", name: "never", gone: false, security: null },
    ]);
    expect(b).toEqual([
      { key: "sec-a2", tone: "danger", title: "nova-wallet runs a vulnerable Next.js (15.1.0)", body: "2 known vulnerabilities, worst critical. Fixed in 15.4.5.", action: { label: "Open app", href: "/apps/a2" } },
      { key: "sec-a1", tone: "warning", title: "low-app runs a vulnerable Next.js (14.2.3)", body: "1 known vulnerability, worst low. Fixed in 14.2.24.", action: { label: "Open app", href: "/apps/a1" } },
    ]);
  });
  it("still warns while a failed check keeps the earlier findings, and leaves out a missing fix", () => {
    const [b] = securityBanners([{ id: "a1", name: "x", gone: false, security: row({ status: "error", reason: "OSV.dev answered HTTP 503", findings: [f("GHSA-1", "HIGH")] }) }]);
    expect(b).toMatchObject({ tone: "danger", body: "1 known vulnerability, worst high." });
  });
  it("skips an app that is gone from Vercel", () => {
    expect(securityBanners([{ id: "a1", name: "x", gone: true, security: vuln }])).toEqual([]);
  });
});

describe("cveTag", () => {
  it("is a red CVE tag for CRITICAL/HIGH, amber below, none when clean", () => {
    expect(cveTag(vuln)).toEqual({ label: "CVE", severe: true, title: "Next.js 15.1.0: 2 known vulnerabilities, worst critical" });
    expect(cveTag(row({ status: "vulnerable", findings: [f("GHSA-2", "MODERATE")] }))?.severe).toBe(false);
    expect(cveTag(row({}))).toBeNull();
    expect(cveTag(null)).toBeNull();
  });
});

describe("securityNote", () => {
  it("covers each empty state in the console's words", () => {
    expect(securityNote(null)).toEqual({ state: "unknown", text: "Not checked yet. The daily job checks at 03:00 WIB." });
    expect(securityNote(row({}))).toEqual({ state: "ok", text: "No known vulnerabilities for Next.js 15.1.0." });
    expect(securityNote(row({ status: "unknown", version: null, reason: "not a Next.js site" }))).toEqual({ state: "unknown", text: "Couldn't read the Next.js version: not a Next.js site." });
    expect(securityNote(row({ status: "unknown", reason: "version not exposed", findings: vuln.findings }))).toEqual({
      state: "unknown", text: "Couldn't read the Next.js version: version not exposed. Showing the result from before.",
    });
    expect(securityNote(vuln)).toBeNull();
  });
  it("says a failed check shows the earlier result when there is one", () => {
    expect(securityNote(row({ status: "error", reason: "OSV.dev answered HTTP 503", findings: vuln.findings }))).toEqual({
      state: "warn", text: "The last check failed: OSV.dev answered HTTP 503. Showing the result from before.",
    });
    expect(securityNote(row({ status: "error", version: null, reason: "Couldn't load the site: HTTP 502" }))).toEqual({
      state: "warn", text: "The last check failed: Couldn't load the site: HTTP 502.",
    });
  });
});

describe("checkNowText", () => {
  it("sums up the result for the toast", () => {
    expect(checkNowText("nova-wallet", vuln)).toBe("nova-wallet runs Next.js 15.1.0 with 2 known vulnerabilities.");
    expect(checkNowText("x", row({ version: "16.4.0" }))).toBe("No known vulnerabilities for Next.js 16.4.0.");
    expect(checkNowText("x", row({ status: "unknown", version: null, reason: "version not exposed" }))).toBe("Couldn't read the Next.js version: version not exposed.");
    expect(checkNowText("x", row({ status: "error", reason: "OSV.dev answered HTTP 503" }))).toBe("The check failed: OSV.dev answered HTTP 503.");
  });
});

describe("securityNote in the configured zone (1.1)", () => {
  afterEach(() => {
    resetTimeZoneForTests();
    vi.unstubAllEnvs();
  });
  it("names the zone of the daily job (self-host)", () => {
    vi.stubEnv("WATCHBELL_MODE", "selfhost");
    resetTimeZoneForTests("Europe/Berlin");
    expect(securityNote(null)?.text).toBe("Not checked yet. The daily job checks at 03:00 Europe/Berlin.");
  });
});
