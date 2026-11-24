# Pre-deploy check

Bahasa Indonesia: [id/precheck.md](id/precheck.md)

The pre-deploy check is a GitHub Actions workflow you add to an app repository. On every pull request it looks at what
the pull request adds and writes the result as one comment, edited on each new push:

- **Packages**: the package versions the pull request adds or changes in the lockfile, checked against OSV.dev. Only
  advisories on those versions are listed; what your default branch already installs is the Dependencies card's job.
- **Secrets**: possible keys, tokens and passwords in the pull request's commits, found by gitleaks. The comment names
  the file, line, rule and commit, never the value.
- **Next.js**: the version the pull request installs, and the one it replaces.
- **Env names**: names added to `.env.example`, and `process.env` names newly read in code that `.env.example` doesn't
  list, so you can set them on Vercel before merging.

It is **warning only**: the job always passes and never blocks a merge. The first line of the comment says whether to
fix something before merging, check something, or that nothing new turned up. The console's Pull requests card (see
[Pages › Hosting](pages.md#hosting)) reads these comments.

## Add it to a repository

Add `.github/workflows/watchbell-check.yml` to the app repository:

```yaml
name: Watchbell pre-deploy check
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  precheck:
    uses: watchbell/watchbell/.github/workflows/precheck.yml@v1.8.5
    with:
      working-directory: .
```

Set `working-directory` to the folder with the app's `package.json` and lockfile when the app isn't at the root of the
repository, for example `apps/web`. The check runs on the next pull request.

Supported lockfiles: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` and `bun.lock`.

## What it sends where

- Package names and versions the pull request adds go to OSV.dev (free, no key).
- The comment goes to your pull request with the workflow's own token. Nothing is sent to Watchbell, and the workflow
  never gets your Vercel or other provider tokens.
- gitleaks runs on the runner and is checked against its published checksum before it runs. It honours the
  repository's own `.gitleaks.toml` and `.gitleaksignore`, including ones a pull request adds, so review changes to
  those files like any other code.
- A newer push to the same pull request cancels the older run, so the comment always describes the latest commit.

## Pull requests from forks

GitHub gives a pull request from a fork a read-only token, so the check can't comment there. The result is still in
the run's job summary and as warnings on the run.

## When a part isn't checked

Each part runs on its own. When one can't run (no lockfile in the folder, OSV.dev not answering, gitleaks not
downloaded), the comment says "Not checked" with the reason and the rest still reports. A part that wasn't checked
never reads as "no problems".
