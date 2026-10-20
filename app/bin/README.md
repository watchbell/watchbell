# Watchbell

![Watchbell Overview](https://raw.githubusercontent.com/watchbell/watchbell/main/docs/images/overview-dark.png)

Watchbell is a self-hosted ops console: uptime checks, alerts and your providers' status in one place, on your own
machine. This package is the prebuilt server with a built-in database (PGlite), started by one command. Installing it
runs no build and no install script.

## Install and start

Needs Node.js 24 or newer.

```bash
npm install -g watchbell
watchbell
```

The first start creates `~/.watchbell/` (on Windows `%USERPROFILE%\.watchbell\`):

- `.env`: your settings, with new secrets (readable by your user only). Never lose `OPS_ENCRYPTION_KEY`: it encrypts
  the tokens you save.
- `data/`: the database (readable by your user only).

Then it prints the address (http://localhost:3100) and a one-time setup code, and opens `/setup` in your browser,
where you create the owner account. `watchbell --no-open` skips the browser. Set `WATCHBELL_HOME` to keep the settings
and data in another folder. Nothing is written inside the npm folder.

## Commands

| Command | What it does |
| --- | --- |
| `watchbell` | Start (the default command; `watchbell start` is the same). `--no-open`: don't open the browser. |
| `watchbell --host <addr> --port <n>` | Listen on this address and port for this run (with `start` or `run`). `0.0.0.0` opens it to your network: see [From another computer](#from-another-computer). |
| `watchbell run` | Start in the foreground for a service manager: never opens a browser (the service uses it). |
| `watchbell stop` | Stop the running Watchbell cleanly (`--timeout <seconds>`, default 30). |
| `watchbell status` | Is it running, at which address, which folders. Exit code 0 when it runs, 3 when it doesn't. Also warns when the installed service runs a Node.js that no longer exists. |
| `watchbell service install` | Start Watchbell when you log in: a systemd user service on Linux, a per-user Scheduled Task on Windows, a launchd agent (`~/Library/LaunchAgents/watchbell.plist`) on macOS. No admin rights. Asks first; `--yes` confirms. |
| `watchbell service uninstall` | Remove that service or task. Settings and data stay. |
| `watchbell update` | Update to the latest version with the npm next to your Node.js. A service installed with `watchbell service install` is stopped first and started again after; a Watchbell started in a terminal must be stopped first. |
| `watchbell reset-login <email>` | Give an account a new temporary password and remove its authenticator (run it while Watchbell is stopped). |
| `watchbell start --new-key` | Only when `OPS_ENCRYPTION_KEY` was lost: start with a new one (tokens saved with the old key must be entered again). |
| `watchbell --version`, `--help` | Version, help. |

## Settings

Edit `~/.watchbell/.env` and restart. `HOST` (default `127.0.0.1`, this machine only) and `PORT` (default `3100`) set
where it listens; change `SITE_URL` with them. These three come from the file only: a `HOST` or `PORT` your shell
exports (tcsh sets `HOST` to the machine's name, many developer setups export `PORT`) is ignored, so it can't put
Watchbell on your network or another port by accident. To override the file on purpose, set `WATCHBELL_HOST`,
`WATCHBELL_PORT` or `WATCHBELL_SITE_URL` (`WATCHBELL_PORT=3200 watchbell`; the address it prints and opens follows).
Other variables set in the environment win over the file, except `DATABASE_URL`, which is read from the file only, so
a database URL exported in your shell is never used by accident. Without `DATABASE_URL` Watchbell uses its built-in
database in `data/`.

The first start also writes `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, a key of this install for Next.js Server Functions
(without it every install of the prebuilt server would share the build's key). It is added when missing and never
changed. Next.js's draft-mode keys stay those of the build; Watchbell does not use draft mode.

The first start also writes `WATCHBELL_TIMEZONE`, this computer's time zone: times, the daily job (03:00) and the
email digest (07:00) follow it. A `.env` from 1.0 stays on Western Indonesian Time (WIB) until you add the line, for
example `WATCHBELL_TIMEZONE=Europe/Berlin`, and restart. Use a full name such as `Europe/Berlin` or `Asia/Kolkata`
(or `UTC`); an abbreviation such as `CET` or `IST` is not accepted and means WIB, with a warning.

Never lose `OPS_ENCRYPTION_KEY`. If it goes missing while `data/` holds a database, Watchbell refuses to start and asks
you to put it back from your backup (or to start over with `watchbell start --new-key`).

## From another computer

Watchbell listens on this machine only. The safest way in from another computer is an SSH tunnel:
`ssh -N -L 3100:127.0.0.1:3100 you@the-watchbell-machine`, then open http://localhost:3100 there.

`watchbell --host 0.0.0.0` opens it to your network for one run. It prints the addresses other computers can use and a
warning: finish `/setup` first, keep it to networks you trust, and put HTTPS in front (a reverse proxy) before it
faces the internet. Sign-in works from those addresses; set `SITE_URL` in `~/.watchbell/.env` to one of them so links
in alerts work there too. To keep it, set `HOST` (and `PORT`) in the file; the service reads the file.

## Backups

Copy the whole `~/.watchbell/` folder (or your `WATCHBELL_HOME`) while Watchbell is stopped: `.env` and `data/`
belong together.

## If it says it is already running

After a crash or a power cut the database lock (`~/.watchbell/data/pg/.watchpost.lock`) can stay behind. `watchbell`
removes it by itself when its process id now belongs to another program. If it says the database is locked but no
Watchbell answers, and you are sure none runs, delete the file it names and start again.

## Updating and removing

`watchbell update` updates the program (it runs `npm install -g watchbell@latest`); your settings and data stay in
`~/.watchbell/`. A service installed with `watchbell service install` is stopped and started again for it; a
Watchbell started in a terminal must be stopped first (`watchbell stop`). When npm's global folder belongs to root,
stop Watchbell and run `sudo npm install -g watchbell@latest`.

From 1.0.x, update once by hand, because 1.0 has no `watchbell update`: `watchbell stop` (or stop the service you set
up), then `npm install -g watchbell@latest`, then start it again. From 1.1 on, `watchbell update` does it.

There is no telemetry. `watchbell` and `watchbell status` ask registry.npmjs.org at most once a day whether a newer
version exists (a plain request for the version number, nothing about you) and say so in one line.
`WATCHBELL_NO_UPDATE_CHECK=1` in `~/.watchbell/.env` or in the environment (or `NO_UPDATE_NOTIFIER=1`, or `CI`) turns
that off.

To remove Watchbell: `watchbell service uninstall` (if you installed the service), `npm uninstall -g watchbell`, then
delete `~/.watchbell/` if you no longer want the data.

The service runs the Node.js it was installed with. After changing Node (nvm, fnm, volta, Homebrew) or reinstalling
watchbell under another Node, run `watchbell service install` again; `watchbell status` says so when the service's
Node.js is gone. On Windows and macOS the service writes its output to `~/.watchbell/watchbell.log`, which grows;
delete it now and then while Watchbell is stopped.

A service that keeps failing stops trying: systemd after 5 starts in 2 minutes, the Scheduled Task after 3 restarts,
and the launchd agent (at most one start a minute) after 5 failures in 10 minutes or at once when the start can't work
(port taken, database locked, key missing). Fix what the log says, then start it again: `systemctl --user start
watchbell.service`, `Start-ScheduledTask Watchbell`, or `launchctl kickstart gui/$(id -u)/watchbell`.

## More

Features, screenshots and the full documentation: https://github.com/watchbell/watchbell. Report security problems
privately as described in the repository's security policy.

## License

MIT © 2026 [Trias](https://github.com/Trias1)
