import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appRepos, githubRepos } from "@/db/schema";
import { buildFacts, type BuildFacts, type PM } from "@/lib/buildfiles/facts";
import { type BuildFile, buildFiles } from "@/lib/buildfiles/templates";
import { githubReadToken } from "@/lib/data/deps-db";
import { loadTarget } from "@/lib/data/provider-action-db";
import { LOCKFILES } from "@/lib/deps/lockfile";
import { cleanRootDir, unusableRootDir } from "@/lib/deps/root-dir";
import { parseEnvExample } from "@/lib/env-check/check";
import { fileText } from "@/lib/providers/github";
import type { Result } from "@/lib/providers/http";
import { type EnvName, listEnvNames } from "@/lib/providers/vercel-env";
import { runningVersion } from "@/lib/self-update";

// Watchbell 1.5 Build files (on demand only): the facts of one app — its Vercel project, and package.json, next.config,
// the lockfile and .env.example in its linked repository's Root Directory on the default branch — turned into its
// build files. Nothing is stored. The reads are injected so the tests need no database or network.

const FILE_MAX_BYTES = 256 * 1024;
const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js"];

export type GeneratedFiles = { files: BuildFile[]; facts: BuildFacts; repo: string | null; branch: string | null };

export type BuildFilesDeps = {
  target(appId: string): Promise<{
    name: string; framework: string | null; rootDir: string | null; rootDirUnusable: string | null; token: string; teamId: string; projectId: string;
  } | null>;
  repo(appId: string): Promise<{ fullName: string; branch: string | null } | null>;
  githubToken(): Promise<string | null>;
  file(token: string, fullName: string, path: string, ref: string): Promise<Result<string | null>>;
  envNames(token: string, teamId: string, projectId: string): Promise<Result<EnvName[]>>;
  version(): string | null;
};

const DEFAULT_DEPS: BuildFilesDeps = {
  async target(appId) {
    const t = await loadTarget(appId, "app");
    const meta = t?.resource.meta;
    const teamId = meta?.teamId;
    if (!t || typeof teamId !== "string" || !teamId) return null;
    return {
      name: t.resource.name, framework: typeof meta.framework === "string" ? meta.framework : null,
      rootDir: cleanRootDir(meta.rootDirectory), rootDirUnusable: unusableRootDir(meta.rootDirectory),
      token: t.token, teamId, projectId: t.resource.externalId,
    };
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
  file: (token, fullName, path, ref) => fileText(token, fullName, path, ref, FILE_MAX_BYTES),
  envNames: (token, teamId, projectId) => listEnvNames(token, teamId, projectId),
  version: () => runningVersion(),
};

export async function generateBuildFiles(appId: string, deps: BuildFilesDeps = DEFAULT_DEPS): Promise<{ ok: true; data: GeneratedFiles } | { ok: false; error: string }> {
  const t = await deps.target(appId);
  if (!t) return { ok: false, error: "That app's Vercel project can't be read. Sync Vercel and try again." };
  if (t.rootDirUnusable) return { ok: false, error: "The Vercel Root Directory isn't a folder Watchbell can read." };

  const vercel = await deps.envNames(t.token, t.teamId, t.projectId);
  const envNames = vercel.ok ? vercel.data.filter((n) => n.targets.includes("production")).map((n) => n.key) : null;

  const repo = await deps.repo(appId);
  const token = repo ? await deps.githubToken() : null;
  const prefix = t.rootDir ? `${t.rootDir}/` : "";
  const read = async (path: string): Promise<string | null> => {
    if (!repo || !token) return null;
    const r = await deps.file(token, repo.fullName, prefix + path, repo.branch || "HEAD");
    return r.ok ? r.data : null;
  };
  const first = async <T>(items: readonly T[], path: (x: T) => string): Promise<{ item: T; text: string } | null> => {
    for (const item of items) {
      const text = await read(path(item));
      if (text !== null) return { item, text };
    }
    return null;
  };

  // A lockfile only has to exist: most are larger than the read cap, which answers ok with no text (review I1).
  const exists = async (path: string): Promise<boolean> =>
    !!repo && !!token && (await deps.file(token, repo.fullName, prefix + path, repo.branch || "HEAD")).ok;
  const packageJson = await read("package.json");
  const nextConfig = t.framework === "nextjs" ? (await first(NEXT_CONFIGS, (p) => p))?.text ?? null : null;
  let lock: { item: (typeof LOCKFILES)[number] } | null = null;
  for (const item of LOCKFILES) {
    if (await exists(item.path)) { lock = { item }; break; }
  }
  const example = envNames ? null : await read(".env.example");

  const facts = buildFacts({
    framework: t.framework, rootDir: t.rootDir, lockfile: (lock?.item.kind as PM | undefined) ?? null, packageJson, nextConfig,
    envNames, exampleNames: example !== null ? parseEnvExample(example) : null,
  });
  if (!facts.ok) return facts;
  const branch = repo?.branch ?? null;
  return {
    ok: true,
    data: {
      facts: facts.facts, repo: repo?.fullName ?? null, branch,
      files: buildFiles(facts.facts, { app: t.name, version: deps.version(), repo: repo?.fullName ?? null, branch }),
    },
  };
}
