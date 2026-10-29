import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appRepos, githubRepos } from "@/db/schema";
import { githubReadToken } from "@/lib/data/deps-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import { cleanRootDir, unusableRootDir } from "@/lib/deps/root-dir";
import { type EnvCheck, envFindings, parseEnvExample } from "@/lib/env-check/check";
import { fileText } from "@/lib/providers/github";
import type { Result } from "@/lib/providers/http";
import { type EnvName, listEnvNames } from "@/lib/providers/vercel-env";

export type { EnvCheck } from "@/lib/env-check/check";

// Watchbell 1.3 Env check (on demand only): the app's env names on Vercel against .env.example in its linked
// repository (in the Vercel Root Directory when the app has a usable one), read from the default branch. Nothing is
// stored. The reads are injected so the tests need no database or network.

const EXAMPLE_MAX_BYTES = 64 * 1024;

export type EnvCheckDeps = {
  // rootDirUnusable: a Root Directory set on Vercel that Watchbell can't read as a folder (lib/deps/root-dir).
  target(appId: string): Promise<{ token: string; teamId: string; projectId: string; rootDir: string | null; rootDirUnusable?: string | null } | null>;
  repo(appId: string): Promise<{ fullName: string; branch: string | null } | null>;
  githubToken(): Promise<string | null>;
  envNames(token: string, teamId: string, projectId: string): Promise<Result<EnvName[]>>;
  file(token: string, fullName: string, path: string, ref: string): Promise<Result<string | null>>;
  now(): Date;
};

const DEFAULT_DEPS: EnvCheckDeps = {
  async target(appId) {
    const t = await loadTarget(appId, "app");
    const teamId = t?.resource.meta.teamId;
    if (!t || typeof teamId !== "string" || !teamId) return null;
    const raw = t.resource.meta.rootDirectory;
    return { token: t.token, teamId, projectId: t.resource.externalId, rootDir: cleanRootDir(raw), rootDirUnusable: unusableRootDir(raw) };
  },
  async repo(appId) {
    const [row] = await db().select({ fullName: githubRepos.fullName, branch: githubRepos.defaultBranch }).from(appRepos)
      .innerJoin(githubRepos, eq(githubRepos.id, appRepos.repoId)).where(eq(appRepos.appId, appId)).limit(1);
    return row ?? null;
  },
  async githubToken() {
    const t = await githubReadToken();
    return "token" in t ? t.token : null;
  },
  envNames: (token, teamId, projectId) => listEnvNames(token, teamId, projectId),
  file: (token, fullName, path, ref) => fileText(token, fullName, path, ref, EXAMPLE_MAX_BYTES),
  now: () => new Date(),
};

async function readExample(appId: string, rootDir: string | null, rootDirUnusable: string | null, deps: EnvCheckDeps): Promise<{ example: EnvCheck["example"]; path: string | null; keys: string[] | null }> {
  const repo = await deps.repo(appId);
  if (!repo) return { example: "no-repo", path: null, keys: null };
  // The root .env.example would be the wrong file for an app in a folder Watchbell can't read: no comparison.
  if (rootDirUnusable) return { example: "unreadable", path: `${rootDirUnusable}/.env.example`, keys: null };
  const path = rootDir ? `${rootDir}/.env.example` : ".env.example";
  const token = await deps.githubToken();
  if (!token) return { example: "unreadable", path, keys: null };
  const r = await deps.file(token, repo.fullName, path, repo.branch || "HEAD");
  // GitHub's 404 comes back as a "missing" failure: no .env.example. data null: too large or not text.
  if (!r.ok) return { example: r.kind === "missing" ? "none" : "unreadable", path, keys: null };
  if (r.data === null) return { example: "unreadable", path, keys: null };
  return { example: "found", path, keys: parseEnvExample(r.data) };
}

export async function checkAppEnv(appId: string, deps: EnvCheckDeps = DEFAULT_DEPS): Promise<{ ok: true; data: EnvCheck } | { ok: false; error: string }> {
  const t = await deps.target(appId);
  if (!t) return { ok: false, error: "That app's Vercel project can't be read. Sync Vercel and try again." };
  const names = await deps.envNames(t.token, t.teamId, t.projectId);
  if (!names.ok) return { ok: false, error: `Couldn't read the environment variables: ${names.error}` };
  const ex = await readExample(appId, t.rootDir, t.rootDirUnusable ?? null, deps);
  return { ok: true, data: {
    findings: envFindings(names.data, ex.keys), names: new Set(names.data.map((n) => n.key)).size, example: ex.example, examplePath: ex.path, checkedAt: deps.now().toISOString(),
  } };
}
