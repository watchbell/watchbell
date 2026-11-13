import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseAptUpgradable } from "./host";
import { backlogCounts } from "./osv-os";
import { fixesBetween, parseUbuntuCves, ubuntuCveUrl, ubuntuFixes, usnUrl } from "./ubuntu";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const gst = JSON.parse(fixture("ubuntu-cves-gst-plugins-base1.0-jammy.json"));

describe("parseAptUpgradable", () => {
  const ups = parseAptUpgradable(fixture("jammy-apt-upgradable.txt"));
  it("reads the VM's pending updates and flags the ones from the security pocket", () => {
    expect(ups.find((u) => u.name === "gstreamer1.0-plugins-base")).toEqual({ name: "gstreamer1.0-plugins-base", candidate: "1.20.1-1ubuntu0.8", installed: "1.20.1-1ubuntu0.7", pockets: ["jammy-updates", "jammy-security"], security: true });
    expect(ups.find((u) => u.name === "libglib2.0-0")?.security).toBe(false);
    expect(ups.find((u) => u.name === "caddy")).toMatchObject({ candidate: "2.11.9", installed: "2.11.7", security: false });
    expect(ups.some((u) => u.name.startsWith("Listing"))).toBe(false);
  });
});

describe("Ubuntu Security API (ubuntu.com/security/cves.json)", () => {
  it("reads each CVE's priority, CVSS score, this release's status and fixed version, and its notices", () => {
    const all = parseUbuntuCves(gst, "gst-plugins-base1.0", "jammy")!;
    expect(all.find((c) => c.cve === "CVE-2026-111183")).toMatchObject({ priority: "medium", cvss3: 9.8, status: "released", version: "1.20.1-1ubuntu0.8", usns: ["USN-9038-1"] });
    expect(all.find((c) => c.cve === "CVE-2026-111183")?.summary.length).toBeGreaterThan(10);
  });
  it("keeps the fixes an update brings: released, newer than installed, not newer than apt's candidate", () => {
    const fixes = fixesBetween(parseUbuntuCves(gst, "gst-plugins-base1.0", "jammy")!, "1.20.1-1ubuntu0.7", "1.20.1-1ubuntu0.8");
    expect(fixes.map((f) => f.cve)).toEqual(["CVE-2026-111183"]);
  });
  it("nothing when the update is older than every fix, or nothing is released", () => {
    expect(fixesBetween(parseUbuntuCves(gst, "gst-plugins-base1.0", "jammy")!, "1.20.1-1ubuntu0.8", "1.20.1-1ubuntu0.8")).toEqual([]);
  });
  it("fails closed on an answer that isn't a CVE list", () => {
    expect(parseUbuntuCves({ errors: "Invalid payload" }, "x", "jammy")).toBeNull();
    expect(parseUbuntuCves("<html>503</html>", "x", "jammy")).toBeNull();
  });
  it("links to Ubuntu's CVE page and notice", () => {
    expect(ubuntuCveUrl("CVE-2026-111183")).toBe("https://ubuntu.com/security/CVE-2026-111183");
    expect(usnUrl("USN-9038-1")).toBe("https://ubuntu.com/security/notices/USN-9038-1");
    expect(usnUrl("../x")).toBeNull();
  });
  it("asks for released CVEs one page at a time (≤ 20, newest first) and stops at a short page (review I4)", async () => {
    const fetchImpl = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(gst), { status: 200, headers: { "content-type": "application/json" } }));
    const r = await ubuntuFixes("gst-plugins-base1.0", "jammy", "1.20.1-1ubuntu0.7", "1.20.1-1ubuntu0.8", fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, fixes: [expect.objectContaining({ cve: "CVE-2026-111183" })] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("https://ubuntu.com/security/cves.json?package=gst-plugins-base1.0&version=jammy&status=released&limit=20&offset=0&order=newest");
  });
  it("reads on past a full page of fixes the host already has: an older CVE can be fixed later (review I4)", async () => {
    const old = { ...gst.cves[gst.cves.length - 1], id: "CVE-2020-0001" };
    const page = (i: number) => ({ cves: Array.from({ length: 20 }, (_, k) => ({ ...old, id: `CVE-2020-${String(i * 20 + k + 1).padStart(4, "0")}` })), offset: i * 20, limit: 20, total_results: 41 });
    const late = { cves: [gst.cves.find((c: { id: string }) => c.id === "CVE-2026-111183")], offset: 40, limit: 20, total_results: 41 };
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("offset=40") ? late : page(url.includes("offset=20") ? 1 : 0)), { status: 200 }));
    const r = await ubuntuFixes("gst-plugins-base1.0", "jammy", "1.20.1-1ubuntu0.7", "1.20.1-1ubuntu0.8", f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, fixes: [expect.objectContaining({ cve: "CVE-2026-111183" })] });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("more pages than it reads is an incomplete answer, not a clean one", async () => {
    const full = { cves: Array.from({ length: 20 }, (_, k) => ({ ...gst.cves[0], id: `CVE-2020-${String(k + 1).padStart(4, "0")}` })), offset: 0, limit: 20, total_results: 999 };
    const f = vi.fn(async () => new Response(JSON.stringify(full), { status: 200 }));
    const r = await ubuntuFixes("vim", "jammy", "1", "2", f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, error: "Ubuntu lists more fixed CVEs for this package than Watchbell reads (200); see Ubuntu's page." });
  });
  it("an answer that breaks off is a timeout, not a crash (review M1)", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw new Error("aborted"); } }) as unknown as Response);
    expect(await ubuntuFixes("x", "jammy", "1", "2", f as unknown as typeof fetch)).toEqual({ ok: false, error: "Ubuntu's security API didn't answer in time." });
    expect(await backlogCounts("Ubuntu:22.04:LTS", [{ name: "a", version: "1" }], f as unknown as typeof fetch)).toEqual({ ok: false, error: "OSV.dev didn't answer in time." });
  });
  it("says so when Ubuntu's API doesn't answer", async () => {
    const down = vi.fn(async () => new Response("<html>503</html>", { status: 503 }));
    expect(await ubuntuFixes("x", "jammy", "1", "2", down as unknown as typeof fetch)).toEqual({ ok: false, error: "Ubuntu's security API answered HTTP 503." });
  });
});

describe("backlogCounts (OSV.dev querybatch)", () => {
  it("counts the advisories OSV lists per source in one batch, sending only names and versions", async () => {
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.queries[0]).toEqual({ package: { name: "openssl", ecosystem: "Ubuntu:22.04:LTS" }, version: "3.0.2-0ubuntu1.30" });
      return new Response(JSON.stringify({ results: [{}, { vulns: [{ id: "A" }, { id: "B" }] }] }), { status: 200 });
    });
    const r = await backlogCounts("Ubuntu:22.04:LTS", [{ name: "openssl", version: "3.0.2-0ubuntu1.30" }, { name: "binutils", version: "2.38-4ubuntu2.8" }], fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, counts: { binutils: 2 } });
  });
  it("an unreadable answer is an error, not a clean host", async () => {
    const bad = vi.fn(async () => new Response("{}", { status: 200 }));
    expect((await backlogCounts("Ubuntu:22.04:LTS", [{ name: "a", version: "1" }], bad as unknown as typeof fetch)).ok).toBe(false);
  });
});
