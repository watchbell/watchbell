# Auto-actions

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
| MonitorDown or HighLatency in the first minutes after a new production deploy | Roll back to previous deployment | risky (see auto-rollback) |
| DeploymentFailed | Redeploy production, Roll back to previous deployment | risky |
| AutoPauseRisk (Supabase) | Send Supabase keep-alive | safe |
| DatabasePaused (Supabase) | Restore Supabase project | risky |
| CertExpiringSoon | Re-check domain certificate | safe |
| VulnerableDependency | Open package update PR | risky |

A proposal is made at most once per alert and action. A pending proposal expires after 2 hours, or earlier when its
alert resolves. Silenced alerts propose nothing. Proposals are kept for 30 days.

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

When the dependency scan of a watched app finds a critical or high advisory that has a fixed version, Watchbell can
fix it end to end. It needs the [GitHub PR-write token](providers.md#github-pr-write) on Connections. Then it:

1. opens an update pull request itself (`package.json` only, on a new `watchpost/deps-…` branch), only for direct
   dependencies whose fix stays in the same major version, and never twice for the same package while a pull request is
   open;
2. waits for GitHub's checks (all green), then for Vercel's preview of the pull request;
3. tests the preview: `/` and up to 3 monitor paths must answer 200 to 399 within 15 seconds (for a preview behind
   Vercel Authentication: 3 minutes without error lines in its logs);
4. squash-merges it, but only while auto-rollback is on, so auto-rollback guards the first minutes of the production
   deploy that follows.

If anything fails, or it isn't done within 45 minutes, the pull request stays open marked "needs a look". A major
update, a transitive package, or a severity you switched off becomes a normal proposal that waits for your approval.
Every pull request opened and every merge or stop is sent to Telegram and logged in Events.

Automatic security fixes are listed as on by default in Settings › Auto-actions, but nothing happens until a GitHub
PR-write token is connected, and nothing is merged unless auto-rollback is on too. Choose the severities or switch it
off there.

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
