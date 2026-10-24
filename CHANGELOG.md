# Changelog

All notable changes to Watchbell are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
