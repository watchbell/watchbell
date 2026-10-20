# Configuration

Watchbell reads its settings from `app/.env`. The installer creates the file with safe defaults and fresh secrets;
[`app/.env.example`](../app/.env.example) lists every key with a comment. Restart Watchbell after you change the file.

- [Editing app/.env](#editing-appenv)
- [Core settings](#core-settings)
- [Optional settings](#optional-settings)
- [Cloud-only settings](#cloud-only-settings)
- [Change the port](#change-the-port)
- [LAN access](#lan-access)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [Using your own Postgres](#using-your-own-postgres)

## Editing app/.env

- One `KEY=value` per line, no spaces around `=`. Quotes are not needed.
- The file holds secrets. Keep it readable by you only (the Linux installer sets mode 600; the Windows installer limits
  it to your Windows user), never commit it, and keep a copy in a safe place (see [Backups](backups.md)).
- Don't use `app/.env.local` for a self-hosted install. Under `npm run start:selfhost`, the Linux service and the
  Windows task, the values from `app/.env` are already in the environment when Next.js starts, so `app/.env.local`
  can only add keys that `app/.env` lacks; it can't change one. At build time (`npm run build`) it is the other way
  round: Next.js lets `app/.env.local` win for `NEXT_PUBLIC_*` values, so the two files could disagree. Keep every
  setting in `app/.env`.
- Restart after a change: `systemctl --user restart watchbell` (Linux service); `npm run stop:selfhost` in `app\`
  then `Start-ScheduledTask Watchbell` (Windows task); or Ctrl+C and `npm run start:selfhost` (by hand).
- The service, the Scheduled Task and `npm run start:selfhost` all read `app/.env`. When you start Watchbell by hand,
  a setting given in the shell wins over the file (see [Install](install.md#start-and-stop)).
- `npm run reset-login` doesn't read `app/.env` at all. If you changed `WATCHBELL_DATA_DIR` or `DATABASE_URL`, set
  them in the shell when you run it.

## Core settings

The installer writes all of these.

Settings whose name starts with `WATCHBELL_` (`WATCHBELL_MODE`, `WATCHBELL_DATA_DIR` and the others below) were
called `WATCHPOST_*` while the product was still named Watchpost. Watchbell reads the new name first and falls back to
the old one, so an `app/.env` from an earlier install keeps working without any change; the installers don't add a
second line under the new name when the old one is there.

| Key | Default | What it does |
|---|---|---|
| `WATCHBELL_MODE` | `selfhost` | Runtime mode. `selfhost` is one machine with a local database and the built-in scheduler. (`cloud` is the hosted Vercel + Supabase deployment and `demo` a read-only sandbox; neither is for a self-hosted install.) |
| `DATABASE_URL` | `pglite:` | The local PGlite database in `WATCHBELL_DATA_DIR`. See [Using your own Postgres](#using-your-own-postgres). |
| `WATCHBELL_DATA_DIR` | `./data` | Folder for the database and the setup code, relative to `app/`. Back this folder up. |
| `HOST` | `127.0.0.1` | The network interface Watchbell listens on. `127.0.0.1` means this machine only. See [LAN access](#lan-access). |
| `PORT` | `3100` | The port Watchbell listens on. |
| `SITE_URL` | `http://localhost:3100` | The address you open Watchbell at. Used for links in alerts, the status page and badges, the MCP and API examples, and as the base of OAuth redirect addresses. Must match `HOST` and `PORT` from the user's point of view. |
| `OPS_ENCRYPTION_KEY` | generated | 32 random bytes, base64. Encrypts every saved token, webhook and authenticator secret. **Never change or lose it**: a different key makes all of them unreadable. Generate one by hand with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. |
| `COLLECTOR_SECRET` | generated | At least 32 characters. Lets an outside scheduler call `POST /api/collect` with `Authorization: Bearer <secret>`. The built-in scheduler doesn't need it, but without it that route stays off. |
| `CRON_SECRET` | generated | At least 16 characters. Lets `GET /api/daily` run the daily job with `Authorization: Bearer <secret>`; the "Rerun daily job" auto-action uses it. |

Generate a new `COLLECTOR_SECRET` or `CRON_SECRET` with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Unlike the encryption key, these two
can be changed at any time.

## Optional settings

| Key | What it does |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot's token from @BotFather. Turns the Telegram channel on (see [Notifications](notifications.md#telegram)). |
| `RESEND_API_KEY` | A Resend API key with sending access (starts with `re_`), for the daily email digest. |
| `DIGEST_FROM` | The From address of the digest, on a domain verified in Resend, for example `Watchbell <noreply@your-domain.example>`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Your own Google OAuth client, for [Backups](backups.md#set-up-your-own-google-oauth-client) and for creating Firebase projects. |
| `DAILY_HEARTBEAT_TOKEN` | The token of a heartbeat you add on Uptime (period 1 day, grace 6 hours). The daily job then pings it, so a daily job that never runs raises an alert like any missed job. |
| `WATCHBELL_TRUSTED_PROXY_HOPS` | How many reverse proxies in front of Watchbell add a trusted `X-Forwarded-For` entry. Leave unset without a proxy. See [Behind a reverse proxy](#behind-a-reverse-proxy). |
| `WATCHBELL_MIGRATIONS_DIR` | Folder with the database migrations, only needed if you start the server from outside `app/` (default `drizzle-selfhost`). |
| `WATCHBELL_ALLOW_REMOTE_DB` | Set to `1` to allow a remote Postgres in `DATABASE_URL` that Watchbell would otherwise refuse (a hosted Supabase database, or an address it can't check). |

Each notification setting is independent: a missing one only turns its channel off, with a note on Alerts ›
Notifications.

## Cloud-only settings

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `OWNER_EMAIL`,
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` belong to the hosted
`cloud` mode. Leave them empty on a self-hosted install. Watchbell checks them only if you set them.

## Change the port

1. In `app/.env`, change both `PORT` and `SITE_URL`:

   ```bash
   PORT=3200
   SITE_URL=http://localhost:3200
   ```

2. Restart Watchbell.
3. If you use Google Drive backups, add the new redirect URI to your Google OAuth client (see
   [Backups](backups.md#set-up-your-own-google-oauth-client)).

The installer's `--port` (`-Port` on Windows) does the same for a new install.

## LAN access

By default Watchbell listens on `127.0.0.1`, so only the machine it runs on can open it. To open it from your phone or
another computer on the same network:

1. In `app/.env`:

   ```bash
   HOST=0.0.0.0
   SITE_URL=http://192.168.1.20:3100
   ```

   Use the machine's own address on your network instead of `192.168.1.20` (`ip addr` on Linux, `ipconfig` on
   Windows, System Settings › Network on macOS). A fixed address, set in your router, keeps the links in alerts
   working.
2. Restart Watchbell.
3. Allow the port in the machine's firewall yourself if it blocks it (for example `sudo ufw allow 3100/tcp` on
   Ubuntu, or allow Node.js when Windows asks). The installers never change the firewall.

Understand the risk before you do this:

- **Anyone on that network can reach Watchbell**: the sign-in page, the setup page if no owner exists yet, the API,
  heartbeat pings and the status page. Use it only on a network you trust, never on public Wi-Fi. Finish the first-run
  setup before you open it.
- **The connection is plain HTTP**: passwords, authenticator codes and session cookies cross the network
  unencrypted, so anyone on the same network can read them. For anything beyond a home network, keep
  `HOST=127.0.0.1` and put an HTTPS reverse proxy in front instead (next section).
- Google accepts plain `http://` redirect addresses only for `localhost`, so Google Drive can't be connected through
  a `http://192.168…` address. Connect it once from the machine itself (with `SITE_URL` on `localhost`), or use HTTPS.

## Behind a reverse proxy

To reach Watchbell over HTTPS (for example from outside your home), run a reverse proxy such as Caddy or nginx on the
same machine, keep `HOST=127.0.0.1`, and set:

```bash
SITE_URL=https://watchbell.your-domain.example
WATCHBELL_TRUSTED_PROXY_HOPS=1
```

`WATCHBELL_TRUSTED_PROXY_HOPS` is the number of proxies in front of Watchbell that append the client address to
`X-Forwarded-For`. With it set, sign-in and setup rate limits work per client address; without it, any address a
client sends is ignored and only the overall limits apply. Don't set it without a proxy: clients could then fake their
address. With an `https://` `SITE_URL`, session cookies are marked Secure.

Exposing Watchbell to the internet is your decision and your responsibility; keep it updated and use strong passwords
and the authenticator.

## Using your own Postgres

The local PGlite database is the tested and supported setup, and it is enough for one person or a small team.
`DATABASE_URL` can point at a Postgres server instead (`postgres://user:password@host:5432/dbname`), but in this
version that is for advanced users only:

- Watchbell doesn't create its tables there by itself. PGlite gets them applied automatically at start; an external
  database needs the migrations in `app/drizzle-selfhost` applied by you first.
- The connection always uses SSL, so the server must accept SSL connections.
- A hosted Supabase database is refused in self-host mode, as is any address Watchbell can't check, unless you also set
  `WATCHBELL_ALLOW_REMOTE_DB=1`.
- URL-encode special characters in the password (`# @ [ ] / ? :`).
