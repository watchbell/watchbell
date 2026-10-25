import { z } from "zod";
import { type DependabotAlert, parseDependabot } from "@/lib/deps/plan";
import { cleanRootDir } from "@/lib/deps/root-dir";
import { fileText, gh, isFullName, isGitRef, repoPath } from "./github";
import type { FetchOpts, Result } from "./http";

// Stage 9 slice 5: the dependency scan's GitHub reads, with the read-only token (GET only, like lib/providers/github.ts).
// The repository root's file list (names, blob SHAs, sizes: one call tells whether the lockfile changed without
// downloading it), one file's text, and the open Dependabot alerts when the token may read them.

export type RootFile = { name: string; sha: string; size: number };

const listing = z.array(z.object({ name: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() }));

// `dir` (Watchbell 1.2): a folder instead of the root (a Vercel project's Root Directory, already cleaned by
// lib/deps/root-dir.ts cleanRootDir; anything else is refused here too).
export async function rootFiles(token: string, fullName: string, ref: string, opts: FetchOpts = {}, dir: string | null = null): Promise<Result<RootFile[]>> {
  if (!isFullName(fullName) || !isGitRef(ref)) return { ok: false, kind: "format", error: "That isn't a repository name or ref." };
  if (dir !== null && cleanRootDir(dir) !== dir) return { ok: false, kind: "format", error: "That isn't a folder in a repository." };
  const folder = dir ? dir.split("/").map(encodeURIComponent).join("/") : "";
  const r = await gh(`/repos/${repoPath(fullName)}/contents/${folder}?ref=${encodeURIComponent(ref)}`, token, opts);
  if (!r.ok) return r;
  const p = listing.safeParse(r.data);
  if (!p.success) return { ok: false, kind: "format", error: "GitHub answered the file list in a format the console doesn't recognise." };
  return { ok: true, data: p.data.filter((f) => f.type === "file" && /^[0-9a-f]{40}$/.test(f.sha)).map((f) => ({ name: f.name, sha: f.sha, size: f.size ?? 0 })) };
}

// Watchbell 1.2.1: whether a branch exists (the Vercel production branch the scan prefers; lib/deps/branch.ts).
// 404 → false; any other failure is returned, so the caller doesn't guess.
export async function branchExists(token: string, fullName: string, branch: string, opts: FetchOpts = {}): Promise<Result<boolean>> {
  if (!isFullName(fullName) || !isGitRef(branch)) return { ok: false, kind: "format", error: "That isn't a repository name or branch." };
  const r = await gh(`/repos/${repoPath(fullName)}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token, opts);
  if (!r.ok) return r.kind === "missing" ? { ok: true, data: false } : r;
  return { ok: true, data: true };
}

export const LOCKFILE_MAX_BYTES = 15 * 1024 * 1024;

export function repoFile(token: string, fullName: string, path: string, ref: string, maxBytes: number, opts: FetchOpts = {}): Promise<Result<string | null>> {
  return fileText(token, fullName, path, ref, maxBytes, opts);
}

// Open npm Dependabot alerts (at most 100, the worst kept by GitHub's order). A token without "Dependabot alerts: Read"
// gets 403 (or 404 when alerts are off): { denied: true } so the scan notes it and goes on without them.
export async function dependabotAlerts(token: string, fullName: string, opts: FetchOpts = {}): Promise<Result<{ alerts: DependabotAlert[] } | { denied: true }>> {
  if (!isFullName(fullName)) return { ok: false, kind: "format", error: "That isn't a repository name." };
  const r = await gh(`/repos/${repoPath(fullName)}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`, token, opts);
  if (!r.ok) return r.kind === "scope" || r.kind === "missing" ? { ok: true, data: { denied: true } } : r;
  const alerts = parseDependabot(r.data);
  return alerts ? { ok: true, data: { alerts } } : { ok: false, kind: "format", error: "GitHub answered the Dependabot alerts in a format the console doesn't recognise." };
}
