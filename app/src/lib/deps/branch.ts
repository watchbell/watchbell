import { isGitRef } from "@/lib/providers/github";

// Watchbell 1.2.1 (owner 24 Oct): the branch Vercel deploys to production (resources.meta.productionBranch, written by
// the account sync) is what is live. The dependency scan reads it and the update PR targets it, when the repository has
// that branch (asked of GitHub by the caller); otherwise both use the repository's default branch. shopfront is
// live from web-revamp while main is stale. Pure.

// The production branch worth asking about: a plain branch name that isn't the default branch; else null.
export function productionCandidate(productionBranch: unknown, defaultBranch: string | null): string | null {
  return typeof productionBranch === "string" && productionBranch !== defaultBranch && isGitRef(productionBranch) ? productionBranch : null;
}
