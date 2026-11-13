import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { type HostDeps, scanHost } from "./scan";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const gst = fixture("ubuntu-cves-gst-plugins-base1.0-jammy.json");
const NOW = new Date("2026-11-11T09:00:00Z");

const files: Record<string, string> = {
  "/etc/os-release": fixture("jammy-os-release.txt"),
  "/proc/sys/kernel/osrelease": "5.15.0-202-generic\n",
  "/var/run/reboot-required": "*** System restart required ***\n",
  "/var/run/reboot-required.pkgs": fixture("jammy-reboot-required.pkgs"),
};

function deps(over: Partial<HostDeps> = {}): HostDeps {
  return {
    platform: "linux",
    readFile: async (p) => files[p] ?? null,
    mtime: async (p) => (p === "/var/lib/apt/periodic/update-success-stamp" ? new Date("2026-11-11T02:07:31Z") : null),
    exec: async (cmd) => {
      if (cmd === "dpkg-query") return { ok: true, stdout: fixture("jammy-dpkg.txt") };
      if (cmd === "apt") return { ok: true, stdout: fixture("jammy-apt-upgradable.txt") };
      return { ok: false, error: `no ${cmd}` };
    },
    ...over,
  };
}

// Ubuntu's API: the gst-plugins-base1.0 page for that package, an empty list for the others; OSV: one advisory each.
const fetchMock = () => vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.startsWith("https://ubuntu.com/security/cves.json?package=gst-plugins-base1.0&")) return new Response(gst, { status: 200 });
  if (u.startsWith("https://ubuntu.com/security/cves.json")) return new Response(JSON.stringify({ cves: [], offset: 0, limit: 20, total_results: 0 }), { status: 200 });
  if (u === "https://api.osv.dev/v1/querybatch") {
    const n = JSON.parse(String(init?.body)).queries.length;
    return new Response(JSON.stringify({ results: Array.from({ length: n }, (_, i) => (i === 0 ? { vulns: [{ id: "X" }] } : {})) }), { status: 200 });
  }
  return new Response("nope", { status: 404 });
});

describe("scanHost (the Ubuntu VM, 11 Nov)", () => {
  it("names the system, counts packages and reads the kernel and the pending reboot", async () => {
    const s = await scanHost(deps(), fetchMock() as unknown as typeof fetch, NOW);
    expect(s).toMatchObject({ status: "ok", system: "Ubuntu 22.04.5 LTS", ecosystem: "Ubuntu:22.04:LTS", codename: "jammy", error: null });
    expect(s.packages).toBeGreaterThan(40);
    expect(s.kernel).toEqual({
      running: "5.15.0-202-generic", runningVersion: "5.15.0-202.212", newestInstalled: "5.15.0-203.213",
      reboot: { needed: true, packages: ["linux-image-5.15.0-203-generic", "linux-base"] }, update: null,
    });
    expect(s.aptListsAgeHours).toBe(7);
  });
  it("lists each source with an update, the security pocket, and the CVEs Ubuntu says the update fixes", async () => {
    const s = await scanHost(deps(), fetchMock() as unknown as typeof fetch, NOW);
    const base = s.updates.find((u) => u.source === "gst-plugins-base1.0")!;
    expect(base).toMatchObject({ installed: "1.20.1-1ubuntu0.7", candidate: "1.20.1-1ubuntu0.8", security: true, error: null });
    expect(base.binaries).toEqual(expect.arrayContaining(["gstreamer1.0-plugins-base", "gstreamer1.0-gl"]));
    expect(base.fixes.map((f) => [f.cve, f.cvss3, f.usns])).toEqual([["CVE-2026-111183", 9.8, ["USN-9038-1"]]]);
    expect(s.updates[0].source).toBe("gst-plugins-base1.0"); // worst first
    expect(s.updates.find((u) => u.source === "docker-ce")).toMatchObject({ security: false, fixes: [] });
  });
  it("counts OSV's no-fix-yet advisories without the kernel", async () => {
    const f = fetchMock();
    const s = await scanHost(deps(), f as unknown as typeof fetch, NOW);
    expect(s.backlog.error).toBeNull();
    expect(s.backlog.total).toBe(1);
    const batch = f.mock.calls.find((c) => String(c[0]).includes("querybatch"))!;
    expect(JSON.parse(String(batch[1]!.body)).queries.some((q: { package: { name: string } }) => q.package.name === "linux")).toBe(false);
  });
  it("Ubuntu's API down: the updates stay listed, each says the fixes couldn't be read", async () => {
    const down = vi.fn(async (url: string | URL | Request) => (String(url).includes("ubuntu.com") ? new Response("<html>503</html>", { status: 503 }) : new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const s = await scanHost(deps(), down as unknown as typeof fetch, NOW);
    expect(s.status).toBe("ok");
    expect(s.updates.find((u) => u.source === "gst-plugins-base1.0")?.error).toBe("Ubuntu's security API answered HTTP 503.");
  });
  it("only Linux with Ubuntu is checked; anything else says what is supported", async () => {
    expect(await scanHost(deps({ platform: "win32" }), fetchMock() as unknown as typeof fetch, NOW)).toMatchObject({ status: "unsupported", error: "OS checks run on Ubuntu for now; this machine is win32." });
    const debian = deps({ readFile: async (p) => (p === "/etc/os-release" ? 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n' : null) });
    expect(await scanHost(debian, fetchMock() as unknown as typeof fetch, NOW)).toMatchObject({ status: "unsupported", system: "Debian GNU/Linux 12 (bookworm)", error: "OS checks run on Ubuntu for now; Debian is next." });
  });
  it("apt failing is an error, so the last good scan is kept (review I2)", async () => {
    const d = deps({ exec: async (cmd) => (cmd === "dpkg-query" ? { ok: true, stdout: fixture("jammy-dpkg.txt") } : { ok: false, error: "apt isn't installed" }) });
    expect(await scanHost(d, fetchMock() as unknown as typeof fetch, NOW)).toMatchObject({ status: "error", error: "Couldn't read the waiting updates (apt isn't installed)." });
  });
  it("a package whose binary and source versions differ isn't matched to Ubuntu's data, and says so (review M2)", async () => {
    const dpkg = "dmsetup\t2:1.02.175-2.1ubuntu4\tlvm2\t2.03.11-2.1ubuntu4\tii \n";
    const apt = "dmsetup/jammy-updates,jammy-security 2:1.02.175-2.1ubuntu5 amd64 [upgradable from: 2:1.02.175-2.1ubuntu4]\n";
    const f = fetchMock();
    const s = await scanHost(deps({ exec: async (cmd) => ({ ok: true, stdout: cmd === "dpkg-query" ? dpkg : apt }) }), f as unknown as typeof fetch, NOW);
    expect(s.updates.find((u) => u.source === "lvm2")).toMatchObject({ security: true, error: "Its package and source versions differ, so Watchbell can't match Ubuntu's fixes; see Ubuntu's page for lvm2." });
    expect(f.mock.calls.some((c) => String(c[0]).includes("package=lvm2"))).toBe(false);
  });
  it("leaves the packages with a waiting update out of OSV's no-fix-yet count (review I5)", async () => {
    const f = fetchMock();
    await scanHost(deps(), f as unknown as typeof fetch, NOW);
    const batch = f.mock.calls.find((c) => String(c[0]).includes("querybatch"))!;
    const names = JSON.parse(String(batch[1]!.body)).queries.map((q: { package: { name: string } }) => q.package.name);
    expect(names).not.toContain("gst-plugins-base1.0");
    expect(names).toContain("openssl");
  });
  it("past its deadline, the remaining lookups are marked not checked instead of running on (review M8)", async () => {
    const f = fetchMock();
    const s = await scanHost(deps(), f as unknown as typeof fetch, NOW, { deadline: Date.now() - 1 });
    expect(s.updates.find((u) => u.source === "gst-plugins-base1.0")?.error).toBe("Not checked: the scan ran out of time.");
    expect(f.mock.calls.some((c) => String(c[0]).includes("ubuntu.com"))).toBe(false);
  });
  it("one answer that breaks off mid-way fails only that lookup (review M1)", async () => {
    const broken = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("package=gst-plugins-base1.0")) return { ok: true, status: 200, text: async () => { throw new Error("aborted"); } } as unknown as Response;
      return fetchMock()(url, init);
    });
    const s = await scanHost(deps(), broken as unknown as typeof fetch, NOW);
    expect(s.status).toBe("ok");
    expect(s.updates.find((u) => u.source === "gst-plugins-base1.0")?.error).toBe("Ubuntu's security API didn't answer in time.");
  });
  it("dpkg missing or failing is an error, never a clean host", async () => {
    const s = await scanHost(deps({ exec: async () => ({ ok: false, error: "spawn dpkg-query ENOENT" }) }), fetchMock() as unknown as typeof fetch, NOW);
    expect(s).toMatchObject({ status: "error", error: "Couldn't list the installed packages (spawn dpkg-query ENOENT)." });
  });
});
