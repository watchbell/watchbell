# Pages

The left menu groups the pages the way the console does. Some pages are for owners only; operators and viewers don't
see them in the menu (see [roles](first-run.md#add-more-people)). Press Ctrl+K (Cmd+K on a Mac) anywhere to jump to a
page by name.

Watchbell reads your providers on a schedule of its own: a collector run every minute (each task only when its own
interval has passed) and a daily job at 03:00 in your [time zone](configuration.md#time-zone). Nothing runs while the
machine is asleep or Watchbell is stopped; a missed daily job runs once when it is back. Times on these pages and in
messages are in that zone.

- [Home](#home)
- [Workloads](#workloads)
- [GitHub](#github)
- [Network](#network)
- [Databases](#databases)
- [Observe](#observe)
- [Automation](#automation)
- [AI and API](#ai-and-api)
- [Administration](#administration)
- [Pages outside the menu](#pages-outside-the-menu)

## Home

**Welcome.** Shown while nothing is connected: the first steps (connect Vercel, pick the apps to watch, add your
databases), each ticked off as you do it.

**Overview.** The state of everything at a glance: banners for connections that need attention and for problems found
by the collector, creates waiting for approval, and every watched application with its uptime, latest deployment and
linked database. Operators and owners get a Refresh button that runs the collector now.

**Topology.** A map of how each domain reaches an app and which database each app uses. Domains come from Vercel;
database links come from each app's Edit link. Select a node for its details.

**Events.** Every change the collector noticed and every action someone took, newest first. New ones appear while the
page is open; a change that repeats within an hour is counted on one row. This is also the audit log: approvals,
auto-runs, sign-in related changes and setting changes are here.

## Workloads

**Applications.** Your Vercel projects that you chose to watch, with their database, domain and uptime. Open one for:

- Details: status, response time, page views, 5xx responses, uptime, security advisories for its dependencies, and its
  GitHub repository and Actions status when GitHub is connected.
- Metrics, Deployments and Logs tabs for that app.
- Actions for operators and owners: redeploy, roll back, check now.

**Deployments.** Recent deployments of the watched apps, read from the Vercel API. Vercel's free Hobby plan can only
roll back to the previous production deployment.

## GitHub

**Repositories.** A read-only browser of the repositories your GitHub token can read: README, files, commits,
branches, Actions runs and dependency advisories. Shows "GitHub isn't connected" until you add a GitHub token.

## Network

**Domains.** Every domain of a watched app: DNS from Cloudflare, configuration from Vercel, registration expiry from
RDAP, and certificate expiry from Watchbell's own TLS check. Warns when a domain is proxied through Cloudflare in front
of Vercel and, for owners, offers a one-click "Set DNS only". Re-check reads a certificate again.

**DNS records.** The records of each Cloudflare zone you watch, with the zone's details. Owners can edit a record or
add one (as a create request, below); both need the DNS Edit permission on the Cloudflare token. Records are never
deleted from here.

## Databases

**Supabase.** Each project's status, region and Postgres version from the Management API, which doesn't touch your
database. Database size is read once a day, and only while the project is already active. Per project (owner only):
**Keep active** warns from day 5 without API traffic and sends one keep-alive query a day so a free project isn't
paused; **Auto-restore** brings a paused project back when its account has a free slot.

**Neon.** Compute state, CU-hours, storage and transfer from the Neon API. Reading them doesn't wake the compute and
Watchbell never connects to the database. Operators can wake a suspended compute.

**Firebase.** Firestore usage of each project. Firestore has no running or stopped state, so every 5 minutes the
collector reads one health document (288 of the 50,000 free daily reads). The stored data size isn't readable on the
free Spark plan.

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

## Observe

**Uptime.** HTTP checks (every minute) and heartbeats. A heartbeat waits for your own job to call its ping address,
`<SITE_URL>/api/ping/<token>` (add `/start` or `/fail` to report those states), and alerts when a ping is late. Also
maintenance windows (one-off or weekly): checks keep running inside a window but open no alerts and don't count
against uptime.

**Alerts.** Three tabs:

- Firing: what is wrong now, and what resolved in the last 7 days. Operators can silence an alert for a while.
- Rules: the built-in rules (an app down or slow, a failed deployment, a paused or nearly full database, a domain or
  certificate about to expire, an expiring token, a vulnerable dependency, the collector not running, and more), with
  their thresholds. Rules run after every collector run, and unknown data never opens or resolves an alert.
- Notifications: where alerts go. See [Notifications](notifications.md).

**Logs** (not for viewers). Two tabs: the last hour of request logs from Vercel, and stored errors. Vercel's free plan
keeps only a short history, so the collector copies warnings and errors every 5 minutes and keeps them for 7 days.

**Provider status.** Public status feeds of Vercel, Supabase, Neon, Cloudflare, Firebase and Google Cloud, polled
every 5 minutes. When a provider has an incident, related alerts are labelled so you know the problem
isn't your app.

## Automation

**Auto-actions** (owner only). Fixes Watchbell proposes for firing alerts, waiting for your approval, and a history of
what ran. See [Auto-actions](auto-actions.md).

## AI and API

**AI Gateway** (owner only). Your own AI providers and the API for your apps and agents, with its own menu: Overview,
Usage, Ask, API keys, Agents, Connect an agent, Bring your own key, Quota, Logs, Models and Playground. See
[AI](ai.md).

**API explorer** (owner only). Every endpoint of Watchbell's API (`/api/v1`) from one OpenAPI 3.1 file. Try a request
with a console API key; it runs against this Watchbell with that key's scopes and rate limit.

## Administration

**Connections** (owner only). The provider accounts Watchbell reads: Vercel, Supabase, Neon, Firebase, Turso, Upstash,
Cloudflare, GitHub and the optional GitHub PR-write token. Tokens are encrypted (AES-256-GCM) with
`OPS_ENCRYPTION_KEY` before they are stored and never reach the browser. **Sync** lists everything in an account and
you tick what to watch. A banner at the top lists connections that stopped working. See
[Connect providers](providers.md).

**Backups** (owner only). Monthly summaries saved to your Google Drive. See [Backups](backups.md).

**Settings** (owner only). Tabs:

- Collector: how often each collector task runs, and the database keep-alive notes.
- Free tier budget: the free plan limits the meters compare against. Correct them here when a provider changes its
  free plan.
- Users: members and their roles (see [Add more people](first-run.md#add-more-people)).
- Retention: how long Watchbell keeps its own history (events, checks, rollups). Nothing is ever deleted at a
  provider.
- Status page: a public page at `/s/<address>` with the names you choose, the current state, 90-day bars and
  maintenance notices, plus uptime badges for READMEs. It never shows addresses, error text or provider names. Off
  until you publish it.
- Lockfile: an optional GitHub Actions workflow in a small repository of your own that builds `package-lock.json`
  for update pull requests (see [Auto-actions](auto-actions.md#automatic-security-fixes)).
- Auto-actions: which safe actions may run without asking, auto-rollback, and automatic security fixes.

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
