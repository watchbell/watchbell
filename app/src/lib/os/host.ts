// OS vulnerabilities (owner 12 Nov): pure readers for what the host says about itself. /etc/os-release names the
// system, `dpkg-query` (DPKG_FORMAT) lists the packages, /var/run/reboot-required says whether an update waits for a
// reboot. OSV.dev's Ubuntu and Debian data is per *source* package, so binaries are grouped by source here.

export type OsRelease = { id: string; versionId: string | null; codename: string | null; pretty: string; lts: boolean };

export function parseOsRelease(text: string): OsRelease | null {
  const kv: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  if (!kv.ID) return null;
  const pretty = kv.PRETTY_NAME || [kv.NAME, kv.VERSION].filter(Boolean).join(" ") || kv.ID;
  return {
    id: kv.ID.toLowerCase(),
    versionId: kv.VERSION_ID || null,
    codename: kv.VERSION_CODENAME || kv.UBUNTU_CODENAME || null,
    pretty,
    lts: /\bLTS\b/.test(`${kv.VERSION ?? ""} ${pretty}`),
  };
}

// OSV.dev's ecosystem name: "Ubuntu:22.04:LTS", "Ubuntu:24.10", "Debian:12". Anything else isn't checked (yet).
export function ecosystemFor(r: OsRelease): string | null {
  if (!r.versionId) return null;
  if (r.id === "ubuntu" && /^\d{2}\.\d{2}$/.test(r.versionId)) return `Ubuntu:${r.versionId}${r.lts ? ":LTS" : ""}`;
  if (r.id === "debian" && /^\d+/.test(r.versionId)) return `Debian:${r.versionId.split(".")[0]}`;
  return null;
}

// Tab-separated so names and versions never need quoting; db:Status-Abbrev tells installed ("ii") from removed ("rc").
export const DPKG_FORMAT = "${Package}\t${Version}\t${source:Package}\t${source:Version}\t${db:Status-Abbrev}\n";

export type DpkgPkg = { name: string; version: string; source: string; sourceVersion: string; installed: boolean };

export function parseDpkg(text: string): DpkgPkg[] {
  const out: DpkgPkg[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name, version, source, sourceVersion, status] = line.split("\t");
    if (!name?.trim() || !version?.trim()) continue;
    out.push({
      name: name.trim(), version: version.trim(),
      source: source?.trim() || name.trim(), sourceVersion: sourceVersion?.trim() || version.trim(),
      installed: status === undefined ? true : /^[ih]i/.test(status.trim()),
    });
  }
  return out;
}

export type SourcePkg = { name: string; version: string; binaries: string[]; kernel: boolean };

// The signed kernel image is built from the kernel source: OSV knows it as "linux" ("linux-hwe-6.8" for linux-signed-hwe-6.8).
const osvName = (source: string): string => source.replace(/^linux-signed(-|$)/, "linux$1");
// Meta packages only point at the current kernel; their versions are not kernel versions.
const isMeta = (source: string): boolean => /^linux-meta(-|$)/.test(source);

// One entry per (source, version) of the installed packages. The kernel is checked at the running version only
// (`uname -r`), since older kernels left installed don't run; without the running kernel's package every installed
// kernel version is checked.
export function sourcesToCheck(pkgs: DpkgPkg[], runningKernel: string | null): SourcePkg[] {
  const installed = pkgs.filter((p) => p.installed);
  const image = runningKernel ? installed.find((p) => p.name === `linux-image-${runningKernel}` || p.name === `linux-image-unsigned-${runningKernel}`) : undefined;
  const kernel = image ? { name: osvName(image.source), version: image.sourceVersion } : null;
  const groups = new Map<string, SourcePkg>();
  for (const p of installed) {
    if (isMeta(p.source)) continue;
    const name = osvName(p.source);
    if (kernel && name === kernel.name && p.sourceVersion !== kernel.version) continue;
    const key = `${name}\t${p.sourceVersion}`;
    const g = groups.get(key) ?? { name, version: p.sourceVersion, binaries: [], kernel: kernel ? name === kernel.name : name === "linux" };
    g.binaries.push(p.name);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, binaries: [...new Set(g.binaries)].sort() })).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export type AptUpdate = { name: string; candidate: string; installed: string; pockets: string[]; security: boolean };

// `apt list --upgradable` (read-only, no root): "name/pocket,pocket candidate arch [upgradable from: installed]".
// A pocket ending in -security means Ubuntu shipped it as a security update.
export function parseAptUpgradable(text: string): AptUpdate[] {
  const out: AptUpdate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(line.trim());
    if (!m) continue;
    const pockets = m[2].split(",").filter(Boolean);
    out.push({ name: m[1], candidate: m[3], installed: m[4].trim(), pockets, security: pockets.some((p) => /-security$/.test(p)) });
  }
  return out;
}

export type Reboot = { needed: boolean; packages: string[] };

// /var/run/reboot-required exists while an installed update waits for a reboot; .pkgs names the packages.
export function parseReboot(flag: string | null, pkgs: string | null): Reboot {
  if (flag === null) return { needed: false, packages: [] };
  return { needed: true, packages: [...new Set((pkgs ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean))] };
}
