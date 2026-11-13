import type { Marker } from "./report";

// Watchbell 1.4 App page → Pull requests: what the card shows per open pull request (lib/data/pr-checks-db.ts reads
// it), and the made-up answer demo mode gives. Pure.

export type PrCheckRow = {
  number: number; title: string; url: string | null; draft: boolean;
  // checked: the marker is for the pull request's head commit; old: for an earlier commit; none: no marker comment;
  // unread: the comments couldn't be read (rate limit, timeout), so whether the check ran is unknown.
  state: "checked" | "old" | "none" | "unread"; marker: Marker | null;
};
export type PrChecks = { repo: string; rows: PrCheckRow[]; checkedAt: string };

const counts = (o: Partial<Marker["counts"]> = {}): Marker["counts"] => ({ critical: 0, high: 0, moderate: 0, low: 0, secrets: 0, env: 0, ...o });

export const DEMO_PR_CHECKS: PrChecks = {
  repo: "acme/storefront",
  checkedAt: "2026-11-04T02:00:00.000Z",
  rows: [
    { number: 42, title: "Bump next from 16.4.1 to 16.4.3", url: null, draft: false, state: "checked", marker: { v: 1, sha: "4f2a9c1", verdict: "ok", at: "2026-11-04T01:40:00.000Z", counts: counts() } },
    { number: 41, title: "Add checkout analytics", url: null, draft: false, state: "checked", marker: { v: 1, sha: "9b03e77", verdict: "fix", at: "2026-11-03T22:10:00.000Z", counts: counts({ high: 1, env: 2 }) } },
    { number: 39, title: "Try the new image loader", url: null, draft: true, state: "old", marker: { v: 1, sha: "1c8d0aa", verdict: "check", at: "2026-11-01T09:00:00.000Z", counts: counts({ moderate: 1 }) } },
    { number: 37, title: "Docs: deploy notes", url: null, draft: false, state: "none", marker: null },
  ],
};
