import { z } from "zod";
import { parseMarker } from "@/lib/precheck/marker";
import type { Marker } from "@/lib/precheck/report";
import { gh, isFullName, repoPath } from "./github";
import type { Failure, FetchOpts, Result } from "./http";

// Watchbell 1.4: the open pull requests of a linked repository and the pre-deploy check's comment on each, read with
// the read-only token when the owner asks (App page → Pull requests). GET only; only display fields are kept.

const fmt = (what: string): Failure => ({ ok: false, kind: "format", error: `GitHub answered ${what} in a format the console doesn't recognise.` });
const bad: Failure = { ok: false, kind: "format", error: "That isn't a repository or pull request." };
const BOT = "github-actions[bot]";

export type OpenPull = { number: number; title: string; head: string; url: string | null; draft: boolean };

export async function openPulls(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<OpenPull[]>> {
  if (!isFullName(fullName)) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/pulls?state=open&per_page=20&sort=created&direction=desc`, token, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({
    number: z.number().int().positive(), title: z.string().nullish(), draft: z.boolean().nullish(), html_url: z.string().nullish(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  })).safeParse(r.data);
  if (!p.success) return fmt("the pull requests");
  return {
    ok: true,
    data: p.data.map((x) => ({
      number: x.number, title: (x.title ?? "").slice(0, 200), head: x.head.sha, draft: x.draft ?? false,
      url: x.html_url?.startsWith("https://github.com/") ? x.html_url : null,
    })),
  };
}

// The newest valid marker the Actions bot wrote among a pull request's first 100 comments (the check writes its comment
// on the first run and edits it after, so it is early in the list). Null: the check hasn't commented.
export async function markerComment(token: string, fullName: string, pr: number, opts: FetchOpts = {}): Promise<Result<Marker | null>> {
  if (!isFullName(fullName) || !Number.isInteger(pr) || pr < 1) return bad;
  const r = await gh(`/repos/${repoPath(fullName)}/issues/${pr}/comments?per_page=100`, token, opts);
  if (!r.ok) return r;
  const p = z.array(z.object({ body: z.string().nullish(), user: z.object({ login: z.string() }).nullish() })).safeParse(r.data);
  if (!p.success) return fmt("the pull request comments");
  let found: Marker | null = null;
  for (const c of p.data) {
    if (c.user?.login !== BOT || !c.body) continue;
    found = parseMarker(c.body) ?? found;
  }
  return { ok: true, data: found };
}
