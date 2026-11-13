import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appRepos, githubRepos } from "@/db/schema";
import { githubReadToken } from "@/lib/data/deps-db";
import type { PrCheckRow, PrChecks } from "@/lib/precheck/pr-checks";
import type { Marker } from "@/lib/precheck/report";
import { markerComment, type OpenPull, openPulls } from "@/lib/providers/github-pulls";
import type { Result } from "@/lib/providers/http";

// Watchbell 1.4 App page → Pull requests (on demand only): the linked repository's open pull requests and what the
// pre-deploy check said on each, read from its marker comment. Nothing is stored. The reads are injected so the tests
// need no database or network.

export const PULLS_READ_MAX = 10;

export type { PrCheckRow, PrChecks } from "@/lib/precheck/pr-checks";

export type PrChecksDeps = {
  repo(appId: string): Promise<{ fullName: string } | null>;
  githubToken(): Promise<string | null>;
  pulls(token: string, fullName: string): Promise<Result<OpenPull[]>>;
  marker(token: string, fullName: string, pr: number): Promise<Result<Marker | null>>;
  now(): Date;
};

const DEFAULT_DEPS: PrChecksDeps = {
  async repo(appId) {
    const [row] = await db().select({ fullName: githubRepos.fullName }).from(appRepos)
      .innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).where(eq(appRepos.appId, appId)).limit(1);
    return row ?? null;
  },
  async githubToken() {
    const t = await githubReadToken();
    return "token" in t ? t.token : null;
  },
  pulls: (token, fullName) => openPulls(token, fullName),
  marker: (token, fullName, pr) => markerComment(token, fullName, pr),
  now: () => new Date(),
};

export async function checkPullRequests(appId: string, deps: PrChecksDeps = DEFAULT_DEPS): Promise<{ ok: true; data: PrChecks } | { ok: false; error: string }> {
  const repo = await deps.repo(appId);
  if (!repo) return { ok: false, error: "Link a repository first." };
  const token = await deps.githubToken();
  if (!token) return { ok: false, error: "GitHub isn't connected, or its token can't be read." };
  const pulls = await deps.pulls(token, repo.fullName);
  if (!pulls.ok) return { ok: false, error: pulls.error };
  const rows = await Promise.all(pulls.data.slice(0, PULLS_READ_MAX).map(async (p): Promise<PrCheckRow> => {
    const m = await deps.marker(token, repo.fullName, p.number);
    const marker = m.ok ? m.data : null;
    const state = !m.ok ? "unread" : !marker ? "none" : marker.sha === p.head ? "checked" : "old";
    return { number: p.number, title: p.title, url: p.url, draft: p.draft, state, marker };
  }));
  return { ok: true, data: { repo: repo.fullName, rows, checkedAt: deps.now().toISOString() } };
}
