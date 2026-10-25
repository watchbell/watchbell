# Auto-actions

Bahasa Indonesia: [id/auto-actions.md](id/auto-actions.md)

When an alert fires, Watchbell can propose a fix: one of the actions the console already has, such as checking a site
again or rolling back a bad deploy. You approve or reject it on the **Auto-actions** page or with the buttons on its
Telegram message. An approved action runs through the same code, checks and audit trail as pressing the button
yourself, with you as the actor.

- [Which alerts propose what](#which-alerts-propose-what)
- [Approving and rejecting](#approving-and-rejecting)
- [Safe auto-run](#safe-auto-run)
- [Auto-rollback after a bad deploy](#auto-rollback-after-a-bad-deploy)
- [Automatic security fixes](#automatic-security-fixes)
- [Where to see what happened](#where-to-see-what-happened)

## Which alerts propose what

| Alert | Proposed action | Risk |
|---|---|---|
| MonitorDown, HighLatency (HTTP check of an app) | Check again now | safe |
| MonitorDown, HighLatency, while the app's Neon compute is suspended | Wake Neon | safe |
| MonitorDown of the heartbeat of Watchbell's own daily job | Rerun daily job | risky |
| MonitorDown of an app's HTTP check, outside the auto-rollback window | Redeploy production, Roll back to previous deployment | risky |
| MonitorDomainMoved (the check's domain is no longer one of the app's domains) | Update monitor (the app's new domain, same path); never a redeploy or roll back | safe |
| MonitorDown or HighLatency in the first minutes after a new production deploy | Roll back to previous deployment | risky (see auto-rollback) |
| DeploymentFailed | Redeploy production, Roll back to previous deployment | risky |
| AutoPauseRisk (Supabase) | Send Supabase keep-alive | safe |
| DatabasePaused (Supabase) | Restore Supabase project | risky |
| CertExpiringSoon | Re-check domain certificate | safe |
| VulnerableDependency | Open package update PR | risky |
| FrameworkVulnerable (the app's Security card: its Next.js version has a known advisory) | Open package update PR for `next` (and `eslint-config-next` when listed) | risky |
| LogErrorSpike (logs, no alert): the production deployment went live less than 2 hours ago and has logged at least 10 errors, and at least 5 times the hourly rate of the 24 hours before | Roll back to previous deployment | risky |
| LogErrors (logs, no alert): 20 or more errors in the last 30 minutes, no production deploy in the last 2 hours | Check again now (the app's HTTP check) | safe |
| LogDbErrors (logs, no alert): 3 or more database connection errors in the last 30 minutes, for an app with a linked database | Wake Neon (a suspended Neon compute), Restore Supabase project (a paused Supabase project) | safe, risky |

A proposal is made at most once per alert and action. The three log rules read the error lines Watchbell stores from
Vercel's logs (Hosting); they have no alert, so they expire when the logs no longer show the problem, and a closed one
isn't proposed again for 2 hours. A pending proposal expires after 2 hours, or earlier when its
alert resolves. Silenced alerts propose nothing. Proposals are kept for 30 days.

**Next.js fixes.** The Security card on an app's page reads the Next.js version the live site runs and looks it up on
OSV.dev every 6 hours, right after each new production deployment, and in the daily job. When it finds an advisory, the
FrameworkVulnerable alert fires (critical when one advisory is critical) and, for an app with a linked GitHub
repository, Watchbell proposes an update pull request that raises `next` to the smallest version that fixes the
advisories within the same major version (for example 16.3.8 to 16.4.1), and `eslint-config-next` to the same version
when `package.json` lists it. A major update is proposed only when no fix exists in the current major; the alert names
the same version as the proposal, and says so when some advisories are only fixed in a later major. You are asked once
for `next`: when the dependency scan of the same app already proposes an update for it, no Next.js proposal is made, and
when the Next.js proposal (or an open Watchbell pull request for `next`) came first, the dependency scan's proposal
leaves `next` out. Any update pull request that raises `next` raises `eslint-config-next` with it, listed as "updated to
match". Without a linked repository, the alert's next step says to link it on the app page (or to update `next`
yourself). Update pull requests need GitHub, so they are not proposed while the DevOps section is off.

**Monorepos.** When the Vercel project has a Root Directory (for example `apps/web`), the dependency scan reads
`apps/web/package.json` and the lockfile there, and the update pull request edits that `package.json`, names the folder
in its title and asks you to run `npm install` in it. Two apps of one repository (for example `apps/web` and
`apps/admin`) each get their own pull request. Without a lockfile in that folder, the repository root's lockfile is used
only when the root is a workspace that includes the folder (its lockfile lists the folder, or the root `package.json`
`workspaces` match it); otherwise the versions come from the folder's `package.json` ranges and the card says so. The
Dependencies card shows the file it scanned, such as `apps/web/package-lock.json`. A Root Directory Watchbell can't use
(odd characters such as spaces or `@`, or more than 4 folders deep) is named on the card, the root is scanned instead,
and no update pull request is opened for that app. Watchbell reads the Root Directory from Vercel on each daily sync, or
when you press Sync on Connections. When several apps share a repository, the daily scan uses a watched app's folder;
Scan now on an app's page scans that app's folder.

**Safe** actions only read or nudge (a re-check, a wake-up, a keep-alive query). **Risky** actions change production
(redeploy, roll back, restore, open a pull request, rerun the daily job). Risky actions always wait for you, except
the narrow auto-rollback rule below, which you have to switch on.

## Approving and rejecting

- **On the Auto-actions page** (owner only): "Waiting for you" lists pending proposals with the reason and the target.
  Approve runs the action at once; Reject closes it. Below is the history of everything proposed, run, rejected or
  expired.
- **On Telegram**, with [approval buttons](notifications.md#approval-buttons) on: each proposal message has
  **Approve** and **Reject**. Only your linked Telegram account can use them. For a risky action, Approve first turns
  into **Sure? Approve**, which you must press within 2 minutes. On a self-hosted laptop the buttons work while
  Watchbell runs (see [How the buttons reach a laptop](notifications.md#how-the-buttons-reach-a-laptop)).

The actions need the right token permissions, for example a Supabase token with Project admin: Write to restore a
project (see [Connect providers](providers.md)).

## Safe auto-run

**Settings › Auto-actions** lists every action kind. Safe kinds have a switch: when one is on, a proposal of that kind
runs without asking and you get a short Telegram line afterwards. All switches are **off** by default. Risky kinds have
no switch and always wait for you.

## Auto-rollback after a bad deploy

Off by default; turn it on in Settings › Auto-actions. When on, a new production deploy on Vercel that breaks the app is
rolled back to the previous deployment without asking, but only:

- with the roll-back action, nothing else;
- within the first N minutes after the new deploy went live (you choose N between 10 and 120; 30 by default);
- when a monitor of that app is down or the logs show an error spike;
- once per deployment, and never twice for one app within 2 hours.

Every rollback is reported on Telegram and in Events. Failed builds never go live on Vercel, so this is for builds that
succeed but break at runtime. Outside the window, a site that stays down gets redeploy and rollback proposals that wait
for your approval.

## Automatic security fixes

When the dependency scan of a watched app (or its Security card's Next.js check) finds a critical, high or moderate
advisory that has a fixed version, Watchbell can fix it end to end. It needs the
[GitHub PR-write token](providers.md#github-pr-write) on Connections. Then it:

1. opens an update pull request itself (`package.json` only, on a new `watchpost/deps-…` branch), only for direct
   dependencies whose fix stays in the same major version, and never twice for the same package while a pull request is
   open;
2. waits for GitHub's checks (all green), then for Vercel's preview of the pull request;
3. tests the preview: `/` and up to 3 monitor paths must answer 200 to 399 within 15 seconds (for a preview behind
   Vercel Authentication: 3 minutes without error lines in its logs);
4. squash-merges it, but only while auto-rollback is on, so auto-rollback guards the first minutes of the production
   deploy that follows.

Before the merge Watchbell checks what the pull request contains: only the bumped `package.json` (in the app's folder)
and its lockfile may change, the lockfile must be there when the scan found one, and in `package.json` only the version
numbers of the updated packages may differ from the base branch (no scripts, overrides, other dependencies or `github:`
sources). In `package-lock.json`, every package that is new or changed must be a tarball from the registry the base
branch's lockfile already uses (npm's by default), in the registry's own `/<name>/-/<name>-<version>.tgz` form, with a
`sha512-` integrity; links and `git+`, `file:`, `github:` or `http:` sources are refused, and so are a changed
`lockfileVersion`, one other than 2 or 3, and a lockfile over 25 MB. Every commit must also come from the PR-write
token's own account or be the lockfile commit of the GitHub Actions workflow (which may touch only the lockfile).
Anything else stops it with "needs a look: unexpected change in …" (or "unexpected lockfile change …") and leaves it
open for you. Someone who can push to the branch can still write commits under another name, so these content checks are
the guard. What they don't check yet is that a registry package's integrity and dependencies are the ones the registry
publishes for that version; until that check comes, a forged lockfile could still add a real registry package as a new
dependency, or move any package already in the lockfile to another real registry version (an older, vulnerable release,
say). Both close in 1.2.2 with that registry check. Other lockfile kinds (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`)
can't be checked, so their pull requests always wait for you.

If anything fails, or it isn't done within 45 minutes, the pull request stays open marked "needs a look". A major
update, a transitive package, or a severity you switched off becomes a normal proposal that waits for your approval.
Every pull request opened and every merge or stop is sent to Telegram and logged in Events.

Automatic security fixes are listed as on by default in Settings › Auto-actions, but nothing happens until a GitHub
PR-write token is connected, and nothing is merged unless auto-rollback is on too. Choose the severities (Critical, High
and Moderate, all on by default; a setting saved before 1.2.1 has Moderate on when High is on) or switch it off there.

**Moderate is treated like High.** A moderate advisory on a direct dependency that reaches production (not a
`devDependencies` one) raises the VulnerableDependency alert at warning, like a high one, and its fix opens by itself
while the Moderate switch is on. A moderate fix for a `devDependencies` package waits for your approval. Many advisories
in one repository still give one pull request. Low and unknown advisories are shown on the app page only.

**When it checks.** The collector's security task starts every 6 hours (Settings › Collector lists it): it scans the
linked repositories of the watched apps, oldest first, where an unchanged lockfile costs one GitHub read and no new
advisory lookup, and reads the Next.js version of every watched app. When that doesn't fit one collector run, it carries
on in the next minutes' runs until every repository was scanned and every app checked once; a site whose check runs out
of time is tried again in a later run, and after two tries it waits for the daily job. When Watchbell sees a new
production deployment of a watched app, that app is checked in the next minute's run without waiting for the 6 hours,
once per deployment (a check that keeps running out of time is tried at most three times). The daily job still checks
everything too. While DevOps is off nothing is read from GitHub; while Hosting is off the Next.js check pauses.

**Which branch.** The dependency scan reads the branch Vercel deploys to production (the project's production branch)
when the repository has that branch, otherwise the repository's default branch, so the advisories are those of what is
live. The update pull request targets the same branch and is merged into it, so a fix reaches production even when the
default branch isn't the one that is live. If the pull request's base is changed on GitHub (for example when that branch
is deleted), Watchbell stops and marks it "needs a look" instead of merging.

**package-lock.json.** An update pull request needs a matching `package-lock.json`. Watchbell doesn't run `npm` for
your projects itself; Settings › Lockfile explains how to set up a small GitHub repository of your own with a GitHub
Actions workflow that does it. After opening an update pull request, Watchbell asks that workflow to run
`npm install --package-lock-only --ignore-scripts` on the pull request's branch and push the new lockfile (free, runs
on GitHub, install scripts off). It uses the same PR-write token, stored there as the repository secret
`WATCHBELL_PR_TOKEN`.

## Where to see what happened

- **Events** has every approval, rejection, auto-run and result, with who did it.
- **Auto-actions** shows each proposal's status and its one-line result.
- **Telegram** gets the proposal, and a line after each auto-run, rollback or merge.
