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
| `watchbell run` | Start in the foreground for a service manager: never opens a browser (the service uses it). |
| `watchbell stop` | Stop the running Watchbell cleanly (`--timeout <seconds>`, default 30). |
| `watchbell status` | Is it running, at which address, which folders. Exit code 0 when it runs, 3 when it doesn't. |
| `watchbell service install` | Start Watchbell when you log in: a systemd user service on Linux, a per-user Scheduled Task on Windows (no admin rights). Asks first; `--yes` confirms. On macOS it prints launchd instructions. |
| `watchbell service uninstall` | Remove that service or task. Settings and data stay. |
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

Never lose `OPS_ENCRYPTION_KEY`. If it goes missing while `data/` holds a database, Watchbell refuses to start and asks
you to put it back from your backup (or to start over with `watchbell start --new-key`).

## Backups

Copy the whole `~/.watchbell/` folder (or your `WATCHBELL_HOME`) while Watchbell is stopped: `.env` and `data/`
belong together.

## If it says it is already running

After a crash or a power cut the database lock (`~/.watchbell/data/pg/.watchpost.lock`) can stay behind. `watchbell`
removes it by itself when its process id now belongs to another program. If it says the database is locked but no
Watchbell answers, and you are sure none runs, delete the file it names and start again.

## Updating and removing

`npm install -g watchbell@latest` updates the program; your settings and data stay in `~/.watchbell/`. Stop Watchbell
first (`watchbell stop`). To remove it: `watchbell service uninstall` (if you installed the service),
`npm uninstall -g watchbell`, then delete `~/.watchbell/` if you no longer want the data.

The service runs the Node.js it was installed with. After changing Node (nvm, fnm, volta) or reinstalling watchbell
under another Node, run `watchbell service install` again. On Windows the task writes its output to
`~/.watchbell/watchbell.log`, which grows; delete it now and then while Watchbell is stopped.

## More

Features, screenshots and the full documentation: https://github.com/watchbell/watchbell. Report security problems
privately as described in the repository's security policy.

## License

MIT
