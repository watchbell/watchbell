import type { Dep } from "@/lib/deps/lockfile";
import { compareVersions } from "@/lib/security/semver";

// Watchbell 1.4 pre-deploy check (runs in GitHub Actions, not in the console): what a pull request changes in the
// lockfile. Only the name@version pairs the base branch doesn't have are asked about; what the base already installs is
// the console's daily scan's job. Pure.

export function addedDeps(base: Dep[] | null, head: Dep[]): Dep[] {
  if (!base) return head;
  const had = new Set(base.map((d) => `${d.name}@${d.version}`));
  return head.filter((d) => !had.has(`${d.name}@${d.version}`));
}

const nextOf = (deps: Dep[] | null): string | null =>
  (deps ?? []).filter((d) => d.name === "next").map((d) => d.version).reduce<string | null>((best, v) => (!best || compareVersions(v, best) > 0 ? v : best), null);

export function nextVersions(base: Dep[] | null, head: Dep[]): { from: string | null; to: string | null } {
  return { from: nextOf(base), to: nextOf(head) };
}
