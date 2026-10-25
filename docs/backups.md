# Backups

Bahasa Indonesia: [id/backups.md](id/backups.md)

There are two different things to keep safe:

1. **Watchbell itself**: the `app/data` folder (its database) and `app/.env` (its settings and the encryption key),
   or `~/.watchbell/data` and `~/.watchbell/.env` with the npm package. This is what you restore after a broken disk or
   when you move to another machine.
2. **Monthly summaries in Google Drive** (optional): a readable record of each month (uptime, incidents, databases,
   domains), kept outside your machine. These are reports, not a copy of the database.

- [Back up Watchbell itself](#back-up-watchbell-itself)
- [Restore or move to another machine](#restore-or-move-to-another-machine)
- [Monthly summaries in Google Drive](#monthly-summaries-in-google-drive)
- [Set up your own Google OAuth client](#set-up-your-own-google-oauth-client)

## Back up Watchbell itself

Stop Watchbell first: copying the database folder while it is open can give you a broken copy. Run these from the
Watchbell folder.

**Linux:**

```bash
systemctl --user stop watchbell
tar czf ~/watchbell-backup-$(date +%F).tar.gz -C app data .env
systemctl --user start watchbell
```

**Windows (PowerShell):**

```powershell
cd app; npm run stop:selfhost; cd ..
Compress-Archive -Path app\data, app\.env -DestinationPath "$HOME\watchbell-backup-$(Get-Date -Format yyyy-MM-dd).zip"
Start-ScheduledTask Watchbell
```

If you start Watchbell by hand, stop it with Ctrl+C (or `npm run stop:selfhost` in `app/`) instead, and start it
again with `npm run start:selfhost`. Only if `npm run stop:selfhost` times out on Windows, use
`Stop-ScheduledTask Watchbell`.

Keep the backup somewhere other than the same disk. It contains `app/.env`, so it contains your encryption key:
store it like a password.

### Why app/.env matters

`OPS_ENCRYPTION_KEY` in `app/.env` encrypts every provider token, the Google Drive connection, the Discord webhook and
every authenticator secret in the database. A copy of `app/data` without the matching key still opens,
but:

- every connection shows "Can't read the stored credential" until you replace its token;
- Google Drive has to be connected again;
- authenticator codes stop working, so every owner and operator needs `npm run reset-login -- <email>` (see
  [First run](first-run.md#locked-out)).

Passwords themselves are stored as one-way hashes and keep working.

### With the npm package

With `npm install -g watchbell` the database and the settings are in `~/.watchbell/` (`%USERPROFILE%\.watchbell\` on
Windows, or the folder `WATCHBELL_HOME` names): `data/` and `.env`. The same rules apply: stop Watchbell, copy both,
start it again.

**Linux and macOS:**

```bash
watchbell stop
tar czf ~/watchbell-backup-$(date +%F).tar.gz -C ~/.watchbell data .env
watchbell
```

**Windows (PowerShell):**

```powershell
watchbell stop
Compress-Archive -Path "$HOME\.watchbell\data", "$HOME\.watchbell\.env" -DestinationPath "$HOME\watchbell-backup-$(Get-Date -Format yyyy-MM-dd).zip"
watchbell
```

If you set it up with `watchbell service install`, use the commands it printed instead: on Linux
`systemctl --user stop watchbell` and `systemctl --user start watchbell`; on Windows and macOS `watchbell stop`, and
log out and in again (or run `watchbell`) to start it. `watchbell status` shows whether it is still running and which
folders it uses.

## Restore or move to another machine

1. Install Watchbell on the new machine as described in [Install](install.md), but before running the installer, put
   your saved `.env` at `app/.env` and your saved `data` folder at `app/data`:

   ```bash
   tar xzf ~/watchbell-backup-2026-10-01.tar.gz -C app
   bash install.sh
   ```

   ```powershell
   Expand-Archive watchbell-backup-2026-10-01.zip -DestinationPath app
   .\install.bat
   ```

   The installer keeps every value already in `app/.env` and only adds missing keys.
2. If the address changes (another port, or LAN access), update `SITE_URL` in `app/.env`, and the redirect URIs of
   your Google OAuth client if you use one.
3. Start Watchbell and sign in with your usual account.

With the npm package: install it (`npm install -g watchbell`), unpack the backup into `~/.watchbell/` before the first
start (`tar xzf ~/watchbell-backup-2026-10-01.tar.gz -C ~/.watchbell`, or `Expand-Archive` to
`$HOME\.watchbell` on Windows), then run `watchbell`. The first start keeps every value already in `.env` and only
adds missing keys.

To restore on the same machine: stop Watchbell, move the current `app/data` aside, unpack the backup into `app`, and
start Watchbell again. Restore with the same Watchbell version that made the backup, or a newer one: database
changes for a newer version are applied automatically when it starts, but nothing undoes them for an older one.

## Monthly summaries in Google Drive

**Backups** (owner only) saves a summary of each month to your Google Drive, in a folder called **Watchbell
backups**:

| File | What is in it |
|---|---|
| Summary sheet (Google Sheets) | Tabs: Overview (uptime, incidents and deployments for the month), Applications (uptime %, p95 response, 5xx count, deploys per app), Incidents (every alert with start, end and duration), Databases (status changes, size, CU-hours, Firestore reads), Domains (certificate and registrar expiry at month end) |
| Raw data `.csv.gz` | That month's hourly rollups and events |

- It runs by itself on the 1st of each month with the daily job (about 03:00 in your time zone) and covers the month before. A run
  that failed is retried by the next daily run. **Back up now** writes the current month so far.
- Backups older than 3 months are moved to Drive trash, and Drive deletes them for good 30 days later.
- Databases appear by their alias (db-a, db-b) and emails are hidden, as everywhere in the console.
- Watchbell asks Google only for the `drive.file` permission: it can see and change only the files it created, never
  the rest of your Drive. You can remove its access any time in your Google Account settings.

The summaries are for reading and keeping history. Watchbell can't import them back; to restore Watchbell use the
backup of `app/data` and `app/.env` above.

## Set up your own Google OAuth client

Watchbell connects to Drive with an OAuth client that you create in your own Google Cloud project. It is free.

1. Open https://console.cloud.google.com and create a project (or pick one).
2. **APIs & Services › Library**: enable the **Google Drive API**.
3. **Google Auth Platform** (called **OAuth consent screen** in some accounts): set it up with user type **External**,
   an app name such as "Watchbell", and your email. Add the scope `.../auth/drive.file`.
4. Set the publishing status to **In production**. In "Testing" status Google ends the connection after 7 days and
   you would have to reconnect every week. `drive.file` is a non-sensitive scope, so publishing needs no review by
   Google.
5. **Credentials › Create credentials › OAuth client ID**, type **Web application**. Under **Authorized redirect
   URIs** add:

   ```text
   http://localhost:3100/auth/google/callback
   ```

   Use your own `SITE_URL` with `/auth/google/callback` at the end if it differs. Google accepts plain `http://` only
   for `localhost`; for any other address `SITE_URL` must be `https://`. If you also want to create Firebase projects
   from Watchbell, add `<SITE_URL>/auth/google/create/callback` too (see [Providers](providers.md#firebase)).
6. Copy the client ID and secret into `app/.env` and restart Watchbell:

   ```bash
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```

7. In Watchbell: **Backups › Connect Google Drive**, approve the one permission, and you're done.

If Google answers `redirect_uri_mismatch`, the redirect URI in step 5 doesn't exactly match `SITE_URL` plus
`/auth/google/callback` (check the port and the `http`/`https`).
