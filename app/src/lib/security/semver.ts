// Just enough semver for npm `next` versions: x.y.z with an optional prerelease. OSV's "introduced: 0" is the start
// of time, and a missing minor or patch counts as 0.

type Parsed = { nums: [number, number, number]; pre: string[] };

function parse(v: string): Parsed {
  const [core, ...rest] = v.trim().split("-");
  const n = core.split(".").map((x) => Number.parseInt(x, 10) || 0);
  return { nums: [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0], pre: rest.length ? rest.join("-").split(".") : [] };
}

function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0; // a prerelease sorts before its release
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const nb = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
    } else if (na !== null || nb !== null) {
      return na !== null ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  return comparePre(pa.pre, pb.pre);
}
