import type { Commit } from "@/lib/providers/github-browse";

// Watchbell 1.3 What changed: the commits between a production deployment and the one before it. Pure and client-safe.

export type ReleaseNotes = { from: string | null; to: string; commits: Commit[]; total: number; cut: boolean; note: string | null };

// "Fix login (#12)" (a squash merge) or "Merge pull request #7 from a/b" (a merge commit); anything else: no PR.
export function prNumber(title: string): number | null {
  const m = /\(#(\d{1,7})\)\s*$/.exec(title) ?? /^Merge pull request #(\d{1,7})\b/.exec(title);
  return m ? Number(m[1]) : null;
}

// The deployment row offers What changed only for a ready production deployment built from a commit.
export function offersChanges(d: { target: string | null; state: string; commitSha: string | null }): boolean {
  return d.target === "production" && d.state === "ready" && !!d.commitSha;
}

// Demo mode: made-up commits; no provider is called.
export const DEMO_RELEASE_NOTES: ReleaseNotes = {
  from: "4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39", to: "9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a",
  commits: [
    { sha: "9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a", title: "Show the order total in the receipt email (#42)", author: "orbit-dev", at: "2026-10-29T02:40:00Z", url: null },
    { sha: "7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b", title: "Retry the payment webhook once on a timeout", author: "orbit-dev", at: "2026-10-29T01:15:00Z", url: null },
    { sha: "5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d", title: "Bump next from 16.4.2 to 16.4.3 (#41)", author: "orbit-dev", at: "2026-10-28T09:05:00Z", url: null },
  ],
  total: 3, cut: false, note: null,
};
