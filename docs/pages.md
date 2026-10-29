# Pages

Bahasa Indonesia: [id/pages.md](id/pages.md)

The left menu groups the pages into sections, the way the console does: Home, Hosting, Database, DevOps and Manage.
Home, Hosting and Manage are there from the start. Database appears by itself when you connect Supabase, Neon,
Firebase, Turso or Upstash, or once a database is watched; DevOps when you connect GitHub. An owner can turn Hosting,
Database or DevOps off in [Manage › Sections](#manage). Some pages are for owners only; operators and viewers don't
see them in the menu (see [roles](first-run.md#add-more-people)). Press Ctrl+K (Cmd+K on a Mac) anywhere to jump to a
page by name; it lists the same pages as the menu.

Watchbell reads your providers on a schedule of its own: a collector run every minute (each task only when its own
interval has passed) and a daily job at 03:00 in your [time zone](configuration.md#time-zone). Nothing runs while the
machine is asleep or Watchbell is stopped; a missed daily job runs once when it is back. Times on these pages and in
messages are in that zone.

The top bar says when the page's data arrived ("Updated 12s ago · Auto · after each check"). Click it to choose how
the page refreshes: **Auto** (the default, right after each collector run), every 1, 5, 15 or 30 minutes, or **Off**.
The choice is kept in this browser. A hidden tab doesn't refresh and catches up when you come back; a tab nobody has
touched for 30 minutes refreshes every 4 minutes at most.

- [Home](#home)
- [Hosting](#hosting)
- [Database](#database)
- [DevOps](#devops)
- [Manage](#manage)
- [Pages outside the menu](#pages-outside-the-menu)

## Home

**Welcome.** Shown while nothing is connected: the first steps (connect Vercel, pick the apps to watch, add your
databases), each ticked off as you do it.

**Overview.** The state of everything at a glance: banners for connections that need attention and for problems found
by the collector, creates waiting for approval, and every watched application with its uptime, latest deployment and
linked database. Operators and owners get a Refresh button that runs the collector now.

The Health card sums up the last 24 hours in plain words: **Sites reachable** (the share of checks that got an answer,
the uptime), **Response time** (most checks, 95 of 100, answered faster than this: the p95), **Server errors** (pages
that broke on the server side: the HTTP 5xx responses) and **New versions** (deploys put live). Counts read "in 24 h"
because the window is the last 24 hours, not the calendar day. Hover a line to see its technical name. With the
data-source tags on, the badges read **Checked by Watchbell** or **From Vercel**. The Neon cell above it says "is asleep"
for an idle compute and counts "compute hours used this month".

**Topology.** A map of how each domain reaches an app and which database each app uses. Domains come from Vercel;
database links come from each app's Edit link. Select a node for its details.

**Events.** Every change the collector noticed and every action someone took, newest first. New ones appear while the
page is open; a change that repeats within an hour is counted on one row. This is also the audit log: approvals,
auto-runs, sign-in related changes and setting changes are here.

**Provider status.** Public status feeds of Vercel, Supabase, Neon, Cloudflare, Firebase and Google Cloud, polled
every 5 minutes. When a provider has an incident, related alerts are labelled so you know the problem
isn't your app. Each incident names what it affects. One on something Watchbell doesn't watch (Firebase Test Lab, the
Supabase dashboard or Management API) shows in grey and raises nothing; only Firestore, Authentication and Hosting
colour Firebase, and only projects and databases colour Supabase. An incident whose feed hasn't changed for over a day
says "no update for N days, may be stale".

## Hosting

**Applications.** Your Vercel projects that you chose to watch, with their database, domain and uptime. Open one for:

- Details: status, response time, page views, 5xx responses, uptime, security advisories for its dependencies, and its
  GitHub repository and Actions status when GitHub is connected. The Security card shows the Next.js version the live
  site runs and its known advisories, checked every 6 hours and right after production starts serving another
  deployment (a new deploy, a promote or a roll back); a vulnerable version raises the FrameworkVulnerable alert and, with a linked repository, an update pull request proposal (see
  [Auto-actions](auto-actions.md#which-alerts-propose-what)). The Node.js under Watchbell itself is checked on Settings ›
  Collector (Watchbell runtime). In a monorepo, the Dependencies card scans the Vercel
  project's Root Directory (for example `apps/web/package-lock.json`), and Scan now scans that app's folder. "None
  known" only appears after a successful scan; otherwise the card says **Not scanned** and why (no linked repository,
  DevOps is off, no lockfile or package.json, or the scan failed). Advisories in development tools only (packages
  that never reach production, such as a migration tool) are counted on their own **Development tools** row, marked
  "local development only, no production impact", and never raise an alert.
- The Environment card (operators and owners), under Dependencies. **Check now** reads the names of the project's
  environment variables from Vercel and compares them with `.env.example` in the linked repository (in the Root
  Directory, on the default branch). It lists a name that `.env.example` has but Production doesn't, a name set for
  Preview or Development only, a `NEXT_PUBLIC_` name that looks secret (it ends up in the browser), and a Production
  name missing from `.env.example`. Only names are read, never values; nothing runs on a schedule and nothing is stored.
- Metrics, Deployments and Logs tabs for that app.
- Actions for operators and owners: redeploy, roll back, check now. The row menu of the Applications list has Redeploy
  (the same confirm) and View logs (the app's Logs tab) too.

**Deployments.** Recent deployments of the watched apps, read from the Vercel API. Vercel's free Hobby plan can only
roll back to the previous production deployment. **Current** marks the deployment production serves, and Last deploy
(Overview, Applications, the app page) shows that one, also after a promote or roll back to an older deployment; a
newer production build that is still building or failed is shown there instead. Its time is when that build was made,
not when it was promoted. **View build logs** (operators and owners: a button on a building or
failed deployment, in the row menu of a ready one) opens the newest build's log in a side drawer, read from Vercel when
you open it (the last 2,000 lines, not stored), with error lines highlighted and a "Jump to first error" link. On a
failed build the owner also gets **Explain with AI**: the end of the log (at most 120 lines, error lines first, secrets
cut out) goes to the AI provider connected under AI Gateway, and the answer says what broke, the likely fix and the
file. It counts against the AI quota (20 calls per 10 minutes), runs only when you press it, and isn't stored.
**What changed** (operators and owners, in the row menu of a ready production deployment built from a commit) lists
the commits between that deployment and the production deployment before it, read from GitHub when you open it (the
newest 50, with the pull request number linked when the commit title has one). It needs the app's repository linked
and GitHub connected.

**Domains.** Every domain of a watched app: DNS from Cloudflare, configuration from Vercel, registration expiry from
RDAP, and certificate expiry from Watchbell's own TLS check. Warns when a domain is proxied through Cloudflare in front
of Vercel and, for owners, offers a one-click "Set DNS only". Re-check reads a certificate again.

**DNS records.** The records of each Cloudflare zone you watch, with the zone's details. Owners can edit a record or
add one (as a create request, below); both need the DNS Edit permission on the Cloudflare token. Records are never
deleted from here.

**Uptime.** HTTP checks (every minute) and heartbeats. A heartbeat waits for your own job to call its ping address,
`<SITE_URL>/api/ping/<token>` (add `/start` or `/fail` to report those states), and alerts when a ping is late. Also
maintenance windows (one-off or weekly): checks keep running inside a window but open no alerts and don't count
against uptime. When an app moves to a new domain, a check still on the old one reads **Domain changed: old → new**
(here and on the app page) instead of Down, and Owners and Operators get an **Update monitor** button that points the
check at the new domain and keeps its path. It does so only when the old domain was listed on the Vercel project
before, or Vercel itself answers that no deployment serves it; a check on another server stays a normal Down.
Watchbell learns an app's domains every 6 hours, or right away when you press Sync; the one production is served on is
the app's Domain.

**Logs** (not for viewers). Two tabs: the last hour of request logs from Vercel, and stored errors. Vercel's free plan
keeps only a short history, so the collector copies warnings and errors every 5 minutes and keeps them for 7 days.

## Database

**Supabase.** Each project's status, region and Postgres version from the Management API, which doesn't touch your
database. Database size is read once a day, and only while the project is already active. Per project (owner only):
**Keep active** warns from day 5 without API traffic and sends one keep-alive query a day so a free project isn't
paused; **Auto-restore** brings a paused project back when its account has a free slot. **Check services** in the row
menu reads the project's service health (Auth, REST, Realtime, Storage, Database) from the Management API at once.

**Neon.** Compute state, CU-hours, storage and transfer from the Neon API. Reading them doesn't wake the compute and
Watchbell never connects to the database. Operators can wake a suspended compute.

**Firebase.** Each project's Firestore health and Auth users. Firestore has no running or stopped state, so every 5
minutes the collector reads one health document (288 of the 50,000 free daily reads); **Run health check** in the row
menu does that read at once. Reads, writes and deletes today come from Cloud Monitoring, which needs billing (Blaze):
on the free Spark plan the row says they aren't available; on Blaze they are read every hour. The stored data size
isn't read on any plan; the Open usage page link shows it (and the day's usage) in the Firebase console.

**Turso.** Databases, rows read and written and storage this month from the Turso Platform API, read hourly. The free
limits are per organization, so the meters show the organization's total.

**Upstash Redis.** Region, commands and bandwidth this month and data size from the Upstash Developer API, read hourly
with a read-only key. Watchbell never connects to Redis itself.

**Cloudflare D1.** Size from the D1 API and rows read and written today (UTC) from Cloudflare's analytics, read hourly
with the Cloudflare token. Watchbell never runs a query on a D1 database.

**SQL console** (owner only). Read-only queries against your Supabase and Neon databases, and a Firestore query
builder. See [SQL console](sql-console.md).

**Free databases.** A catalog of hosted databases you can use for free, checked against their official pricing pages,
with what Watchbell can monitor for each.

**Create requests.** The Supabase, Neon, Firebase and DNS records pages can request something new (a project, a
database, a record). A request is checked first and runs only after an owner approves it; requests waiting for
approval also show on Overview. Creating needs a token with write access for that provider (see
[Connect providers](providers.md)).

## DevOps

Under the sub-heading **Automation**:

**Repositories.** A read-only browser of the repositories your GitHub token can read: README, files, commits,
branches, Actions runs and dependency advisories. Shows "GitHub isn't connected" until you add a GitHub token.

## Manage

The menu splits Manage into three headings: **Alerting** (Alerts, Auto-actions, Status page), **Setup** (Connections,
Settings, Sections, Backups) and **AI & API** (AI Gateway, API explorer).

**Connections** (owner only). The provider accounts Watchbell reads: Vercel, Supabase, Neon, Firebase, Turso, Upstash,
Cloudflare, GitHub and the optional GitHub PR-write token, as tiles grouped by section (Hosting, Database, DevOps,
and Google Drive under Manage). A tile opens a drawer with the provider's accounts and the form to add one. Tokens are
encrypted (AES-256-GCM) with `OPS_ENCRYPTION_KEY` before they are stored and never reach the browser. **Sync** lists
everything in an account and you tick what to watch. A banner at the top lists connections that stopped working. See
[Connect providers](providers.md).

**Alerts.** Three tabs:

- Firing: what is wrong now, and what resolved in the last 7 days. Operators can silence an alert for a while.
- Rules: the built-in rules (an app down or slow, a failed deployment, a paused or nearly full database, a domain or
  certificate about to expire, an expiring token, a vulnerable dependency or Next.js version, the collector not running,
  and more), with their thresholds. Rules run after every collector run, and unknown data never opens or resolves an
  alert.
- Notifications: where alerts go. See [Notifications](notifications.md).

**Auto-actions** (owner only). Fixes Watchbell proposes for firing alerts, waiting for your approval, and a history of
what ran. See [Auto-actions](auto-actions.md).

**Sections** (owner only). Each section with a switch that shows whether it is in the menu, and one line of what it
holds. Home and Manage are always on. Database or DevOps with nothing connected yet shows off and can't be switched;
the line says what to connect. Turning Hosting, Database or DevOps off (after a confirm step; for Hosting it says that
all uptime checks and heartbeats stop) hides it from the menu and pauses its collector tasks, its alert rules, its
notifications and new auto-action proposals. Its data is kept, its pages still open from a link, and its firing
alerts stay as they are (left out of the bell, the Alerts page and the API) until you turn it on again; notices that waited go
out on the next run. Keep active and Auto-restore keep running while Database is off, so a kept Supabase project is
never paused because of the switch.

**Settings** (owner only). Tabs:

- Collector: how often each collector task runs, the database keep-alive notes, and **Watchbell runtime**: the
  Node.js this Watchbell runs on (Vercel's function runtime in the cloud edition, the machine's Node.js when
  self-hosted). Every 12 hours Watchbell reads the release list on nodejs.org and the Node.js end-of-life dates on
  endoflife.date. A version with a newer security release in its line reads, for example, "Node 24.12.0: security fix
  available (24.22.1)" with a warning; a line past its end of life reads "end of life"; otherwise "ok".
  - It says unknown, never ok, when nodejs.org hasn't been read successfully in the last 36 hours, or endoflife.date
    has never been read. A fix or end of life that is already known still shows.
  - With `WATCHBELL_NO_UPDATE_CHECK=1` set for the server, it reads nothing and says "check turned off".
  - Self-hosted with the npm package, `watchbell start` and `watchbell status` print a one-line warning as well when
    the Node.js is vulnerable or past end of life. `watchbell status` also checks the Node.js an installed service
    runs. The warning isn't printed under `WATCHBELL_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER` or `CI`, and a service
    (`watchbell run`) never prints it.
- Free tier budget: the free plan limits the meters compare against. Correct them here when a provider changes its
  free plan. Supabase slots, Neon CU-hours, QStash and cron-job.org show what Watchbell reads; Vercel's monthly usage
  and the Web Analytics event count aren't read, so those rows say "not read" (see Usage in the Vercel dashboard).
- Users: members and their roles (see [Add more people](first-run.md#add-more-people)).
- Retention: how long Watchbell keeps its own history (events, checks, rollups). Nothing is ever deleted at a
  provider.
- Status page: a public page at `/s/<address>` with one line at the top that says whether everything is running (or
  which service has a problem), the names you choose, the current state, 90-day bars and maintenance notices. The
  uptime badges for READMEs are listed here, not on the public page. It never shows addresses, error text or provider
  names. Off until you publish it; an unknown or unpublished address shows a plain "No status page here".
- Lockfile: an optional GitHub Actions workflow in a small repository of your own that builds `package-lock.json`
  for update pull requests (see [Auto-actions](auto-actions.md#automatic-security-fixes)).
- Auto-actions: which safe actions may run without asking, auto-rollback, and automatic security fixes.

**AI Gateway** (owner only). Your own AI providers and the API for your apps and agents, with its own menu: Overview,
Usage, Ask, API keys, Agents, Connect an agent, Bring your own key, Quota, Logs, Models and Playground. See
[AI](ai.md).

**API explorer** (owner only). Every endpoint of Watchbell's API (`/api/v1`) from one OpenAPI 3.1 file. Try a request
with a console API key; it runs against this Watchbell with that key's scopes and rate limit.

**Backups** (owner only). Monthly summaries saved to your Google Drive. See [Backups](backups.md).

**Status page** (owner only). Opens the Status page tab of Settings (above).

## Pages outside the menu

- `/signin`, `/mfa`: sign-in and the authenticator step.
- `/setup`: the first-run page; gone once an owner exists.
- `/account/password`: change your own password (you must be signed in and through the authenticator step). A member
  an owner added with a temporary password is sent here first after signing in and can't use the console until they
  choose their own; the temporary password also stops working after 7 days.
- `/invite`: where someone with an open invitation lands after signing in, to accept it with the role it names. In
  self-host mode owners add members directly from Settings (Add member) instead, so you won't normally see this page.
- `/s/<address>`: your public status page, if you published one.
- `/api/health`: answers `{"ok":true}` while the console runs. Point an outside uptime checker at it if Watchbell is
  reachable from outside.
