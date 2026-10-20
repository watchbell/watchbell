# FAQ

### Does Watchbell cost anything?

No. Watchbell is free and open source (MIT). It runs on your own machine and needs no account with anyone to start.
The providers it watches are your own accounts; Watchbell is built around their free plans and reads them through
their APIs. AI features use your own AI provider key, and the email digest your own Resend account.

### Does my data leave my machine?

Your data stays in `app/data` on your machine. Watchbell talks only to the providers you connect (to read them and,
when you ask, to act), to the notification services you set up, to your AI provider and Google Drive if you set them
up, and to public status pages and RDAP for domain expiry. There is no telemetry and nothing is sent to the Watchbell project.

### Can I run it on a server instead of a laptop?

Yes. The same installer works on a Linux server. Run `loginctl enable-linger "$USER"` so the service keeps running
without a login session, and use a reverse proxy with HTTPS if you want to reach it from elsewhere (see
[Behind a reverse proxy](configuration.md#behind-a-reverse-proxy)).

### What happens when my laptop sleeps or is off?

Nothing is checked while Watchbell isn't running. When it is back, the collector catches up, a missed daily job runs
once, and Telegram button presses made meanwhile are handled. For checks around the clock, run it on a machine that
stays on.

### Is there a Docker image?

Not in version 1.0. Use the installers or the [manual steps](install.md#macos-and-manual-installs).

### Is there an installer for macOS?

No; follow the [manual steps](install.md#macos-and-manual-installs). They take a few minutes.

### Can several people use one Watchbell?

Yes. The owner adds members with the roles owner, operator or viewer on Settings › Users (see
[Add more people](first-run.md#add-more-people)). They need to reach the machine, so you'll want
[LAN access](configuration.md#lan-access) or a reverse proxy.

### Can I use it from my phone?

Telegram is the easiest way: alerts and approve/reject buttons work from anywhere, even though Watchbell runs on your
laptop. Opening the console itself from a phone needs [LAN access](configuration.md#lan-access) on the same network,
or a reverse proxy.

### Which hosting providers does it support?

Apps on Vercel; databases on Supabase, Neon, Firebase (Firestore), Turso, Upstash Redis and Cloudflare D1; domains
and DNS on Cloudflare; repositories on GitHub. Uptime checks and heartbeats work for any HTTP address and any job that
can make an HTTP request to Watchbell.

### Can heartbeats from my cron jobs reach a laptop?

Only if the job can reach Watchbell's address. A job on the same machine can call `http://localhost:3100/api/ping/<token>`.
Jobs elsewhere need the console to be reachable (LAN access or a reverse proxy).

### Why are times shown in WIB?

Watchbell's schedules (the daily job at 03:00, the email digest at 07:00, advisor notes at 07:00 and 19:00) and the
times in messages use Western Indonesian Time (WIB, UTC+7, no daylight saving), the time zone it was first written
for. The time zone isn't a setting yet.

### Can I change the language?

Messages sent to Telegram, Discord and email can be in English or Bahasa Indonesia, per channel. The console itself is
in English.

### I lost OPS_ENCRYPTION_KEY. What now?

Saved tokens and authenticator secrets can't be decrypted without it. Put a new key in `app/.env`, restart, replace
each credential on Connections, reconnect Google Drive, and reset each owner and operator with
`npm run reset-login -- <email>` so they can set up their authenticator again. Your history (events, uptime, alerts)
is kept. See [Backups](backups.md#why-appenv-matters).

### How do I update?

See [Upgrade](install.md#upgrade).

### How do I report a bug or a security problem?

Bugs: open an issue on GitHub. Security problems: report them privately, as described in the
[security policy](../SECURITY.md).

### Is there a demo?

Not yet. A live demo with made-up data is coming soon. Until then, the screenshots in the
[README](../README.md) all come from Watchbell's demo mode.
