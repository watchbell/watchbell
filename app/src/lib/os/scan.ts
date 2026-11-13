import { compareDeb } from "./debver";
import { DPKG_FORMAT, ecosystemFor, parseAptUpgradable, parseDpkg, parseOsRelease, parseReboot, type Reboot, sourcesToCheck } from "./host";
import { backlogCounts } from "./osv-os";
import { type UbuntuCve, ubuntuFixes } from "./ubuntu";

// OS vulnerabilities (owner 12 Nov, the Ubuntu VM first): one read-only scan of the machine Watchbell runs on.
// What the owner can act on comes from apt (updates waiting, the security pocket) and Ubuntu's security API (the CVEs
// each update fixes, with priority, CVSS score and notice); the kernel is read separately (running vs installed vs
// apt, pending reboot); OSV.dev adds how many advisories have no fix yet. Nothing is installed or changed.

export type HostDeps = {
  platform: NodeJS.Platform;
  readFile(path: string): Promise<string | null>;
  mtime(path: string): Promise<Date | null>;
  exec(cmd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }>;
};

export type OsUpdate = {
  source: string; binaries: string[]; installed: string; candidate: string; pockets: string[]; security: boolean;
  fixes: UbuntuCve[]; error: string | null;
};

export type KernelState = {
  running: string | null; runningVersion: string | null; newestInstalled: string | null; reboot: Reboot;
  update: { package: string; candidate: string } | null;
};

export type OsScan = {
  status: "ok" | "error" | "unsupported";
  system: string | null; ecosystem: string | null; codename: string | null;
  packages: number;
  kernel: KernelState | null;
  updates: OsUpdate[];
  backlog: { counts: Record<string, number>; total: number; error: string | null };
  aptListsAgeHours: number | null;
  scannedAt: string;
  error: string | null;
};

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, negligible: 0 };
export const worstScore = (u: Pick<OsUpdate, "fixes">): number => Math.max(-1, ...u.fixes.map((f) => f.cvss3 ?? -1));
export const worstPriority = (u: Pick<OsUpdate, "fixes">): number => Math.max(-1, ...u.fixes.map((f) => PRIORITY_RANK[f.priority ?? ""] ?? -1));

const UBUNTU_CONCURRENCY = 4;
// The whole scan's budget (review M8): lookups not started by then are marked not checked, so Scan now and the daily
// job end in about a minute even when an API hangs.
export const SCAN_BUDGET_MS = 75_000;
const OUT_OF_TIME = "Not checked: the scan ran out of time.";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const base = (now: Date): OsScan => ({
  status: "ok", system: null, ecosystem: null, codename: null, packages: 0, kernel: null, updates: [],
  backlog: { counts: {}, total: 0, error: null }, aptListsAgeHours: null, scannedAt: now.toISOString(), error: null,
});

const isKernelSource = (s: string): boolean => /^linux(-signed|-meta)?(-|$)/.test(s) && !/^linux-(base|firmware|libc-dev|tools-common)$/.test(s);

export async function scanHost(deps: HostDeps, fetchImpl: typeof fetch, now: Date, opts: { deadline?: number } = {}): Promise<OsScan> {
  const deadline = opts.deadline ?? Date.now() + SCAN_BUDGET_MS;
  const scan = base(now);
  if (deps.platform !== "linux") return { ...scan, status: "unsupported", error: `OS checks run on Ubuntu for now; this machine is ${deps.platform}.` };
  const release = parseOsRelease((await deps.readFile("/etc/os-release")) ?? "");
  if (!release) return { ...scan, status: "unsupported", error: "OS checks run on Ubuntu for now; this system has no /etc/os-release." };
  scan.system = release.pretty;
  if (release.id !== "ubuntu") {
    return { ...scan, status: "unsupported", error: release.id === "debian" ? "OS checks run on Ubuntu for now; Debian is next." : `OS checks run on Ubuntu for now; this system is ${release.pretty}.` };
  }
  const ecosystem = ecosystemFor(release);
  if (!ecosystem || !release.codename) return { ...scan, status: "unsupported", error: `Watchbell can't name this Ubuntu release (${release.pretty}).` };
  scan.ecosystem = ecosystem;
  scan.codename = release.codename;

  const dpkg = await deps.exec("dpkg-query", ["-W", `-f=${DPKG_FORMAT}`]);
  if (!dpkg.ok) return { ...scan, status: "error", error: `Couldn't list the installed packages (${dpkg.error}).` };
  const pkgs = parseDpkg(dpkg.stdout);
  const installed = pkgs.filter((p) => p.installed);
  scan.packages = installed.length;
  const byBinary = new Map(installed.map((p) => [p.name, p]));

  // Kernel: running (uname -r), the newest installed image, and an image waiting in apt.
  const running = (await deps.readFile("/proc/sys/kernel/osrelease"))?.trim() || null;
  const images = installed.filter((p) => /^linux-image-(unsigned-)?\d/.test(p.name));
  const runningImage = running ? images.find((p) => p.name === `linux-image-${running}` || p.name === `linux-image-unsigned-${running}`) : undefined;
  const newest = images.map((p) => p.sourceVersion).sort(compareDeb).at(-1) ?? null;
  const reboot = parseReboot(await deps.readFile("/var/run/reboot-required"), await deps.readFile("/var/run/reboot-required.pkgs"));

  const apt = await deps.exec("apt", ["list", "--upgradable"]);
  // Without apt's list nothing below is known: an error, so the last good scan is kept (review I2).
  if (!apt.ok) return { ...scan, status: "error", error: `Couldn't read the waiting updates (${apt.error}).` };
  const ups = parseAptUpgradable(apt.stdout);
  const kernelUp = ups.find((u) => /^linux-image-/.test(u.name));
  scan.kernel = {
    running, runningVersion: runningImage?.sourceVersion ?? null, newestInstalled: newest, reboot,
    update: kernelUp ? { package: kernelUp.name, candidate: kernelUp.candidate } : null,
  };

  // Updates waiting, grouped by source package; the kernel's are the kernel card's.
  // Ubuntu's data is in source versions; apt's are binary versions. Where a binary's version differs from its
  // source's (dmsetup 2:1.02… from lvm2 2.03…), the two can't be compared, so the update says so (review M2).
  const groups = new Map<string, OsUpdate>();
  const mismatch = new Set<string>();
  for (const u of ups) {
    const p = byBinary.get(u.name);
    const source = p?.source ?? u.name;
    if (isKernelSource(source)) continue;
    if (p && p.version !== p.sourceVersion) mismatch.add(source);
    const g = groups.get(source) ?? { source, binaries: [], installed: u.installed, candidate: u.candidate, pockets: [], security: false, fixes: [], error: null };
    g.binaries.push(u.name);
    if (compareDeb(u.installed, g.installed) < 0) g.installed = u.installed;
    if (compareDeb(u.candidate, g.candidate) > 0) g.candidate = u.candidate;
    g.pockets = [...new Set([...g.pockets, ...u.pockets])];
    g.security ||= u.security;
    groups.set(source, g);
  }
  const ubuntuPocket = new RegExp(`^${escapeRe(release.codename)}(-(updates|security|backports|proposed))?$`);
  const updates = await mapLimit([...groups.values()], UBUNTU_CONCURRENCY, async (g): Promise<OsUpdate> => {
    g.binaries.sort();
    if (!g.pockets.some((p) => ubuntuPocket.test(p))) return g; // a third-party repository: Ubuntu has no data for it
    if (mismatch.has(g.source)) return { ...g, error: `Its package and source versions differ, so Watchbell can't match Ubuntu's fixes; see Ubuntu's page for ${g.source}.` };
    if (Date.now() > deadline) return { ...g, error: OUT_OF_TIME };
    try {
      const r = await ubuntuFixes(g.source, release.codename!, g.installed, g.candidate, fetchImpl);
      return r.ok ? { ...g, fixes: r.fixes } : { ...g, fixes: r.fixes ?? [], error: r.error };
    } catch {
      return { ...g, error: "Ubuntu's security API sent an answer we couldn't read." };
    }
  });
  scan.updates = updates.sort((a, b) => worstScore(b) - worstScore(a) || worstPriority(b) - worstPriority(a)
    || Number(b.security) - Number(a.security) || a.source.localeCompare(b.source));

  // OSV.dev: advisories without a fix it knows of, per installed source. Left out: the kernel (thousands, see the card)
  // and the packages with an update waiting, whose advisories may be fixed by it (review I5).
  const sources = sourcesToCheck(pkgs, running).filter((s) => !s.kernel && !isKernelSource(s.name) && !groups.has(s.name));
  const backlog = Date.now() > deadline ? { ok: false as const, error: OUT_OF_TIME }
    : sources.length ? await backlogCounts(ecosystem, sources.map((s) => ({ name: s.name, version: s.version })), fetchImpl) : { ok: true as const, counts: {} };
  scan.backlog = backlog.ok
    ? { counts: backlog.counts, total: Object.values(backlog.counts).reduce((a, b) => a + b, 0), error: null }
    : { counts: {}, total: 0, error: backlog.error };

  const stamp = await deps.mtime("/var/lib/apt/periodic/update-success-stamp");
  scan.aptListsAgeHours = stamp ? Math.max(0, Math.round((now.getTime() - stamp.getTime()) / 3_600_000)) : null;
  return scan;
}
