import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { resources } from "@/db/schema";
import type { ActionResult } from "@/lib/action";
import { generateBuildFiles, type GeneratedFiles } from "@/lib/data/buildfiles-db";
import { NEED_WRITE_TOKEN, writeAccount } from "@/lib/data/deps-pr";
import { type Actor, finish } from "@/lib/data/provider-action-db";
import { fileText } from "@/lib/providers/github";
import { branchHead, createBranch, createPull, openBuildFilesPull, putNewFile, repoInfo } from "@/lib/providers/github-write";
import type { Result } from "@/lib/providers/http";
import type { ActionOutcome } from "@/lib/provider-actions";

// Watchbell 1.5 Build files → Open pull request (owner only): the generated files on a new watchbell/build-files-…
// branch of the linked repository, with the PR-write token. A file the repository already has is never overwritten:
// it's left out (checked first on the default branch, and putNewFile can't overwrite anyway) and listed as skipped. A
// pull request changes nothing until the owner merges it, so there is no proposal or Telegram approval.

export type BuildFilesPr = { number: number; url: string; skipped: string[] };

export type BuildFilesPrDeps = {
  writeAccount(): Promise<{ id: string; token: string } | null | "unreadable">;
  generate(appId: string): Promise<{ ok: true; data: GeneratedFiles } | { ok: false; error: string }>;
  appName(appId: string): Promise<string>;
  repoInfo(token: string, fullName: string): Promise<Result<{ defaultBranch: string; canPush: boolean | null }>>;
  branchHead(token: string, fullName: string, branch: string): Promise<Result<string | null>>;
  exists(token: string, fullName: string, path: string, ref: string): Promise<boolean>;
  createBranch(token: string, fullName: string, branch: string, fromSha: string, defaultBranch: string): Promise<Result<true>>;
  putNewFile(token: string, fullName: string, branch: string, defaultBranch: string, path: string, text: string, message: string): Promise<Result<"created" | "exists">>;
  createPull(token: string, fullName: string, branch: string, defaultBranch: string, title: string, body: string): Promise<Result<{ number: number; url: string }>>;
  finish(o: ActionOutcome, actor: Actor, accountId: string): Promise<ActionResult>;
  openBuildFilesPull(token: string, fullName: string): Promise<Result<{ number: number; url: string } | null>>;
  random(): string;
};

const DEFAULT_DEPS: BuildFilesPrDeps = {
  writeAccount: () => writeAccount(),
  generate: (appId) => generateBuildFiles(appId),
  async appName(appId) {
    const [r] = await db().select({ name: resources.name }).from(resources).where(eq(resources.id, appId)).limit(1);
    return r?.name ?? "the app";
  },
  repoInfo: (token, fullName) => repoInfo(token, fullName),
  branchHead: (token, fullName, branch) => branchHead(token, fullName, branch),
  // A missing file is GitHub's 404; anything else (a file, or an error) counts as there, so it's never overwritten.
  async exists(token, fullName, path, ref) {
    const r = await fileText(token, fullName, path, ref, 1);
    return !(!r.ok && r.kind === "missing");
  },
  createBranch: (token, fullName, branch, fromSha, defaultBranch) => createBranch(token, fullName, branch, fromSha, defaultBranch),
  putNewFile: (token, fullName, branch, defaultBranch, path, text, message) => putNewFile(token, fullName, branch, defaultBranch, path, text, message),
  createPull: (token, fullName, branch, defaultBranch, title, body) => createPull(token, fullName, branch, defaultBranch, title, body),
  openBuildFilesPull: (token, fullName) => openBuildFilesPull(token, fullName),
  finish: (o, actor, accountId) => finish(o, actor, accountId),
  random: () => randomBytes(4).toString("hex"),
};

const code = (p: string) => `\`${p}\``;

function prBody(files: string[], skipped: string[], guessed: string[], notAdded: string[] = []): string {
  return [
    "Watchbell wrote these files from the app's settings. Review them before merging; nothing is built or deployed by this pull request.",
    "",
    ...files.map((f) => `- ${code(f)}`),
    ...(skipped.length ? ["", `Skipped (already in the repository): ${skipped.map(code).join(", ")}`] : []),
    ...notAdded.map((p) => `
Not added: ${code(p)} — the GitHub PR-write token needs Workflows: Read and write to add it. Copy it from the Build files card instead.`),
    ...(guessed.length ? ["", `Guessed: ${guessed.join(", ")}.`] : []),
    "",
    "Env names only: set their values in `.env` (Docker) or the Kubernetes Secret, never in these files.",
  ].join("\n");
}

export async function openBuildFilesPr(actor: Actor, appId: string, deps: BuildFilesPrDeps = DEFAULT_DEPS): Promise<ActionResult<BuildFilesPr>> {
  const acc = await deps.writeAccount();
  if (!acc) return { ok: false, error: NEED_WRITE_TOKEN };
  if (acc === "unreadable") return { ok: false, error: "The stored GitHub PR-write credential can't be read. Replace it on Connections." };
  const gen = await deps.generate(appId);
  if (!gen.ok) return gen;
  const repo = gen.data.repo;
  if (!repo) return { ok: false, error: "Link a repository first." };
  const app = await deps.appName(appId);
  const failed = (f: Extract<Result<unknown>, { ok: false }>) =>
    deps.finish({ done: false, failed: f, audit: { message: `Build files PR failed · ${app}`, resourceId: appId } }, actor, acc.id);

  const info = await deps.repoInfo(acc.token, repo);
  if (!info.ok) return failed(info);
  const base = info.data.defaultBranch;
  const skipped: string[] = [];
  const todo = [];
  for (const f of gen.data.files) {
    if (await deps.exists(acc.token, repo, f.path, base)) skipped.push(f.path);
    else todo.push(f);
  }
  if (!todo.length) return { ok: false, error: "Every build file already exists in the repository." };

  // One open build-files PR at a time: a second press would put the same files on another branch (M5).
  const open = await deps.openBuildFilesPull(acc.token, repo);
  if (!open.ok) return failed(open);
  if (open.data) return { ok: false, error: `Pull request #${open.data.number} with build files is already open. Merge or close it first.` };
  const head = await deps.branchHead(acc.token, repo, base);
  if (!head.ok) return failed(head);
  if (!head.data) return { ok: false, error: `The default branch ${base} has no commits to start from.` };
  const branch = `watchbell/build-files-${deps.random()}`;
  const made = await deps.createBranch(acc.token, repo, branch, head.data, base);
  // After this point the branch exists: a failure says so, so the owner can clean it up or use it (M5).
  const failedOnBranch = (f: Extract<Result<unknown>, { ok: false }>) =>
    failed({ ...f, error: `${f.error} Branch ${branch} keeps the files written so far; delete it on GitHub, or open a pull request from it.` });
  if (!made.ok) return failed(made);

  const written: string[] = [];
  let noWorkflows = false;
  for (const f of todo) {
    const put = await deps.putNewFile(acc.token, repo, branch, base, f.path, f.text, `Add ${f.path} (Watchbell build files)`);
    // GitHub wants the Workflows permission for files under .github/workflows; without it the other files still go in
    // and the pull request says why the CI file is missing (review C2).
    if (!put.ok && f.path.startsWith(".github/workflows/") && (put.kind === "scope" || put.kind === "missing")) {
      noWorkflows = true;
      skipped.push(f.path);
      continue;
    }
    if (!put.ok) return failedOnBranch(put);
    if (put.data === "exists") skipped.push(f.path);
    else written.push(f.path);
  }
  if (!written.length) return { ok: false, error: "Every build file already exists in the repository." };

  const pr = await deps.createPull(acc.token, repo, branch, base, "Add build files (Watchbell)", prBody(written, skipped.filter((p) => !noWorkflows || !p.startsWith(".github/workflows/")), gen.data.facts.guessed, noWorkflows ? todo.filter((f) => f.path.startsWith(".github/workflows/")).map((f) => f.path) : []));
  if (!pr.ok) return failedOnBranch(pr);
  const done = await deps.finish({
    done: true, message: `Pull request #${pr.data.number} opened.`,
    audit: { message: `Opened build files PR #${pr.data.number} for ${app}`, resourceId: appId },
  }, actor, acc.id);
  return done.ok ? { ...done, data: { number: pr.data.number, url: pr.data.url, skipped } } : done;
}
