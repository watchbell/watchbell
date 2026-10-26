# Troubleshooting

Bahasa Indonesia: [id/troubleshooting.md](id/troubleshooting.md)

Start with the server log; most problems print a clear line there.

| How Watchbell runs | Where the log is |
|---|---|
| Linux service | `journalctl --user -u watchbell -f` |
| Windows Scheduled Task | `app\data\watchbell.log` |
| Started by hand | The terminal where you ran `npm run start:selfhost` |
| npm package, `watchbell` in a terminal | `~/.watchbell/logs/watchbell.log` (**Show live log** in the start menu follows it); `watchbell start --verbose` prints it in the terminal |

- [Installing](#installing)
  - [Port already in use](#port-already-in-use)
  - [Wrong Node version](#wrong-node-version)
  - [The build runs out of memory](#the-build-runs-out-of-memory)
  - [npm ci fails](#npm-ci-fails)
  - [Windows: running scripts is disabled](#windows-running-scripts-is-disabled)
  - [Upgrade refuses to pull](#upgrade-refuses-to-pull)
- [Starting](#starting)
  - [Another Watchbell is already using](#another-watchbell-is-already-using)
  - [Missing or invalid environment variables](#missing-or-invalid-environment-variables)
  - [Refusing to start with a remote DATABASE_URL](#refusing-to-start-with-a-remote-database_url)
  - [Can't find its database migrations](#cant-find-its-database-migrations)
  - [The page doesn't open](#the-page-doesnt-open)
  - [The service stops working after a Node update](#the-service-stops-working-after-a-node-update)
- [Signing in](#signing-in)
  - [Setup code lost](#setup-code-lost)
  - [Locked out](#locked-out)
- [Providers](#providers)
  - [A token is missing a permission](#a-token-is-missing-a-permission)
  - [Can't read the stored credential](#cant-read-the-stored-credential)
  - [Google says redirect_uri_mismatch](#google-says-redirect_uri_mismatch)
- [Notifications](#notifications)
  - [No notifications arrive](#no-notifications-arrive)
  - [Telegram buttons on a laptop](#telegram-buttons-on-a-laptop)
- [Alerts after the laptop slept](#alerts-after-the-laptop-slept)

## Installing

### Port already in use

The installer says the port (3100 by default) is taken, or the server stops with `EADDRINUSE`.

- Maybe Watchbell already runs: `systemctl --user status watchbell`, or look for `node` in Task Manager.
- Find what holds the port:

  ```bash
  ss -ltnp | grep 3100                       # Linux
  lsof -iTCP:3100 -sTCP:LISTEN               # macOS
  ```

  ```powershell
  Get-NetTCPConnection -LocalPort 3100 | Select-Object OwningProcess
  Get-Process -Id <OwningProcess>
  ```

- Or use another port: `bash install.sh --port 3200` (`install.bat --port 3200`) for a new install, or change `PORT` and
  `SITE_URL` in `app/.env` on an existing one (see [Change the port](configuration.md#change-the-port)).

### Wrong Node version

Watchbell needs Node 24 exactly (any 24.x). Check with `node --version`.

- **Linux and macOS with nvm:** `nvm install 24`, then `nvm use 24` (or `nvm alias default 24` to keep it).
- **Windows:** download the Node 24 Windows Installer (.msi) from https://nodejs.org/dist/latest-v24.x/ (also listed
  under v24 on https://nodejs.org/en/about/previous-releases) and run it; like any normal Windows installer it asks for
  administrator approval. If an older or newer Node is installed, remove it first in Settings › Apps › Installed apps.
  Then open a **new** terminal, so the new Node is on `PATH`, check that `node -v` shows v24, and run `install.bat`
  again. (winget's Node.js LTS package installs machine-wide, also needs administrator approval, and may pick a
  newer major version than 24, so the .msi above is the simpler route.)
- If `node --version` still shows the old version, another Node comes first on your `PATH` (`which -a node` on Linux
  and macOS, `where.exe node` on Windows).

On Linux the installer asks before installing Node 24 with nvm; if you said no, it printed these steps and stopped
without writing anything. On Windows it always prints the Node 24 download link and stops without writing anything.

### The build runs out of memory

`npm run build` stops with `JavaScript heap out of memory` or is killed. The build needs about 2 GB of free memory.
Close other programs and run the installer again. On a small Linux server, add a swap file. To give Node more memory:
`NODE_OPTIONS=--max-old-space-size=3072 bash install.sh`.

### npm ci fails

- Check your internet connection and any proxy settings (`npm config get proxy`).
- `npm ci` needs `app/package-lock.json` from the release; don't delete it.
- Delete `app/node_modules` and run the installer again.
- On Windows, a path longer than 260 characters can break the install: move the Watchbell folder closer to the drive
  root (for example `D:\watchbell`).

### Windows: running scripts is disabled

PowerShell refuses `install.ps1` with "running scripts is disabled on this system". Use `install.bat`, which allows
scripts for that one PowerShell process only, or run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Watchbell never changes your system's execution policy.

### Upgrade refuses to pull

`--upgrade` only runs `git pull --ff-only` in a git checkout whose tracked files have no local changes (new files
such as `app/.env` and `app/data` don't count). Run `git status` to see what changed. Put your changes aside with `git stash` (or commit them on a branch), then run the upgrade again. Your
`app/.env` and `app/data` are never touched by the upgrade. If you installed from a release archive, see
[Upgrade](install.md#upgrade).

## Starting

### Another Watchbell is already using

The server or `reset-login` stops with "Another Watchbell is already using …/data/pg. Stop it first."

Only one process may open the database folder at a time. Usually Watchbell is already running, for example as the
service or Scheduled Task while you also started it by hand. Stop one of them:

- `systemctl --user stop watchbell` (Linux service)
- `npm run stop:selfhost` in the `app` folder (Windows task, or any run); `Stop-ScheduledTask Watchbell` only if that
  times out, since it can interrupt the database closing
- `watchbell stop` (the npm package)
- Ctrl+C in the terminal that runs it

The lock is the file `app/data/pg/.watchpost.lock` (`~/.watchbell/data/pg/.watchpost.lock` with the npm package),
holding the process id. A lock left behind by a process that no longer exists is removed automatically, and so is one
whose process id now belongs to another program (after a crash or a power cut the id is often reused): `watchbell` and
`npm run start:selfhost` remove it before the server starts. If the id now belongs to some other Node.js program,
Watchbell can't tell it apart from itself: `watchbell` then says that nothing answers and names the file. Delete that
file by hand only if you are sure no Watchbell is running.

### Missing or invalid environment variables

`Missing or invalid environment variables: OPS_ENCRYPTION_KEY` (or another key) means `app/.env` lacks it or the value
has the wrong shape (`OPS_ENCRYPTION_KEY` must decode to exactly 32 bytes). Run the installer again: it adds missing
keys and leaves existing ones alone. If the key exists but is wrong, restore it from your backup of `app/.env`; a newly
generated key makes the saved tokens unreadable (see [Backups](backups.md#why-appenv-matters)).

"The scheduler settings are missing" (or "Missing or invalid scheduler settings") means `COLLECTOR_SECRET` or
`CRON_SECRET` is missing or too short. The installer adds them too.

### Refusing to start with a remote DATABASE_URL

"Refusing to start: WATCHBELL_MODE=selfhost with a remote or unrecognised DATABASE_URL" means `DATABASE_URL` is a
hosted Supabase database, a URL with several hosts, or one Watchbell can't parse. Self-host mode refuses those unless
you also set `WATCHBELL_ALLOW_REMOTE_DB=1`. For the local database, set `DATABASE_URL=pglite:` in `app/.env`; a normal
`postgres://user:password@localhost/dbname` is accepted as it is. See
[Using your own Postgres](configuration.md#using-your-own-postgres) if you really mean a remote one.

### Can't find its database migrations

"Watchbell can't find its database migrations in …" means the server was started from another folder. Start it from
`app/` (`cd app && npm run start:selfhost`), or set `WATCHBELL_MIGRATIONS_DIR`.

### The page doesn't open

- Is it running? Check the log.
- Use the right address: `http://localhost:3100` (or your port), not `https://`.
- From another device it only works with [LAN access](configuration.md#lan-access).
- A `PORT` or `HOST` set in the shell wins over `app/.env` (see [Start and stop](install.md#start-and-stop)). The npm
  package ignores them: it reads `~/.watchbell/.env`, and only `WATCHBELL_HOST` or `WATCHBELL_PORT` override that.

### The service stops working after a Node update

On Linux the systemd service runs the exact Node program it was created with (with nvm, a path inside
`~/.nvm/versions`). After `nvm install` of a newer 24.x, or after removing the old one, the service may fail to start
(`journalctl --user -u watchbell` shows the missing path). Run `bash install.sh` again: it rewrites the service for the
current Node and rebuilds the app. Your `app/.env` and `app/data` are kept. With the npm package, run
`watchbell service install` again after changing Node (nvm, fnm, volta): the service runs the Node it was created with.

## Signing in

### Setup code lost

Read it again from `app/data/setup-code`, or from the log. If it expired (after 24 hours) or you can't find it,
restart Watchbell: every start without an owner prints and saves a new code. Once the owner exists there is no setup
code any more; see [First run](first-run.md).

### Locked out

Forgot the password, or lost the authenticator? On the machine Watchbell runs on:

```bash
# stop Watchbell first, then in the app folder:
npm run reset-login -- you@example.com
```

With the npm package, run `watchbell stop` and then `watchbell reset-login you@example.com` instead.
It prints a temporary password (valid 7 days), removes the authenticator and ends the account's sessions. Start
Watchbell, sign in with the temporary password, pick a new one and set up the authenticator again. If it says
"Watchbell is running on …", stop Watchbell first. If it says "No Watchbell database in …", run it in the `app` folder
(or set `WATCHBELL_DATA_DIR`). Details in [First run](first-run.md#locked-out).

## Providers

### A token is missing a permission

The provider answers that the token can't do something, for example:

- "missing database_write" when setting up the Supabase SQL role automatically;
- "This Supabase token can't create projects" (`organization_projects_create`);
- "This Cloudflare token can't add DNS records" (DNS Edit).

Reading still works; only that action needs more. Create a new token with the extra permission listed in
[Connect providers](providers.md), then use **Replace credential** on Connections. Or do that one step by hand at the
provider (for the SQL role, the dialog shows the SQL to run yourself).

### Can't read the stored credential

"Can't read the stored credential. The encryption key changed." means `OPS_ENCRYPTION_KEY` in `app/.env` is not the
one the token was saved with. Put the original key back from your backup, or use Replace credential on each
connection.

### Google says redirect_uri_mismatch

The Authorized redirect URI in your Google OAuth client must be exactly `SITE_URL` + `/auth/google/callback`, for
example `http://localhost:3100/auth/google/callback`. Check the port and `http` versus `https`. Google allows plain
`http` only for `localhost`. See [Backups](backups.md#set-up-your-own-google-oauth-client).

## Notifications

### No notifications arrive

On **Alerts › Notifications**:

- The channel shows a note like "TELEGRAM_BOT_TOKEN isn't set": add the key to `app/.env` and restart.
- The channel is **Off**: turn it on.
- "The last send failed: …" shows the provider's reason (a revoked bot token, a deleted Discord webhook, an unverified
  Resend domain).
- Press **Send test**.

Also check the [quiet rules](notifications.md#quiet-rules): while the collector is stale, during a maintenance window,
for a silenced alert or for apps behind a paused database, nothing is sent on purpose.

### Telegram buttons on a laptop

Approve and Reject on a Telegram message do nothing, or answer late:

- **Watchbell isn't running.** A laptop has no public address, so Watchbell fetches button presses from Telegram
  itself while it runs. Presses made while it is stopped or asleep are handled when it is back (Telegram keeps them up
  to 24 hours).
- **Approval buttons are off.** Alerts › Notifications › Telegram › Approval buttons › Turn on.
- **Your Telegram account isn't linked.** Only the linked account can use the buttons: press Show link code and send
  `/link <code>` in the connected chat.
- **The log says "Telegram has a webhook set".** Something else receives this bot's updates: a webhook set by another
  install, or another program reading the same bot. Use a separate bot for this Watchbell, or turn the approval
  buttons off and on again here (that removes the webhook, which breaks the other install).
- **A risky action** needs a second tap on "Sure? Approve" within 2 minutes.

You can always approve on the Auto-actions page instead.

## Alerts after the laptop slept

While the machine sleeps or Watchbell is stopped, nothing is checked. After it wakes, a **CollectorStale** alert may
fire briefly and resolve after the next good runs; other alerts are muted while it fires. A missed daily job runs once
on wake-up. For monitoring that never sleeps, run Watchbell on a machine that stays on.
