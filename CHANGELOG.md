# Changelog

All notable changes to Watchbell are listed here. Versions follow [Semantic Versioning](https://semver.org).

## 1.2.2

### Security fixes

- Watchbell checks the Node.js it runs on itself: Vercel's function runtime in the cloud edition, the machine's
  Node.js when self-hosted. Settings › Collector has a **Watchbell runtime** line, for example "Node 24.12.0: security
  fix available (24.22.1)", from nodejs.org's release list and endoflife.date's Node.js dates, read every 12 hours; a
  line past end of life says so, and it says unknown, never ok, without a successful recent read. Self-hosted,
  `watchbell start` and `watchbell status` print a one-line warning for a vulnerable or end-of-life Node.js, and
  `status` also checks the Node.js an installed service runs. The lists are fetched with gzip, never Brotli.
  `WATCHBELL_NO_UPDATE_CHECK=1` turns off both the server's reads and the commands' check. See
  [Pages › Manage](docs/pages.md#manage).
- Update pull requests follow what production is really built from. Before, a pull request could go to a stale
  production branch while production had been deployed from another branch or the Vercel CLI, and merging it deployed
  that stale branch over what was live. Watchbell now reads the live production deployment's source every few minutes
  and shows it on the app page as **Production built from**. When production was built from a Git branch the repository
  has, the dependency scan reads that branch and the update pull request targets it. When it was deployed from the CLI,
  built from a branch the repository doesn't have, or not confirmed in the last 30 minutes, the proposal still appears
  with the consequence first ("Production was deployed from the CLI, not built from main. Merging this PR would deploy
  main to production and replace what is live."). It never opens by itself and is never merged automatically: the
  merge watcher stops with "needs a look" and the reason (never "ready to merge", also with auto-rollback off), and an
  approved pull request opens as a draft with that warning on top. Just before an automatic merge or a "ready to merge"
  the watcher also reads the live production deployment from Vercel once and applies the same rules (a redeploy or
  promote of a CLI deployment counts as a CLI deploy). A pull request isn't opened while
  the last dependency scan read another branch than its base; scan again first. Apps deployed to production from CI
  with the Vercel CLI keep their update pull requests for your approval. See
  [Auto-actions](docs/auto-actions.md#automatic-security-fixes).
- zod 4.6.7 (fixes GHSA-mrhx-c7xc-m3w5: memory exhaustion while validating oversized collections). `npm audit
  --omit=dev` reports nothing. Four moderate advisories remain in development tools only (esbuild inside drizzle-kit,
  used to generate migrations); they aren't part of the installed package.

### Auto-actions

- A rollback is proposed for a down or slow app only when the problem started after its live deployment went live and
  within the auto-rollback window. Earlier HighLatency episodes on the same check, each ending less than a day before
  the next, count as the same problem, so days of HighLatency no longer get a rollback; for MonitorDown only an outage
  still going when the deployment went live (or ended up to 15 minutes before) counts. **Check again now** then says
  what it likely is ("Slow since …, not tied to a deploy …: check the app."). A site that stays down outside the window
  gets a redeploy proposal only, and none when it was down before the live deployment went live. See
  [Auto-actions](docs/auto-actions.md#which-alerts-propose-what).
- A rollback never goes back to a deployment known to have Next.js advisories from the Security card's history
  (MonitorDown, HighLatency, DeploymentFailed and LogErrorSpike); a failed check counts with the version it last read,
  and an app that isn't a Next.js site counts as fine. When it can't be told, the rollback still waits for your approval
  with "Previous deployment's Next.js version is unknown" first in its reason, and auto-rollback skips it. A `next`
  update pull request merged by Automatic security fixes therefore has no rollback: the preview test is its only check.

### AI

- When an AI provider can't be reached (its endpoint or tunnel is down, a timeout, or a 502, 503, 504, 52x or 530), is
  rate limited, fails with another server error or sends an unreadable answer, every background and owner-triggered AI
  call now tries the next enabled provider once, except a model you picked by name (Playground, or a model chosen in
  Ask). That includes calls that start from a preferred model, such as the advisor notes' own model. A call with a time
  limit stays inside it: the first provider gets two thirds of it (for limits of 9 seconds or more), so one that hangs
  leaves time for the second. The error names the provider in plain words, for example
  `AI provider "my-router" is unreachable (its endpoint or tunnel is down).`, and says whether another provider was
  tried or where to add one; a refused key says so and is never retried. See [AI](docs/ai.md#what-uses-ai).

### Notifications

- Fewer and clearer Telegram messages. A proposal or an automatic action for an alert is a reply to the message that
  opened the alert, so one incident reads as one thread; an automatic **Check again now** that ran sends nothing (the
  alert's own messages say whether it is still down or resolved); Telegram names apps, databases and hosts by their real
  names instead of app-a or db-a; and an update pull request's result no longer asks you to run `npm install` when the
  lockfile workflow (the GitHub Actions repository set in Settings) took the update. See
  [Notifications](docs/notifications.md#what-gets-sent).

### Console

- The Overview Health card reads in plain words. **Sites reachable**, **Response time**, **Server errors** and **New
  versions** replace "Avg uptime", "p95 response", "5xx responses" and "Deployments", each with a one-line explanation
  and its technical name (uptime, p95, HTTP 5xx, production deployments) on hover. Counts say "in 24 h", and the
  data-source badges say **Checked by Watchbell** or **From Vercel**. The Neon cell reads "is asleep" and "compute
  hours used this month". See [Pages › Overview](docs/pages.md).

### CLI

- `watchbell` in a terminal shows a short start screen (the version, the address, the setup code until the owner
  account exists, and for a network address a two-line warning) and a menu: **Open in browser**, **Keep running in the
  background**, **Show live log**, **Stop and exit**. Use ↑/↓ and Enter or a first letter. **Keep running in the
  background** leaves Watchbell running after the terminal closes; `watchbell stop` and `watchbell status` work as
  before. **Stop and exit** and Ctrl+C stop it cleanly. See [Install](docs/install.md#quick-install-with-npm).
- The server's own messages (the Next.js banner, the collector's progress lines) go to
  `~/.watchbell/logs/watchbell.log` instead of the terminal, at most two files of about 5 MB. An error still shows as
  one line with the log's path. `watchbell start --verbose` prints everything in the terminal as before. Without a
  terminal (piped output, CI) there is no menu and no colour, and `watchbell run`, which the services use, prints as
  before, so journald, launchd and the Scheduled Task keep their logs.
- `watchbell update` installs into the folder the running copy was installed in (`npm install -g --prefix ...`). Before,
  a second Node.js on the PATH (nvm next to a copy in `~/.local`) could take the update while the old version kept
  running. When the running copy still holds the old version afterwards, it says so and what to check.
- An unknown option, such as `--no-openen`, stops with `Unknown option --no-openen (see watchbell --help)` and exit
  code 2. `--timeout=<seconds>` works like `--timeout <seconds>`.
- `watchbell status` shows the port Watchbell really listens on (started with `--port 3261`, it said 3100 before), and
  `watchbell stop` asks that port too.
- A self-hosted start no longer warns "SITE_URL points at localhost": on your own machine that is the normal setup.

### Fixes

- Last deploy (Overview, Applications, the app page) is the deployment production serves. After a promote or roll back
  to an older deployment it showed the newest one instead; a newer production build that is still building or failed
  is still shown. Each change of the serving deployment (a deploy, a promote or a roll back) runs the after-deploy Next.js check
  once.
  See [Pages › Deployments](docs/pages.md#hosting).

## 1.2.1

### Uptime

- A domain move is no longer an outage. Sync and a 6-hourly read store each app's domains and the one production is
  served on (the domain the others redirect to, else a custom domain, else a production alias). A check still on a
  domain the app no longer has reads "Domain changed: old → new" on Uptime and the app page, with an **Update monitor**
  button that keeps the path; the alert is the new warning MonitorDomainMoved instead of MonitorDown, and Watchbell
  never proposes a redeploy or roll back for it. Its proposal, Update monitor, is safe and can auto-run. A domain still
  listed on the project (also one waiting for verification) or on another watched project counts as attached, and a
  domain counts as moved only when the project listed it before or Vercel answers `DEPLOYMENT_NOT_FOUND` for it, so a
  check on another server is never hidden. See
  [Pages › Uptime](docs/pages.md#hosting).
- The app's Domain and the Next.js check use that production domain instead of the first monitor's address.

### Security fixes

- The Security card's Next.js check now raises an alert, FrameworkVulnerable (critical when an advisory is critical),
  and Watchbell proposes the update pull request for an app with a linked repository: `next`, and `eslint-config-next`
  when listed, to the smallest fixed version in the same major. It waits for your approval like the other update pull
  requests, or opens by itself with Automatic security fixes. See [Auto-actions](docs/auto-actions.md#which-alerts-propose-what).
- Monorepos: the dependency scan and the update pull request use the Vercel project's Root Directory (for example
  `apps/web/package.json` and its lockfile, or the repository root's lockfile when the root is a workspace that
  includes the folder), and the Dependencies card shows the file it scanned. Two apps of one repository each get their
  own pull request, and a Root Directory Watchbell can't use is named instead of scanning the root silently.
- You are asked once for `next`: the dependency scan's proposal and the Next.js proposal never both update it, and an
  update pull request that raises `next` raises `eslint-config-next` with it.
- Moderate is treated like High: a moderate advisory on a direct production dependency raises VulnerableDependency at
  warning, and Automatic security fixes has a Moderate switch next to Critical and High, on by default (a setting saved
  before follows its High switch). A moderate fix for a devDependency waits for your approval; low and unknown
  advisories stay on the app page only.
- The Next.js check and the dependency scan run every 6 hours (a new collector task, listed in Settings › Collector; a
  run that doesn't fit one minute carries on in the next minutes until every app and repository was checked) and right
  after each new production deployment of a watched app, once per deployment; the daily job still runs them too. They
  pause with their section: no GitHub reads while DevOps is off, no Next.js check while Hosting is off.
- The dependency scan reads the branch Vercel deploys to production when the repository has it, otherwise the default
  branch, and the update pull request targets that branch and is merged into it, so a fix reaches production when the
  default branch isn't the live one. A pull request whose base is changed on GitHub is stopped, not merged. See
  [Auto-actions](docs/auto-actions.md#automatic-security-fixes).

### Security hardening

- Automatic security fixes merge only what Watchbell wrote: the bumped `package.json` and its lockfile (required when
  the scan found one), where `package.json` may differ from the base branch only in the updated packages' version
  numbers, and every new or changed `package-lock.json` package must be a `sha512` tarball from the base lockfile's
  registry (no links, git, file or http sources, the same `lockfileVersion`, 2 or 3, and at most 25 MB), from the
  PR-write token's own commits or the lockfile workflow's. Any other file, change or commit on the branch stops the pull
  request with "needs a look" instead of merging it; so does a `pnpm`, `yarn` or `bun` lockfile change, which can't be
  checked.
- `/api/ping`, the API and the sign-in page are limited per address in memory before the database is touched, and an
  unknown heartbeat token is remembered for a minute. On Vercel you can add a Firewall rate-limit rule as well
  ([Configuration](docs/configuration.md#cloud-only-settings)).
- Self-host sign-in: wrong passwords and wrong authenticator codes back off step by step (30 seconds doubling up to an
  hour) per email and address instead of hard 15-minute windows, so someone at another address can't lock you out, and
  ten failures for one account in a day send a Telegram notice. Behind a reverse proxy, many addresses together are
  still limited per account, except addresses that signed in to it (or used a session) in the last 90 days. Set `WATCHBELL_TRUSTED_PROXY_HOPS` behind
  a reverse proxy ([Configuration](docs/configuration.md#behind-a-reverse-proxy)). `reset-login` clears every
  account's sign-in wait.
- The SQL console refuses unicode escapes (`U&'…'`, `U&"…"`) and a quoted `"analyze"`, and the read-only check on save
  also refuses roles that can read server files or signal other sessions.
- Responses no longer send `X-Powered-By`, and add `Permissions-Policy` (no camera, microphone, location, payment or
  USB) and `Cross-Origin-Opener-Policy: same-origin`. Every console page sends a Content-Security-Policy with a fresh nonce per request, so a
  script injected into a page can't run. Cloud: the Supabase session cookies are HttpOnly.
- `/auth/not-member` ends only the current session, so a crafted link can't sign you out everywhere.

### Fixes and polish

- Deployments: **View build logs** works. It opens the newest build's log from Vercel in a side drawer (last 2,000
  lines, read when opened, never stored), highlights error lines and jumps to the first one. Operators and owners only:
  a button on building and failed deployments, a row-menu item on ready ones. The demo shows a sample log.
- The Dependencies card says **Not scanned** and why (no linked repository, DevOps off, no lockfile or package.json,
  or the scan failed) instead of "None known" whenever no successful scan covers the app.
- Applications list: the row menu's Redeploy (same confirm as the app page) and View logs (the app's Logs tab) work.
- Supabase: **Check services** in the row menu reads the project's service health now. Firebase: **Run health check**
  does the 5-minute Firestore read now and updates the Health column.
- No more "Arrives in stage N": the placeholder page for unknown addresses is a normal 404, and the private Welcome
  alerts step links to Alerts.
- Labels that said "needs test" or "not read yet" for things Watchbell never reads now say what is true: the commit
  message on Deployments is read from Vercel; Firestore reads, writes and deletes need the Blaze plan (the stored size isn't read); Vercel's monthly
  usage and the Web Analytics event count on Free tier budget are "not read".
- A turned-off section's alerts are left out of the API too, like the bell and the Alerts page. The section switch
  follows a change made elsewhere after the page refreshes, and the bell's count no longer waits for the section read.
- Status page: one line at the top says whether everything is running, or which service is down, degraded, in
  planned maintenance or without recent data. The README badge is no longer shown to visitors (it is in Settings ›
  Status page), and an unknown or unpublished address shows a plain "No status page here" instead of the framework's
  404.
- Faint grey text (crumbs, footnotes, secondary table text) is darker in both themes and now meets WCAG AA contrast.
- Wording that was wrong or led nowhere: self-host Uptime names the built-in scheduler instead of cron-job.org and
  QStash; Welcome points to Connections instead of a Home link that didn't exist; the self-host sign-in page tells the
  owner how to reset their own login (`watchbell reset-login`, or `npm run reset-login` from an installer).
- Site: the hero says "Two taps", matching the night it describes.
- The in-app and site "WB" monogram is now the ringing-bell mark, the same as the favicon (sidebar, sign-in pages, status page, site header).
- Docs: backup and restore steps for the npm package (`~/.watchbell`, `watchbell stop`), the log-based auto-action
  proposals (LogErrorSpike, LogErrors, LogDbErrors), and the Firebase and Free tier budget wording.

## 1.2.0

### Sections

- The menu is grouped into sections: Home, Hosting, Database, DevOps and Manage. Hosting is there from the start;
  Database and DevOps appear by themselves when you connect a provider of theirs (or already have data there). Every
  page keeps its address.
- Manage › Sections turns Hosting, Database or DevOps off: the section leaves the menu and its sync, alerts,
  notifications and new auto-action proposals pause. Nothing is deleted, and turning it back on picks up where it left
  off. Keep active and Auto-restore keep running while Database is off, so a kept Supabase project is never paused
  because of the switch.

### Connections

- Connections is a grid of providers grouped by section, with a drawer per provider: its accounts, "Create one" (the
  provider's token page), "It needs" (the smallest permissions) and Test connection, which checks a token without
  saving it.

### Security

- Next.js 16.4.2 (fixes GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr and GHSA-p3m5-59mp-jv5r). Update with
  `watchbell update` (or `npm install -g watchbell@latest` from 1.0).

## 1.1.0

### Time zone

- Times, schedules and messages follow `WATCHBELL_TIMEZONE` (an IANA name such as `Europe/Berlin`). New installs
  write your computer's zone; an existing `.env` without it keeps Western Indonesian Time (WIB), so nothing changes
  for you after the update. The daily job (03:00), the email digest (07:00) and weekly maintenance windows use local
  wall-clock time and stay correct across daylight-saving changes. An invalid name falls back to WIB with a warning.
  See [Time zone](docs/configuration.md#time-zone).

### npm package

- `watchbell` tells you when a newer version is on npm (at most once a day, a plain request to the npm registry;
  turn it off with `WATCHBELL_NO_UPDATE_CHECK=1` in `~/.watchbell/.env` or the environment).
- `watchbell update` installs the latest version with the npm next to your Node.js, stopping and restarting the
  service if you installed one. 1.0 has no `watchbell update`, so update from 1.0.x once by hand: `watchbell stop`
  (or stop the service), then `npm install -g watchbell@latest`.
- `watchbell --host <address> --port <port>` for one run. A host other than this machine prints the addresses on
  your network and a warning. [Open it from another computer](docs/install.md#open-it-from-another-computer) explains the SSH tunnel and `--host`.
- With `HOST` (or `--host`) set to one address of this machine, not `0.0.0.0`, and `SITE_URL` left at its default,
  links in alerts now use `http://<that address>:<port>` instead of localhost, so they open from other computers.
- `watchbell service install` on macOS now installs a launchd agent (it printed instructions before).
- `watchbell status` warns when the installed service points at a Node.js that no longer exists.

### Other

- LICENSE and the READMEs now name the copyright holder.

## 1.0.0

The first public release.

### Name

- The product is called Watchbell (it was Watchpost during early testing). Settings are `WATCHBELL_*`; the old
  `WATCHPOST_*` names are still read, so an existing `app/.env` needs no change. The auto-start is the systemd user
  service `watchbell.service` or the Scheduled Task `Watchbell`; the installers offer to replace the old
  `watchpost.service` / `Watchpost` task of the same folder.

### Install and run

- One-command installers: `install.sh` for Linux and `install.bat` / `install.ps1` for Windows, with an optional
  auto-start (a systemd user service, or a per-user Scheduled Task), safe re-runs and `--upgrade`. Matching
  uninstallers that keep your data. Manual steps for macOS.
- Self-host mode: a local PGlite database in `app/data`, a built-in scheduler (collector every minute, daily job at
  03:00 WIB), no cloud account needed.
- Local accounts: a first-run setup page protected by a one-time code, owner, operator and viewer roles, an
  authenticator app (TOTP) for owners and operators, and `npm run reset-login` for lost access.

### Monitoring

- Vercel apps: deployments, request logs, stored errors, analytics, redeploy, roll back and promote.
- Uptime checks every minute, heartbeats for your own jobs, maintenance windows, and a public status page with badges.
- Databases: Supabase (with keep-active and auto-restore), Neon, Firebase, Turso, Upstash Redis and Cloudflare D1.
- Domains and Cloudflare DNS records, with registration expiry (RDAP) and certificate checks.
- GitHub repositories, Actions status and dependency advisories.
- Topology map, events and audit log, provider status feeds, a catalog of free databases, and create requests that
  need an owner's approval.

### Alerts and actions

- Alert rules with Telegram, Discord and a daily email digest, in English or Bahasa Indonesia per channel.
- Auto-actions: fixes proposed for firing alerts, approved on the console or with Telegram buttons (polling, so it
  works on a laptop without a public address), opt-in auto-run for safe actions, auto-rollback after a bad deploy, and
  automatic security update pull requests.

### Tools

- AI gateway with your own provider keys (Google Gemini, Cloudflare Workers AI, or any OpenAI-compatible server),
  console API keys, an MCP server for AI agents, and an API explorer.
- Read-only SQL console for Supabase and Neon, and a Firestore query builder.
- Monthly summaries saved to your own Google Drive.
