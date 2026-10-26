# Install

Bahasa Indonesia: [id/install.md](id/install.md)

Watchbell runs on one machine: your laptop, a desktop that stays on, or a small server. It keeps its data in a local
database folder (PGlite, Postgres compiled to WebAssembly), runs its own scheduler, and needs no cloud account to
start.

- [What you need](#what-you-need)
- [Get the code](#get-the-code)
- [Quick install with npm](#quick-install-with-npm)
- [Linux](#linux)
- [Windows](#windows)
- [macOS and manual installs](#macos-and-manual-installs)
- [Installer options](#installer-options)
- [Where things are](#where-things-are)
- [Start and stop](#start-and-stop)
- [Upgrade](#upgrade)
- [Uninstall](#uninstall)

## What you need

- **Node.js 24** (any 24.x release) with npm. Other major versions are refused. On Linux the installer offers to
  install Node 24 for you; on Windows you install it from nodejs.org first (see [Windows](#windows)).
- About **2 GB of free disk** for the dependencies and the build, plus room for your data.
- **2 GB of RAM** or more is recommended. The build is the heaviest step; the running console needs much less.
- **git**, if you want `--upgrade` to fetch new versions for you.
- Linux: Ubuntu 22.04 or 24.04 is what the installer is tested on. Other distributions with bash and systemd should
  work.
- Windows: Windows 10 or 11 with Windows PowerShell 5.1 (built in).

Watchbell's installers never use `sudo` or administrator rights, never install system packages without asking, and
never open a firewall port. (Installing Node itself on Windows is a normal Windows installer, which asks for
administrator approval; see below.)

## Get the code

Clone the repository (recommended, so upgrades are one command), or download a release archive from the project's
GitHub releases page and unpack it.

Unpack or clone into a **new, empty folder** (for example `~/watchbell` on Linux and macOS, or `C:\watchbell` on
Windows), never into a folder that already holds other files: mixed files from another project or an older copy
break the install.

```bash
git clone https://github.com/watchbell/watchbell.git watchbell
cd watchbell
```

Everything below runs from this folder, the one that contains `install.sh`, `install.bat` and the `app/` folder.

## Quick install with npm

The npm package is a prebuilt Watchbell: no clone, no build, and nothing runs while it installs. It needs Node 24 like
the installers do, and works on Linux, Windows and macOS.

```bash
npm install -g watchbell
watchbell
```

The first start creates `~/.watchbell/` (on Windows `%USERPROFILE%\.watchbell\`) with `.env` (your settings, with
fresh secrets, readable by your user only) and `data/` (the database), shows a one-time setup code and opens
http://localhost:3100/setup. Set `WATCHBELL_HOME` to use another folder.

In a terminal, `watchbell` then shows a short start screen with a menu:

```
  Watchbell 1.2.2
  http://localhost:3100
  First run: setup code ABCDE-FGH23

  ❯ Open in browser
    Keep running in the background
    Show live log
    Stop and exit
```

Move with ↑ and ↓ and press Enter, or press the first letter: `o` opens the browser and `k` keeps it running, while
`s` moves between the two items that start with S (press Enter to run the one you picked). **Keep running in the
background** leaves Watchbell running after you close the terminal; stop it later with `watchbell stop`. **Show live
log** follows the log until you press a key. **Stop and exit** and Ctrl+C stop Watchbell cleanly. The setup code line
shows only until the owner account exists. When Watchbell listens on your network (`--host 0.0.0.0`), the screen lists
its addresses and a two-line warning: finish setup first, and put HTTPS in front before you open it to the internet.

The server's own messages (the Next.js banner, the collector's progress lines) go to `~/.watchbell/logs/watchbell.log`,
not the terminal. The log keeps at most two files of about 5 MB (`watchbell.log` and `watchbell.log.1`). An error still
shows in the terminal as one line with the log's path. `watchbell start --verbose` prints everything in the terminal as
before 1.2.2, without the menu. Without a terminal (piped output, CI) there is no menu and no colour: `watchbell` prints
the address and the setup code and runs until you stop it. `watchbell run`, which the services use, prints like before,
so a service's messages stay where they were (journald, or `~/.watchbell/watchbell.log` for the Scheduled Task and the
launchd agent).

`watchbell --help` lists every command:
`stop`, `status`, `update`, `service install|uninstall` (start at login with a systemd user service, a Scheduled Task
or a launchd agent on macOS; no admin rights), `reset-login <email>`. After you change Node.js (nvm, fnm, volta,
Homebrew), run `watchbell service install` again; `watchbell status` warns when the service's Node.js is gone.

The address comes from `~/.watchbell/.env` (`HOST`, `PORT`, `SITE_URL`). A `HOST` or `PORT` your shell exports is
ignored, so a shell that sets them for other programs can't move Watchbell onto your network or another port; set
`WATCHBELL_HOST` or `WATCHBELL_PORT` to override the file on purpose, or `--host` and `--port` for one run (see
[Open it from another computer](#open-it-from-another-computer)).

`watchbell status` shows the address Watchbell really listens on, also when you started it with `--port` for one run,
and where the log is. An option it doesn't know, such as a typo like `--no-openen`, stops it with
`Unknown option --no-openen (see watchbell --help)` instead of being ignored.

Update with `watchbell update`. It runs `npm install -g watchbell@latest` with the npm next to your Node.js, into the
folder the running copy was installed in (`--prefix`, taken from where `watchbell` runs: `<prefix>/lib/node_modules/watchbell`
on Linux and macOS, `<prefix>\node_modules\watchbell` on Windows). So a second Node.js on your PATH (nvm next to a copy
in `~/.local`, for example) can't take the update while the old version keeps running. A service you installed with
`watchbell service install` is stopped first and started again after, and a Watchbell you started in a terminal must
be stopped first (`watchbell stop`). If npm's global folder belongs to root (a Node.js from your distribution's
packages), stop Watchbell and run the `sudo npm install -g ...` command it names instead. `watchbell` and
`watchbell status` tell you when a newer version is out: they ask registry.npmjs.org at most once a day (a plain
request for the version number, nothing about you). They also warn in one line when the Node.js they run on has a
security fix waiting or is past end of life. For that they read nodejs.org's release list and endoflife.date at most
twice a day. The running Watchbell reads the same two lists every 12 hours for its Settings › Collector line.
`WATCHBELL_NO_UPDATE_CHECK=1`, in `~/.watchbell/.env` or in the environment, turns all of it off.

From 1.0.x, update once by hand, because 1.0 has no `watchbell update`: `watchbell stop` (or stop the service you set
up), then `npm install -g watchbell@latest`, then start it again. From 1.1 on, `watchbell update` does it.

The first start writes your computer's time zone into the new `~/.watchbell/.env` as `WATCHBELL_TIMEZONE`. A `.env`
from 1.0 stays on Western Indonesian Time (WIB) until you add it, for example `WATCHBELL_TIMEZONE=Europe/Berlin`,
and restart. See [Time zone](configuration.md#time-zone).

Remove it with `watchbell service uninstall` (if you installed the service) and `npm uninstall -g watchbell`; delete
`~/.watchbell/` only if you no longer want the data.

### Open it from another computer

Watchbell listens on this machine only (`127.0.0.1`). From another computer, the safest way in is an SSH tunnel:
nothing on the Watchbell machine changes, and the connection is encrypted. On the computer you sit at, run

```bash
ssh -N -L 3100:127.0.0.1:3100 you@the-watchbell-machine
```

and open http://localhost:3100 there. The tunnel lasts as long as that command runs.

To open it to your network instead, give it an address for one run (`0.0.0.0` means every network of this machine):

```bash
watchbell --host 0.0.0.0 --port 3100
```

The start screen shows the addresses other computers can use, such as `http://192.168.1.20:3100`, and a two-line
warning; the longer explanation below, with the SSH tunnel and the `SITE_URL` note, goes to
`~/.watchbell/logs/watchbell.log` (or to the terminal with `--verbose`). Everyone who can reach those addresses gets
the sign-in page, and plain http sends passwords readable on the network. So finish `/setup` (the
owner account) before you share the address, keep it to networks you trust, and never open it to the internet without
HTTPS in front (see [Behind a reverse proxy](configuration.md#behind-a-reverse-proxy)). Signing in works from any of
those addresses. Links in alerts and messages use `SITE_URL`, so set `SITE_URL=http://192.168.1.20:3100` (your
address) in `~/.watchbell/.env` when they should work on the other computers too. To keep the address, set `HOST`
(and `PORT`) in that file instead of the options; the service reads the file.

The rest of this guide covers the installers, which build Watchbell from this repository.

## Linux

```bash
bash install.sh
```

Use `bash install.sh` as shown: it works even when the download or archive tool dropped the file's executable bit.
(`./install.sh` does the same when the bit is set.)

The installer goes through these steps and stops with a message naming the step if one fails:

1. **Checks** the system: the OS, Node 24, npm, at least 2 GB of free disk, and RAM (a warning only). If Node 24 is
   missing or another major version is installed, it asks before installing Node 24 with
   [nvm](https://github.com/nvm-sh/nvm) (a fixed nvm release from its official repository) into your home folder. If you say no, it prints how to install it yourself and
   stops without writing anything.
2. **Checks the port** (3100 unless you pass `--port`). If something else already listens there, it says so before
   building and suggests another port.
3. **Writes `app/.env`** if it doesn't exist, with fresh random secrets (see [Configuration](configuration.md)). The
   file is readable by you only (mode 600). On a re-run it only adds keys that are missing and never changes or prints
   an existing value, above all `OPS_ENCRYPTION_KEY`.
4. Runs `npm ci` and `npm run build` in `app/`.
5. **Asks** whether Watchbell should start automatically. If you say yes, it creates, enables and starts a systemd
   **user** service, `~/.config/systemd/user/watchbell.service`, which reads `app/.env`. If you say no, it prints the
   command to start Watchbell by hand. On a re-run, a running service is stopped for the rebuild and started again.
6. Prints the address to open: `http://localhost:3100/setup`.

If the installer installed Node with nvm, open a new terminal (or run `nvm use 24`) before you use `npm` yourself.

Then continue with [First run](first-run.md).

### Keep it running after you log out

A systemd user service stops when you log out, unless lingering is on for your account. The installer suggests the
command but never runs it:

```bash
loginctl enable-linger "$USER"
```

## Windows

Double-click `install.bat` in the Watchbell folder, or run it from a terminal so you can pass options:

```bat
install.bat --port 3200
```

`install.bat` runs `install.ps1` with PowerShell's execution policy relaxed for that one process only. You can also
call the script directly from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Port 3200
```

The steps are the same as on Linux:

1. Checks Windows, Node 24, npm, free disk and RAM. The Windows installer doesn't install Node for you. If Node 24 is
   missing, or another major version is installed, it prints where to get Node 24 and stops without writing anything:

   1. Download the Windows Installer (.msi) for Node 24 from https://nodejs.org/dist/latest-v24.x/ (or pick v24 on
      https://nodejs.org/en/about/previous-releases). If another Node version is installed, remove it first in
      Settings › Apps › Installed apps.
   2. Run the .msi with the default options (npm is included). Like any normal Windows installer it asks for
      administrator approval.
   3. Open a **new** terminal so the new `PATH` is picked up, check that `node -v` shows v24, and run `install.bat`
      again.
2. Checks that the port is free.
3. Writes `app\.env` if it is missing, or fills in only the keys that are missing or empty (existing values are kept),
   and limits the file to your Windows user (with `icacls`).
4. Runs `npm ci` and `npm run build`.
5. Asks whether Watchbell should start automatically. If you say yes, it registers and starts a Scheduled Task named
   **Watchbell** for your user. The task starts Watchbell hidden each time you sign in, reads `app\.env`, and appends
   its output to `app\data\watchbell.log`. Windows may restart it if it stops with an error; if it doesn't come back,
   start it again with `Start-ScheduledTask Watchbell` or check `app\data\watchbell.log`. On a re-run, a running
   task is stopped for the rebuild and started again.
6. Prints the address to open: `http://localhost:3100/setup`.

When you double-click `install.bat`, the window stays open at the end so you can read the address; press a key to
close it.

Then continue with [First run](first-run.md).

## macOS and manual installs

There is no installer for macOS. The manual steps below work on macOS, Linux and Windows (Git Bash).

1. Install Node 24, for example with [nvm](https://github.com/nvm-sh/nvm) (`nvm install 24`) or from
   [nodejs.org](https://nodejs.org). Check it:

   ```bash
   node --version   # must print v24.something
   ```

2. Create `app/.env` with fresh secrets:

   ```bash
   cd app
   cat > .env <<EOF
   WATCHBELL_MODE=selfhost
   DATABASE_URL=pglite:
   WATCHBELL_DATA_DIR=./data
   HOST=127.0.0.1
   PORT=3100
   SITE_URL=http://localhost:3100
   OPS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
   COLLECTOR_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
   CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
   WATCHBELL_TIMEZONE=$(node -p "Intl.DateTimeFormat().resolvedOptions().timeZone")
   EOF
   chmod 600 .env
   ```

   Run this only once. Generating a new `OPS_ENCRYPTION_KEY` later makes every saved token unreadable.
   `WATCHBELL_TIMEZONE` is your computer's time zone as Node.js names it; check that the file has a full name such
   as `Europe/Berlin` (not `CET`), or see [Time zone](configuration.md#time-zone).
   [`app/.env.example`](../app/.env.example) lists the optional settings.

3. Install and build:

   ```bash
   npm ci
   npm run build
   ```

4. Start it:

   ```bash
   npm run start:selfhost
   ```

   Leave the terminal open; Ctrl+C (or `npm run stop:selfhost` in another terminal) stops Watchbell cleanly. To start it at login, wrap that command in a launchd agent
   (macOS) or a systemd user service (Linux) of your own.

## Installer options

| Linux (`install.sh`) | Windows (`install.bat` or `install.ps1`) | What it does |
|---|---|---|
| `--yes` | `-Yes` | Answers yes to every question (installing Node 24 with nvm on Linux, creating the auto-start). For unattended installs. |
| `--no-service` | `-NoService` | Skips the auto-start question and doesn't create the service or the Scheduled Task. |
| `--port <n>` | `-Port <n>` | Uses port `<n>` instead of 3100 (written to `PORT` and `SITE_URL` in a new `app/.env`). |
| `--upgrade` | `-Upgrade` | Fetches the new version first (see [Upgrade](#upgrade)), then runs the normal steps. |
| `--help` | `-Help` | Prints the options and exits. |

`install.bat` also accepts the Linux spellings (`install.bat --yes --no-service`). Options can be combined, for
example:

```bash
bash install.sh --yes --no-service --port 3200
```

Exit codes: `0` everything worked, `1` a step failed (the message names it), `2` an option was wrong.

`--port` only sets the port when `app/.env` is created. On an existing install, change `PORT` and `SITE_URL` in
`app/.env` instead (see [Configuration](configuration.md)).

## Where things are

| Path | What it is |
|---|---|
| `app/.env` | Your settings and secrets. Keep a copy somewhere safe; never commit or share it. |
| `app/data/` | Everything Watchbell stores: the database (`app/data/pg`), the first-run setup code, and on Windows the log. |
| `app/data/setup-code` | The one-time setup code, until the owner account exists. |
| `app\data\watchbell.log` | Windows only: the server output when it runs as the Scheduled Task. It keeps growing; delete it while Watchbell is stopped if it gets large. |
| `~/.config/systemd/user/watchbell.service` | Linux only: the auto-start service, if you chose it. |

On Linux the server output goes to the systemd journal: `journalctl --user -u watchbell -f`.

## Start and stop

**Linux, with the service:**

```bash
systemctl --user status watchbell     # is it running?
systemctl --user restart watchbell    # after you edit app/.env
systemctl --user stop watchbell
systemctl --user start watchbell
journalctl --user -u watchbell -f     # follow the log
```

**Windows, with the Scheduled Task** (in PowerShell, from the Watchbell folder):

```powershell
Start-ScheduledTask Watchbell
cd app; npm run stop:selfhost; cd ..        # clean stop
Get-Content app\data\watchbell.log -Tail 50 -Wait
```

`npm run stop:selfhost` asks the running server to stop and waits up to 30 seconds for it to close its database
cleanly. It exits with 0 once Watchbell has stopped (or wasn't running). If it times out, `Stop-ScheduledTask Watchbell`
ends the task by force; use that only as a last resort, because it can interrupt Watchbell while it closes its
database.

**By hand, any OS:**

```bash
cd app
npm run start:selfhost
```

Stop it with Ctrl+C, or with `npm run stop:selfhost` from another terminal in `app/`, and wait for it to exit:
Watchbell closes its database on the way out, and killing it in the middle of that can damage the data folder.
`npm run stop:selfhost` works the same on every OS and also stops the Linux service's server, but there
`systemctl --user stop watchbell` is the usual way.

`npm run start:selfhost` reads `app/.env`, including `HOST` and `PORT`. A setting given in the shell wins over
the file, for example to use another port for one run:

```bash
PORT=3200 npm run start:selfhost             # Linux, macOS, Git Bash
```

```powershell
$env:PORT = "3200"; npm run start:selfhost   # Windows PowerShell
```

Only one Watchbell can use a data folder at a time. A second one stops with "Another Watchbell is already using …"
(see [Troubleshooting](troubleshooting.md#another-watchbell-is-already-using)).

## Upgrade

Coming from an install made when the product was called Watchpost? Nothing breaks. Your `app/.env` keeps working
(the old `WATCHPOST_*` names are still read), and `install.sh` / `install.bat` offer to replace the old auto-start
(the systemd service `watchpost.service`, or the Scheduled Task `Watchpost`) of this folder with the new one
(`watchbell.service`, or the task `Watchbell`). The uninstallers remove either one. Your data is not touched.

Back up first: stop Watchbell and copy `app/data` and `app/.env` somewhere safe (see [Backups](backups.md)).

**With a git clone:**

```bash
bash install.sh --upgrade        # Linux
```

```bat
install.bat --upgrade
```

`--upgrade` runs `git pull --ff-only`, but only when the folder is a git checkout with no changes to its tracked files
(your `app/.env` and `app/data` don't count). Otherwise it stops and tells you why. It then runs the normal steps:
keeps `app/.env` (adding only new keys), runs `npm ci` and `npm run build`. A running service or Scheduled Task is
stopped for the rebuild and started again at the end. If you run Watchbell by hand, stop it before the upgrade and
start it again afterwards. Database changes are applied automatically when the new version starts.

**After you upgrade Node itself** (for example a new 24.x with nvm), run `bash install.sh` again. The Linux service
points at the exact Node program it was created with, and the re-run updates it and rebuilds the app.

**With a release archive:** stop Watchbell, unpack the new release into a new folder, copy `app/.env` and `app/data`
from the old folder into the new one, and run the installer there. If you had the auto-start, run the uninstaller in
the old folder first, so the service points at the new folder.

## Uninstall

```bash
bash uninstall.sh                # Linux
```

```bat
uninstall.bat
```

Add `--yes` (`bash uninstall.sh --yes`, `uninstall.bat --yes`) to skip the confirmation.

The uninstaller asks for confirmation, then stops Watchbell and removes the auto-start (the systemd user service or
the Scheduled Task). It never deletes your data: it prints where `app/data` and `app/.env` are. To remove everything, delete them by hand and then
the Watchbell folder:

```bash
rm -rf app/data app/.env
```

```powershell
Remove-Item -Recurse -Force app\data, app\.env
```

If you turned lingering on only for Watchbell, you can turn it off again with `loginctl disable-linger "$USER"`.
Tokens you created at providers (Vercel, Cloudflare, GitHub and so on) stay valid until you revoke them there.
