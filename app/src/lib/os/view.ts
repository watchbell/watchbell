import type { OsFact } from "@/lib/alerts/facts";
import type { Severity } from "@/lib/security/types";
import { compareDeb } from "./debver";
import type { KernelState, OsScan, OsUpdate } from "./scan";

// OS vulnerabilities page: the fix commands to copy (never run by Watchbell), which updates count as security ones,
// and what to do about the kernel.

export const fixCommand = (u: Pick<OsUpdate, "binaries">): string =>
  `sudo apt update && sudo apt install --only-upgrade ${[...u.binaries].sort().join(" ")}`;

export function fixAllCommand(updates: Pick<OsUpdate, "binaries">[]): string | null {
  const all = [...new Set(updates.flatMap((u) => u.binaries))].sort();
  return all.length ? `sudo apt update && sudo apt install --only-upgrade ${all.join(" ")}` : null;
}

export function splitUpdates(updates: OsUpdate[]): { security: OsUpdate[]; other: OsUpdate[] } {
  // A lookup that failed counts too: it may hide a security fix (review M4).
  const isSec = (u: OsUpdate) => u.security || u.fixes.length > 0 || u.error !== null;
  return { security: updates.filter(isSec), other: updates.filter((u) => !isSec(u)) };
}

export const scoreSeverity = (s: number | null): Severity =>
  s === null ? "UNKNOWN" : s >= 9 ? "CRITICAL" : s >= 7 ? "HIGH" : s >= 4 ? "MODERATE" : s > 0 ? "LOW" : "UNKNOWN";

export type KernelAdvice = { state: "ok" | "warn"; text: string; command: string | null };

export function kernelAdvice(k: KernelState): KernelAdvice {
  // WSL, a container or a custom kernel: no Ubuntu package runs, so neither apt nor a reboot here changes it (review M5).
  if (k.running && !k.runningVersion && !k.newestInstalled) {
    return { state: "ok", text: `The running kernel (${k.running}) isn't from an Ubuntu package: the host it runs on updates it.`, command: null };
  }
  if (k.newestInstalled && k.runningVersion && compareDeb(k.newestInstalled, k.runningVersion) > 0) {
    return { state: "warn", text: `Kernel ${k.newestInstalled} is installed, but ${k.runningVersion} is still running. Reboot to run it.`, command: "sudo reboot" };
  }
  if (k.update) {
    return { state: "warn", text: `A kernel update is waiting (${k.update.package} ${k.update.candidate}). Install it, then reboot.`, command: "sudo apt update && sudo apt full-upgrade" };
  }
  if (k.reboot.needed) {
    return { state: "warn", text: `An update waits for a reboot${k.reboot.packages.length ? ` (${k.reboot.packages.join(", ")})` : ""}.`, command: "sudo reboot" };
  }
  return { state: "ok", text: "The newest installed kernel is running.", command: null };
}

// The alert's facts from the last scan: security updates whose fixed CVEs have a score (worst CVE first) and a newer
// kernel waiting for a reboot. Only a scan that worked counts; the cloud edition never has one.
export function osFact(s: OsScan | null): OsFact | null {
  if (!s || s.status !== "ok" || !s.system) return null;
  const security = splitUpdates(s.updates).security;
  // A lookup that failed makes the facts partial: the alert fires on what is known but never resolves (review I2).
  const partial = security.some((u) => u.error !== null);
  const updates = security.filter((u) => u.fixes.length).map((u) => {
    const fixes = [...u.fixes].sort((a, b) => (b.cvss3 ?? -1) - (a.cvss3 ?? -1));
    return { source: u.source, score: fixes[0].cvss3, cves: fixes.map((f) => f.cve) };
  });
  const k = s.kernel;
  const kernelWaiting = k?.newestInstalled && k.runningVersion && compareDeb(k.newestInstalled, k.runningVersion) > 0
    ? { installed: k.newestInstalled, running: k.runningVersion } : null;
  return { system: s.system, updates, kernelWaiting, partial };
}
