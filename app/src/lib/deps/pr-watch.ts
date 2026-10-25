// Automatic security fixes: the watcher of Watchbell's own update PRs (owner 16 Oct). Pure. Every 2 minutes, for each
// open Watchbell PR: GitHub's checks → Vercel's preview of the PR's head commit → a smoke test of that preview →
// auto-rollback must be on → squash-merge (with the head SHA the checks were read at). Anything failing stops the PR
// with a reason (it stays open for the owner); nothing finishing within 45 minutes stops it as "butuh dicek".

export const WATCH_EVERY_MS = 2 * 60_000;
export const WATCH_TIMEOUT_MS = 45 * 60_000;
export const SMOKE_TIMEOUT_MS = 15_000;
export const QUIET_MS = 3 * 60_000;
export const SMOKE_PATHS_MAX = 3;

export type PrStage = "checks" | "preview" | "smoke" | "merging" | "merged" | "ready-manual" | "failed" | "timeout" | "closed";
export const OPEN_STAGES: readonly PrStage[] = ["checks", "preview", "smoke", "merging"];

// How the app page and the office say it (≤ 200 with the reason).
export const STAGE_TEXT: Record<PrStage, string> = {
  checks: "waiting for CI", preview: "waiting for preview", smoke: "smoke test", merging: "merging…", merged: "merged ✅",
  "ready-manual": "ready to merge (manual)", failed: "needs a look ⚠️", timeout: "needs a look ⚠️", closed: "closed",
};
export const stageLine = (n: number, stage: PrStage, reason?: string | null): string => {
  const t = `PR #${n}: ${STAGE_TEXT[stage]}${reason ? ` — ${reason}` : ""}`;
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

// ---- GitHub checks ----
export type CheckRun = { status: string; conclusion: string | null };
export type ChecksInput = { checkRuns: CheckRun[] | null; combined: { state: string; total: number } | null; actionRuns: CheckRun[] | null };
export type ChecksVerdict = "success" | "pending" | "failure";

const OK = new Set(["success", "neutral", "skipped"]);
const runVerdict = (r: CheckRun): ChecksVerdict =>
  r.status !== "completed" ? "pending" : OK.has(r.conclusion ?? "") ? "success" : "failure";

// All check runs and commit statuses green (neutral / skipped count as ok). When the token can read neither checks nor
// statuses, the repository's Actions runs for the commit stand in (also when only the check runs are unreadable: a
// fine-grained token can't read them). Nothing to wait for at all → success.
export function checksVerdict(c: ChecksInput): ChecksVerdict {
  const runs = c.checkRuns ?? c.actionRuns ?? [];
  const verdicts = runs.map(runVerdict);
  if (c.combined && c.combined.total > 0) verdicts.push(c.combined.state === "success" ? "success" : c.combined.state === "pending" ? "pending" : "failure");
  if (verdicts.includes("failure")) return "failure";
  return verdicts.includes("pending") ? "pending" : "success";
}

// ---- the smoke test ----
export type HttpProbe = { path: string; status: number | null; ms: number; authWall: boolean };
export type SmokeVerdict = { mode: "http" | "logs"; result: "pass" | "fail" | "wait"; reason: string | null };

// A Vercel Authentication wall: 401 / 403 with Vercel's sign-in page or SSO cookie.
export function isAuthWall(status: number, body: string, headers: { get(name: string): string | null }): boolean {
  if (status !== 401 && status !== 403) return false;
  return /vercel\.com\/(sso|login)|Authentication Required|_vercel_sso|vercel-authentication/i.test(body)
    || /_vercel_sso/i.test(headers.get("set-cookie") ?? "") || (headers.get("server") ?? "").toLowerCase() === "vercel";
}

// HTTP mode: every probe 200–399 within the timeout. A wall on any probe → the logs mode decides instead.
export function httpVerdict(probes: HttpProbe[]): SmokeVerdict | null {
  if (!probes.length || probes.some((p) => p.authWall)) return null;
  const bad = probes.find((p) => p.status === null || p.status < 200 || p.status > 399);
  if (!bad) return { mode: "http", result: "pass", reason: null };
  return { mode: "http", result: "fail", reason: bad.status === null ? `${bad.path} didn't answer within 15 seconds` : `${bad.path} answered ${bad.status}` };
}

// Logs mode (preview behind Vercel Authentication): no error-level lines for 3 minutes after READY.
export function logsVerdict(readyAt: Date, now: Date, errors: number | null): SmokeVerdict {
  if (errors !== null && errors > 0) return { mode: "logs", result: "fail", reason: `${errors} errors in the preview logs` };
  if (now.getTime() - readyAt.getTime() < QUIET_MS || errors === null) return { mode: "logs", result: "wait", reason: null };
  return { mode: "logs", result: "pass", reason: null };
}

// ---- one watch step ----
export type WatchInput = {
  now: Date; openedAt: Date;
  // base / recordedBase (Watchbell 1.2.1): the PR's base on GitHub and the one Watchbell opened it against (the app's
  // production branch, else the default). GitHub retargets a PR whose base branch was deleted; it is then never merged.
  pr: { state: "open" | "closed"; merged: boolean; mergeable: boolean | null; headSha: string; base?: string };
  recordedSha: string;
  recordedBase?: string;
  checks: ChecksVerdict;
  preview: { state: "ready" | "building" | "error" | "canceled" | null; readyAt: Date | null };
  smoke: SmokeVerdict | null; // null until the preview is ready
  autoRollbackOn: boolean;
};

export type WatchStep =
  | { kind: "wait"; stage: PrStage; reason: string | null; resetSha?: string }
  | { kind: "merge" }
  | { kind: "stop"; stage: "failed" | "timeout" | "ready-manual"; reason: string }
  | { kind: "done"; stage: "merged" | "closed" };

export function watchStep(w: WatchInput): WatchStep {
  if (w.pr.merged) return { kind: "done", stage: "merged" };
  if (w.pr.state === "closed") return { kind: "done", stage: "closed" };
  if (w.pr.base !== undefined && w.recordedBase !== undefined && w.pr.base !== w.recordedBase) {
    return { kind: "stop", stage: "failed", reason: `the PR's base changed to ${w.pr.base}` };
  }
  // Someone pushed to the branch (often the lockfile the PR body asks for): the checks start again on the new commit.
  if (w.pr.headSha !== w.recordedSha) return { kind: "wait", stage: "checks", reason: "new commit on the PR branch, checking again", resetSha: w.pr.headSha };
  const late = w.now.getTime() - w.openedAt.getTime() > WATCH_TIMEOUT_MS;
  if (w.checks === "failure") return { kind: "stop", stage: "failed", reason: "CI failed" };
  if (w.pr.mergeable === false) return { kind: "stop", stage: "failed", reason: "conflicts with the main branch" };
  if (w.preview.state === "error" || w.preview.state === "canceled") return { kind: "stop", stage: "failed", reason: "Vercel preview failed" };
  if (w.checks === "pending" || w.pr.mergeable === null) {
    return late ? { kind: "stop", stage: "timeout", reason: "CI not finished within 45 minutes" } : { kind: "wait", stage: "checks", reason: null };
  }
  if (w.preview.state !== "ready") {
    return late ? { kind: "stop", stage: "timeout", reason: "preview not ready within 45 minutes" } : { kind: "wait", stage: "preview", reason: null };
  }
  if (!w.smoke || w.smoke.result === "wait") {
    return late ? { kind: "stop", stage: "timeout", reason: "preview smoke test not finished within 45 minutes" } : { kind: "wait", stage: "smoke", reason: null };
  }
  if (w.smoke.result === "fail") return { kind: "stop", stage: "failed", reason: `preview smoke test failed: ${w.smoke.reason ?? "?"}` };
  if (!w.autoRollbackOn) return { kind: "stop", stage: "ready-manual", reason: "PR is ready to merge, but auto-rollback is off; merge it manually" };
  return { kind: "merge" };
}

// ---- the auto-merge allow-list (Watchbell 1.2.1, audit M1) ----
// Before the merge: the PR changes nothing but the bumped package.json (in the app's folder) and its lockfile, and every
// commit on the branch is the PR-write token's own (the package.json commit, the VM runner's lockfile commit) or the
// GitHub Actions lockfile commit (actions-lockfile.ts WORKFLOW_YAML: its author and message), which may touch only the
// lockfile. Anything else stops the PR with "needs a look" and leaves it open for the owner.
// Limit (review I4, round 2): `login` is GitHub's mapping of the commit's author email, which anyone who can push to the
// branch can set, and whether GitHub signs (verification.verified) commits a fine-grained PAT makes through the
// Contents API wasn't confirmed, so it isn't required. So the content is checked, whoever wrote it, at the base and at
// the head the checks were read at: package.json may change only in the bumped versions (manifestChangeProblem), and
// every new or changed package-lock.json entry must be a registry tarball of the base lockfile's registry with a sha512
// integrity (lockfileChangeProblem; other lockfile kinds aren't merged automatically). Not covered until L2 (1.2.2): that
// an entry's integrity and dependencies are the ones the registry publishes for that version, so a forged lockfile can
// still add a package that really is on the registry (an attacker's own, say) as a new dependency of the bumped one.
export const LOCKFILE_BOT = { name: "watchbell[bot]", email: "watchbell-bot@users.noreply.github.com", message: "chore(deps): update package-lock.json (Watchbell)" } as const;
// The workflow template from before the rename (Watchpost) still runs in repositories set up then; its lockfile commits
// are the same job under the old name (seen live 24 Oct: an update PR stopped on "unexpected commit … by watchpost[bot]").
export const LEGACY_LOCKFILE_BOT = { name: "watchpost[bot]", email: "watchpost-bot@users.noreply.github.com", message: "chore(deps): update package-lock.json (Watchpost)" } as const;
export const MAX_REVIEW_COMMITS = 20;

export type PrFile = { filename: string; previous?: string | null };
// files: the commit's changed files, read only for commits that aren't the token user's (null = not read).
export type PrCommit = { sha: string; login: string | null; name: string; email: string; message: string; files: string[] | null };
// lockfileRequired (owner, review round 1): the scan recorded a lockfile for that folder, so the merge waits for it.
// manifestProblem: manifestChangeProblem() of package.json at the base and the head (review I4).
// lockfileProblem: lockfileChangeProblem() of the lockfile at the base and the head when the PR changes it (review
// T2b-fix I-1).
export type MergeReview = {
  manifest: string; lockfile: string | null; lockfileRequired?: boolean; manifestProblem?: string | null; lockfileProblem?: string | null;
  headSha?: string; tokenLogin: string | null; files: PrFile[]; commits: PrCommit[];
};

// The lockfile the PR must change isn't in it yet: the watcher waits (the lockfile commit moves the head), never merges.
export const lockfileMissing = (r: MergeReview): boolean =>
  !!r.lockfileRequired && !!r.lockfile && !r.files.some((f) => f.filename === r.lockfile);

const isLockfileBot = (c: PrCommit): boolean =>
  [LOCKFILE_BOT, LEGACY_LOCKFILE_BOT].some((b) => c.name === b.name && c.email.toLowerCase() === b.email && c.message.trim() === b.message);

// Review I4: package.json at the PR's base and head may differ only in the version strings of the bumped packages
// (dependencies / devDependencies), each a plain semver range; scripts, overrides, other dependencies and everything
// else must be identical. Null when that holds, else the reason.
const PLAIN_RANGE = /^[\^~]?[0-9][0-9A-Za-z.+-]*$/;
export function manifestChangeProblem(baseText: string, headText: string, packages: string[]): string | null {
  let base: Record<string, unknown>;
  let head: Record<string, unknown>;
  try {
    base = JSON.parse(baseText);
    head = JSON.parse(headText);
  } catch {
    return "unexpected change: package.json isn't valid JSON";
  }
  if (!base || !head || typeof base !== "object" || typeof head !== "object") return "unexpected change: package.json isn't an object";
  const strip = (m: Record<string, unknown>) => {
    const c = structuredClone(m) as Record<string, Record<string, unknown> | unknown>;
    for (const k of ["dependencies", "devDependencies"]) {
      const deps = c[k];
      if (deps && typeof deps === "object") for (const p of packages) delete (deps as Record<string, unknown>)[p];
    }
    return c;
  };
  if (JSON.stringify(sortKeys(strip(base))) !== JSON.stringify(sortKeys(strip(head)))) return "unexpected change in package.json beyond the bumped versions";
  for (const k of ["dependencies", "devDependencies"]) {
    const b = (base[k] ?? {}) as Record<string, unknown>;
    const h = (head[k] ?? {}) as Record<string, unknown>;
    for (const p of packages) {
      if ((p in b) !== (p in h)) return `unexpected change in package.json: ${p} added or removed`;
      if (p in h && h[p] !== b[p] && (typeof h[p] !== "string" || !PLAIN_RANGE.test(h[p] as string))) return `unexpected change in package.json: ${p} isn't a plain version`;
    }
  }
  return null;
}
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;

// Review T2b-fix I-1: package-lock.json at the PR's base and head (null: not there). Null when every new or changed
// entry of `packages` is something npm fetches from the base lockfile's registry, else the reason. A node_modules entry
// must resolve to exactly <registry>/<name>/-/<file>-<version>.tgz (a registry the base lockfile already uses, by
// default npm's; the name is the entry's own folder, so no new alias to another package), with a strict semver version
// and a sha512 integrity; never a link, git+, file:, github: or http: source. An entry whose version didn't change may
// change only in its dev / optional / peer flags. The root entry and workspace folders (keys outside node_modules) may
// change their dependency lists but never gain a source, and no new folder may appear. The lockfileVersion must stay,
// and be 2 or 3.
// npm 7+ reads only `packages`, so the old `dependencies` tree isn't checked; a lockfile without `packages` is refused.
const NPM_REGISTRY = "https://registry.npmjs.org";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PKG = "(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*";
const NM_KEY = new RegExp(`^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*/)*?node_modules/${PKG}(?:/node_modules/${PKG})*$`, "i");
const FLAGS = new Set(["dev", "optional", "devOptional", "peer"]);
type Lockfile = { lockfileVersion?: unknown; packages: Record<string, unknown> };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keyName = (key: string) => key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
const tarball = (registry: string, name: string, version: string) => `${registry}/${name}/-/${name.split("/").pop()}-${version}.tgz`;
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const withoutFlags = (e: Record<string, unknown>) => Object.fromEntries(Object.entries(e).filter(([k]) => !FLAGS.has(k)));
const readLockfile = (t: string): Lockfile | null => {
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) && isObj(v.packages) ? (v as Lockfile) : null;
  } catch {
    return null;
  }
};

// Review T2b-fix3 m-3: a lockfile over 25 MB (UTF-8 bytes) isn't parsed, and anything the check can't get through
// (a value nested too deep to compare, say) is a refusal too, so such a PR stops for a look instead of being re-read
// every round as "GitHub couldn't be read".
export const MAX_LOCKFILE_BYTES = 25 * 1024 * 1024;
const tooLarge = (t: string): boolean => {
  // A UTF-16 unit is 1 to 3 bytes (a surrogate pair 4 for two), so only the middle range needs counting.
  if (t.length > MAX_LOCKFILE_BYTES) return true;
  if (t.length * 3 <= MAX_LOCKFILE_BYTES) return false;
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && (t.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4; // a surrogate pair
      i++;
    } else n += 3;
  }
  return n > MAX_LOCKFILE_BYTES;
};

export function lockfileChangeProblem(baseText: string | null, headText: string | null, path: string): string | null {
  if ([baseText, headText].some((t) => t !== null && tooLarge(t))) return `lockfile too large to check (over 25 MB): ${path}`.slice(0, 150);
  try {
    return lockfileProblemOf(baseText, headText, path);
  } catch {
    return `unexpected lockfile change ${path} (couldn't be checked)`.slice(0, 150);
  }
}

function lockfileProblemOf(baseText: string | null, headText: string | null, path: string): string | null {
  const refuse = (what: string) => `unexpected lockfile change ${what}`.slice(0, 150);
  const head = headText === null ? null : readLockfile(headText);
  const base = baseText === null ? { packages: {} } : readLockfile(baseText);
  if (!head || !base) return refuse(path);
  // 2 or 3 always (review T2b-fix3 m-2): npm 6 would install a v1 lockfile from its unchecked `dependencies` tree.
  if ((head.lockfileVersion !== 2 && head.lockfileVersion !== 3) || (baseText !== null && head.lockfileVersion !== base.lockfileVersion)) {
    return refuse("lockfileVersion");
  }
  // The registries the base lockfile fetches from: each entry's resolved minus /<name>/-/<file>-<version>.tgz.
  const registries = new Set<string>();
  for (const [key, e] of Object.entries(base.packages)) {
    if (!NM_KEY.test(key) || !isObj(e) || typeof e.resolved !== "string" || typeof e.version !== "string") continue;
    const tail = tarball("", typeof e.name === "string" ? e.name : keyName(key), e.version);
    if (e.resolved.startsWith("https://") && e.resolved.endsWith(tail)) registries.add(e.resolved.slice(0, -tail.length));
  }
  if (!registries.size) registries.add(NPM_REGISTRY);

  for (const [key, e] of Object.entries(head.packages)) {
    // Own keys only (review T2b-fix3 m-1): base.packages["__proto__"] would be Object.prototype.
    const was = Object.hasOwn(base.packages, key) ? base.packages[key] : undefined;
    if (was !== undefined && same(was, e)) continue;
    const before = isObj(was) ? was : null;
    if (key === "" || !key.includes("node_modules/")) {
      // The root package or a workspace folder: installed from the repository itself, never fetched.
      const label = key === "" ? (isObj(e) && typeof e.name === "string" ? e.name : path) : key;
      if (!isObj(e) || (key !== "" && !before) || "resolved" in e || "link" in e) return refuse(label);
      continue;
    }
    if (!NM_KEY.test(key) || !isObj(e)) return refuse(NM_KEY.test(key) ? keyName(key) : key);
    const name = keyName(key);
    // An alias the base already had (npm:other@x) keeps its name; a new one is refused.
    if (e.name !== undefined && e.name !== name && (!before || before.name !== e.name)) return refuse(name);
    const real = typeof e.name === "string" ? e.name : name;
    const version = e.version;
    if (e.link !== undefined || typeof version !== "string" || !SEMVER.test(version)) return refuse(name);
    if (typeof e.integrity !== "string" || !SHA512.test(e.integrity)) return refuse(name);
    if (typeof e.resolved !== "string" || ![...registries].some((r) => e.resolved === tarball(r, real, version))) return refuse(name);
    if (before && before.version === version && !same(withoutFlags(before), withoutFlags(e))) return refuse(name);
  }
  return null;
}

// Null when the merge may go ahead, else the reason (≤ 150 chars).
export function unexpectedChange(r: MergeReview): string | null {
  const allowed = new Set([r.manifest, ...(r.lockfile ? [r.lockfile] : [])]);
  for (const f of r.files) {
    for (const name of [f.filename, f.previous]) if (name && !allowed.has(name)) return `unexpected change in ${name}`.slice(0, 150);
  }
  if (!r.files.some((f) => f.filename === r.manifest)) return `unexpected change: ${r.manifest} isn't changed`.slice(0, 150);
  if (r.manifestProblem) return r.manifestProblem.slice(0, 150);
  if (r.lockfileProblem) return r.lockfileProblem.slice(0, 150);
  if (!r.tokenLogin || !r.commits.length || r.commits.length > MAX_REVIEW_COMMITS) return "couldn't confirm who wrote the PR's commits";
  // Review m3: the commits read must end at the head the checks were read at.
  if (r.headSha && r.commits[r.commits.length - 1].sha !== r.headSha) return "the PR's head moved while it was checked";
  for (const c of r.commits) {
    if (c.login !== null && c.login.toLowerCase() === r.tokenLogin.toLowerCase()) continue;
    const short = c.sha.slice(0, 7);
    if (!isLockfileBot(c) || !c.files || !r.lockfile) return `unexpected commit ${short} by ${c.login ?? c.name}`.slice(0, 150);
    const other = c.files.find((f) => f !== r.lockfile);
    if (other) return `unexpected change in ${other} by commit ${short}`.slice(0, 150);
  }
  return null;
}

// Every 2 minutes per server instance (a module memo), and on a cold instance only on even minutes.
export function watchDue(now: Date, last: number | null): boolean {
  const t = now.getTime();
  if (last !== null && t - last < WATCH_EVERY_MS - 20_000) return false;
  return Math.floor(t / 60_000) % 2 === 0 || (last !== null && t - last >= WATCH_EVERY_MS * 2);
}

// The app's paths to probe on the preview: "/" and up to 3 HTTP monitor paths (no query strings, no duplicates).
export function smokePaths(monitorUrls: string[]): string[] {
  const out = ["/"];
  for (const u of monitorUrls) {
    let p: string;
    try {
      p = new URL(u).pathname || "/";
    } catch {
      continue;
    }
    if (!out.includes(p) && out.length < SMOKE_PATHS_MAX + 1) out.push(p);
  }
  return out;
}
