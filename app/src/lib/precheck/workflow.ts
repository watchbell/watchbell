// Watchbell 1.4: the small workflow an app repository adds to run the pre-deploy check on its pull requests. It calls
// the reusable workflow in the public repository at a release tag (public-edition/.github/workflows/precheck.yml).
// Pure; throws on a folder or tag that isn't one (the caller builds it from the owner's own input).

const DIR = /^(?:[A-Za-z0-9._-]+\/){0,4}[A-Za-z0-9._-]+$/;
const TAG = /^v\d+\.\d+\.\d+$/;

export function CALLER_YAML(dir: string, tag: string): string {
  if (dir !== "." && (!DIR.test(dir) || dir.split("/").some((p) => p === "." || p === ".."))) throw new Error("That isn't a folder in the repository.");
  if (!TAG.test(tag)) throw new Error("That isn't a Watchbell release tag.");
  return `# Watchbell pre-deploy check: comments on each pull request with new vulnerable packages, possible secrets, the
# Next.js version and new env names. Warning only, it never blocks a merge.
name: Watchbell pre-deploy check
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  precheck:
    uses: watchbell/watchbell/.github/workflows/precheck.yml@${tag}
    with:
      working-directory: ${dir}
`;
}
