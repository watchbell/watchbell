// Lockfile updates through GitHub Actions (owner 16 Oct: the VM goes away by ~31 Dec and there's no card for a new one).
// After Watchbell opens an update PR, it sends a repository_dispatch to the owner's small "actions" repository; the
// workflow there checks out the PR branch, runs `npm install --package-lock-only --ignore-scripts` and pushes the new
// package-lock.json back to the branch. The merge watcher sees the new head and checks again. Pure.

export const ACTIONS_REPO_SETTING = "deps.lockfileActions";
export const LOCKFILE_EVENT = "watchpost-lockfile";
// How long the watcher treats a dispatched lockfile update as still on its way (a failed CI meanwhile waits).
export const ACTIONS_WAIT_MS = 10 * 60_000;

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^watchpost\/deps-[0-9a-f]{8}$/;
const LOCK_PATH = /^(?:[A-Za-z0-9._-]+\/){0,4}package-lock\.json$/;

export const isActionsRepo = (v: unknown): v is string => typeof v === "string" && REPO.test(v) && !v.includes("..");

export type ActionsSetting = { repo: string | null };
export function parseActionsSetting(raw: unknown): ActionsSetting {
  const repo = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { repo?: unknown }).repo : null;
  return { repo: isActionsRepo(repo) ? repo : null };
}

export type LockfilePayload = { repo: string; branch: string; lockfile: string; pr: number };

// The client_payload the workflow receives; null when anything isn't exactly what the workflow accepts (it checks the
// same rules again before touching a repository).
export function lockfilePayload(o: { repo: string; branch: string; lockfilePath: string | null; prNumber: number }): LockfilePayload | null {
  const lockfile = o.lockfilePath ?? "package-lock.json";
  if (!isActionsRepo(o.repo) || !BRANCH.test(o.branch) || !LOCK_PATH.test(lockfile) || lockfile.includes("..")) return null;
  if (!Number.isInteger(o.prNumber) || o.prNumber < 1) return null;
  return { repo: o.repo, branch: o.branch, lockfile, pr: o.prNumber };
}

// The workflow the owner adds as .github/workflows/watchbell-lockfile.yml in the actions repository. Every input comes
// in through env variables (never ${{ }} inside a script) and is checked against the same patterns as above.
export const WORKFLOW_YAML = `name: Watchbell lockfile
on:
  repository_dispatch:
    types: [${LOCKFILE_EVENT}]
permissions:
  contents: read
concurrency:
  group: watchpost-lockfile
  cancel-in-progress: false
jobs:
  lockfile:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      REPO: \${{ github.event.client_payload.repo }}
      BRANCH: \${{ github.event.client_payload.branch }}
      LOCKFILE: \${{ github.event.client_payload.lockfile }}
    steps:
      - name: Check the request
        run: |
          [[ "$REPO" =~ ^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$ ]] || { echo "bad repo"; exit 1; }
          [[ "$BRANCH" =~ ^watchpost/deps-[0-9a-f]{8}$ ]] || { echo "bad branch"; exit 1; }
          [[ "$LOCKFILE" =~ ^([A-Za-z0-9._-]+/){0,4}package-lock\\.json$ && "$LOCKFILE" != *..* ]] || { echo "bad lockfile path"; exit 1; }
      - uses: actions/checkout@v5
        with:
          repository: \${{ env.REPO }}
          ref: \${{ env.BRANCH }}
          token: \${{ secrets.WATCHBELL_PR_TOKEN }}
          persist-credentials: true
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - name: Update the lockfile (no install scripts)
        run: |
          dir=$(dirname "$LOCKFILE")
          cd "$dir"
          npm install --package-lock-only --ignore-scripts --no-audit --no-fund
      - name: Push it to the PR branch
        run: |
          if git diff --quiet -- "$LOCKFILE"; then echo "lockfile already up to date"; exit 0; fi
          git config user.name "watchbell[bot]"
          git config user.email "watchbell-bot@users.noreply.github.com"
          git add -- "$LOCKFILE"
          git commit -m "chore(deps): update package-lock.json (Watchbell)"
          git push origin "HEAD:$BRANCH"
`;
