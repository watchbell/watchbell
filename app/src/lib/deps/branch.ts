import { isGitRef } from "@/lib/providers/github";

// Watchbell 1.2.1 (owner 24 Oct): the branch Vercel deploys to production (resources.meta.productionBranch, written by
// the account sync) is what is live. The dependency scan reads it and the update PR targets it, when the repository has
// that branch (asked of GitHub by the caller); otherwise both use the repository's default branch. shopfront is
// live from web-revamp while main is stale. Pure.

// The production branch worth asking about: a plain branch name that isn't the default branch; else null.
export function productionCandidate(productionBranch: unknown, defaultBranch: string | null): string | null {
  return typeof productionBranch === "string" && productionBranch !== defaultBranch && isGitRef(productionBranch) ? productionBranch : null;
}

// ---- Watchbell 1.2.2 (D15, incident 25 Oct) ----
// The project's production branch says what Vercel builds on a push, not what production was really built from:
// production had been deployed by the CLI from web-revamp while the production branch was main. The update PR went to
// main, the owner merged it, and Vercel deployed stale main to production. So the collector records the current
// production deployment's source with the time it last read it (resources.meta.productionSource,
// lib/data/production-source-db.ts). The scan and the update PR use the Git branch production was built from when the
// repository has it. Otherwise (a CLI deploy, a branch the repository doesn't have, or a reading too old to trust) the
// PR never opens or merges on its own, and an approved one opens as a draft with the warning on top.

// id (fix round 3): the deployment the reading is of, so a later run that can't see that deployment's meta keeps its kind.
export type ProductionSource = { kind: "git" | "cli"; ref?: string; sha?: string; at?: string; id?: string };

// A reading older than this can't confirm anything (the Vercel task is paused with Hosting, backs off, or can't read the
// account): treated as "can't confirm". The collector renews `at` every PRODUCTION_SOURCE_REFRESH_MS.
export const PRODUCTION_SOURCE_MAX_AGE_MS = 30 * 60_000;
export const PRODUCTION_SOURCE_REFRESH_MS = 10 * 60_000;

const SHA = /^[0-9a-f]{7,40}$/i;

// A deployment's source: Vercel's `source` ("cli", "git", "redeploy", …) and its Git branch and commit
// (lib/providers/vercel.ts toDeployment: GitHub, GitLab, Bitbucket, the CLI's git metadata, gitSource). A CLI deploy is
// "cli" (the branch the CLI ran on is kept for the page, never trusted); a Git branch is "git"; neither: null (unknown,
// nothing recorded, so an older reading ages into "can't confirm").
// Fix round 3 (re-review r2 I1): a redeploy or promote of a CLI deployment has another `source` but still only the CLI's
// git metadata (branchFrom "cli", lib/providers/vercel.ts): a CLI deploy too, unless Vercel itself says "git". A dirty
// working tree (gitDirty) is a CLI deploy whatever the source says.
export function productionSourceOf(d: { source: string | null; branch: string | null; sha: string | null; branchFrom?: string | null; gitDirty?: boolean }): ProductionSource | null {
  const ref = d.branch && isGitRef(d.branch) ? d.branch : null;
  const sha = d.sha && SHA.test(d.sha) ? d.sha : null;
  const cli = d.source === "cli" || d.gitDirty === true || (d.branchFrom === "cli" && d.source !== "git");
  if (cli) return { kind: "cli", ...(ref ? { ref } : {}), ...(ref && sha ? { sha } : {}) };
  return ref ? { kind: "git", ref, ...(sha ? { sha } : {}) } : null;
}

// A stored value (resources.meta.productionSource) → the source, or null when absent or not one.
export function readProductionSource(v: unknown): ProductionSource | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const ref = typeof o.ref === "string" && isGitRef(o.ref) ? o.ref : null;
  if (typeof o.ref === "string" && !ref) return null;
  const sha = typeof o.sha === "string" && SHA.test(o.sha) ? o.sha : null;
  const at = typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? o.at : null;
  const id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(o.id) ? o.id : null;
  const rest = { ...(sha ? { sha } : {}), ...(at ? { at } : {}), ...(id ? { id } : {}) };
  if (o.kind === "git" && ref) return { kind: "git", ref, ...rest };
  if (o.kind === "cli") return { kind: "cli", ...(ref ? { ref } : {}), ...rest };
  return null;
}

// Same deployment source (the reading time aside).
export const sameProductionSource = (a: ProductionSource | null, b: ProductionSource | null): boolean =>
  (a?.kind ?? null) === (b?.kind ?? null) && (a?.ref ?? null) === (b?.ref ?? null) && (a?.sha ?? null) === (b?.sha ?? null) &&
  (a?.id ?? null) === (b?.id ?? null);

// A reading without a time, or older than PRODUCTION_SOURCE_MAX_AGE_MS.
export const isStaleSource = (s: ProductionSource, now: Date): boolean =>
  !s.at || now.getTime() - Date.parse(s.at) > PRODUCTION_SOURCE_MAX_AGE_MS;

// The stored source survives a Sync's meta rewrite (discovery doesn't read deployments); the collector renews it.
export function keepProductionSource(old: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = readProductionSource(old?.productionSource);
  return s ? { productionSource: s } : {};
}

// The app page's "Production built from".
export function productionSourceText(s: ProductionSource): string {
  if (s.kind === "git") return `${s.ref} (git)`;
  return s.ref ? `CLI deploy (from ${s.ref})` : "CLI deploy";
}

// The branches prBase (lib/data/deps-pr.ts) tries for the update PR's base, in order; the first the repository has is the
// base (the default branch always exists, so nothing after it is listed): the Git branch production was built from, the
// project's production branch, the default branch.
export function baseCandidates(meta: Record<string, unknown> | null, defaultBranch: string): string[] {
  const s = readProductionSource(meta?.productionSource);
  const out: string[] = [];
  for (const b of [s?.kind === "git" ? s.ref : null, meta?.productionBranch, defaultBranch]) {
    if (typeof b !== "string" || !isGitRef(b) || out.includes(b)) continue;
    out.push(b);
    if (b === defaultBranch) break;
  }
  return out;
}

// The base prBase picks when the first candidate exists (before GitHub is asked): what the auto-run's first check and the
// app page compare with. Null: nothing known.
export function expectedBase(meta: Record<string, unknown> | null, defaultBranch: string | null): string | null {
  const s = readProductionSource(meta?.productionSource);
  if (s?.kind === "git") return s.ref!;
  return productionCandidate(meta?.productionBranch, defaultBranch) ?? defaultBranch ?? (typeof meta?.productionBranch === "string" && isGitRef(meta.productionBranch) ? meta.productionBranch : null);
}

// Why an update PR into `base` must not open or merge on its own, as one sentence that says what merging would do
// (null: production was built from that base, confirmed in the last 30 minutes; or no reading was ever recorded, which
// keeps the behaviour before 1.2.2). A base that isn't known yet only counts against a CLI deploy or an old reading.
export function productionMismatch(stored: unknown, base: string | null, now: Date): string | null {
  const s = readProductionSource(stored);
  if (!s) return null;
  const target = base ?? "a stale branch";
  if (isStaleSource(s, now)) {
    return `Watchbell can't confirm what production is built from (no reading in the last 30 minutes). Merging this PR could deploy ${target} to production and replace what is live.`;
  }
  if (s.kind === "cli") return `Production was deployed from the CLI${base ? `, not built from ${base}` : ""}. Merging this PR would deploy ${target} to production and replace what is live.`;
  if (base && s.ref !== base) return `Production was built from ${s.ref}, not ${base}. Merging this PR would deploy ${base} to production and replace what is live.`;
  return null;
}

// The app page's line next to "Production branch": the text, and the warning the gates would give, against the base they
// use (expectedBase; the page doesn't know the default branch, so the production branch stands in). Null until the
// collector has read the source.
export function productionSourceLine(stored: unknown, productionBranch: string | null, now: Date): { text: string; warning: string | null } | null {
  const s = readProductionSource(stored);
  if (!s) return null;
  const why = productionMismatch(stored, expectedBase({ productionSource: stored, productionBranch }, null), now);
  return { text: productionSourceText(s), warning: why ? `${why} Update PRs open as drafts for your approval and are never merged automatically.` : null };
}

// The branch the stored scan read (D15 fix round 2), from its key (ops.dependency_scans.lockfile_sha, deps-db.ts
// scanRepo): "br:<branch>:…" for a production branch, any other key for the default branch; null when unknown (no scan,
// or a Root Directory named "br", whose key can't be told apart). No migration: the key already says it.
export function scannedBranch(lockfileSha: string | null | undefined, defaultBranch: string, dir: string | null = null): string | null {
  if (!lockfileSha) return null;
  if (dir === "br") return null;
  const m = /^br:([^:]+):/.exec(lockfileSha);
  if (!m) return defaultBranch;
  return isGitRef(m[1]) ? m[1] : null;
}

// The branch the dependency scan asks about first (then the exists-else-default rule): the Git branch production was
// really built from, else the project's production branch. `fallback`: the production branch, tried next when the
// first isn't in the repository (the same order as the update PR's base, baseCandidates).
export function scanBranchOf(meta: Record<string, unknown> | null): unknown {
  const s = readProductionSource(meta?.productionSource);
  return s?.kind === "git" ? s.ref : meta?.productionBranch;
}
export function scanFallbackOf(meta: Record<string, unknown> | null): string | null {
  const first = scanBranchOf(meta);
  const pb = meta?.productionBranch;
  return typeof pb === "string" && pb !== first && isGitRef(pb) ? pb : null;
}
