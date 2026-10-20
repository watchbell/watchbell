# Changelog

All notable changes to Watchbell are listed here. Versions follow [Semantic Versioning](https://semver.org).

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
