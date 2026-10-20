#!/usr/bin/env bash
# Watchbell installer for Linux (Ubuntu 22.04/24.04 and similar). Run it from the folder it ships in: bash install.sh
#
# It never uses sudo and never installs system packages. It asks before installing Node.js 24 (with nvm, into your
# home folder) and before creating the auto-start (a systemd user service). Re-running it is safe: app/.env keeps
# every value it already has (above all OPS_ENCRYPTION_KEY), only missing keys are added, and the app is rebuilt.
#
# Exit codes: 0 done, 1 a step failed (the message names the step), 2 bad arguments.
set -euo pipefail

WP_NODE_MAJOR=24
WP_DEFAULT_PORT=3100
WP_NVM_RELEASE="v0.40.3"
WP_NVM_URL="https://raw.githubusercontent.com/nvm-sh/nvm/${WP_NVM_RELEASE}/install.sh"
WP_MIN_DISK_KB=$((2 * 1024 * 1024))
WP_MIN_RAM_KB=$((2 * 1024 * 1024))
WP_SERVICE="watchbell"
# Watchbell was called Watchpost in earlier test installs: its service and its WATCHPOST_* keys are still recognised.
WP_LEGACY_SERVICE="watchpost"
WP_ENV_KEYS=(WATCHBELL_MODE DATABASE_URL WATCHBELL_DATA_DIR HOST PORT SITE_URL OPS_ENCRYPTION_KEY COLLECTOR_SECRET CRON_SECRET)
WP_ENV_LINE_RE='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$'

WP_REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WP_APP_DIR="$WP_REPO_DIR/app"
WP_ENV_FILE="$WP_APP_DIR/.env"
WP_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
WP_UNIT_FILE="$WP_UNIT_DIR/$WP_SERVICE.service"
WP_LEGACY_UNIT_FILE="$WP_UNIT_DIR/$WP_LEGACY_SERVICE.service"

WP_YES=0
WP_NO_SERVICE=0
WP_UPGRADE=0
WP_PORT_ARG=""
WP_REEXEC_ARGS=()

WP_STEP="arguments"
WP_REPORTED=0
WP_ENV_TMP=""
WP_PORT="$WP_DEFAULT_PORT"
WP_WANT_SERVICE=0
WP_UNIT_OURS=0
WP_SERVICE_WAS_ACTIVE=0
WP_STOPPED_SERVICE=""
WP_LEGACY_REMOVE=0
WP_NVM_USED=0

usage() {
  cat <<'EOF'
Usage: bash install.sh [options]

Installs Watchbell from this folder: checks for Node.js 24, creates app/.env with fresh secrets (or adds the
missing keys to an existing one), runs npm ci and npm run build in app/, and, if you agree, starts Watchbell
automatically with a systemd user service (~/.config/systemd/user/watchbell.service). If an earlier install of this
folder (when the product was still called Watchpost) left ~/.config/systemd/user/watchpost.service, it offers to
replace that with watchbell.service.

Options:
  --yes          Answer yes to every question (install Node.js 24 with nvm, create the service).
  --no-service   Do not create the systemd user service; print the command to start Watchbell instead.
  --port <n>     Port Watchbell listens on (default 3100). Used when app/.env does not set PORT yet.
  --upgrade      First update this git checkout with git pull --ff-only (only when it has no local changes),
                 then run the normal steps.
  --help         Show this help.

Exit codes: 0 done, 1 a step failed (the message names the step), 2 bad arguments.
Uninstall: bash uninstall.sh (keeps app/data and app/.env).
EOF
}

say() { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }

fail() {
  WP_REPORTED=1
  printf '\ninstall.sh: step "%s" failed: %s\n' "$WP_STEP" "$*" >&2
  exit 1
}

bad_arg() {
  WP_REPORTED=1
  printf 'install.sh: %s\nRun bash install.sh --help to see the options.\n' "$*" >&2
  exit 2
}

on_exit() {
  local rc=$?
  if [ -n "$WP_ENV_TMP" ] && [ -e "$WP_ENV_TMP" ]; then rm -f -- "$WP_ENV_TMP"; fi
  if [ "$rc" -ne 0 ] && [ "$WP_REPORTED" -eq 0 ]; then
    printf '\ninstall.sh: step "%s" failed unexpectedly (exit code %s).\n' "$WP_STEP" "$rc" >&2
    exit 1
  fi
}

# ask "question" -> 0 for yes, 1 for no. --yes answers yes; no answer (or no terminal) means no.
ask() {
  if [ "$WP_YES" -eq 1 ]; then
    printf '%s [y/N] yes (--yes)\n' "$1"
    return 0
  fi
  local answer=""
  printf '%s [y/N] ' "$1"
  IFS= read -r answer || printf '\n'
  case "$answer" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)); }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) WP_YES=1 ;;
      --no-service) WP_NO_SERVICE=1 ;;
      --upgrade) WP_UPGRADE=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      --port)
        [ $# -ge 2 ] || bad_arg "--port needs a number, for example --port 3200"
        WP_PORT_ARG="$2"
        shift
        ;;
      --port=*) WP_PORT_ARG="${1#--port=}" ;;
      *) bad_arg "unknown option: $1" ;;
    esac
    shift
  done
  if [ -n "$WP_PORT_ARG" ]; then
    valid_port "$WP_PORT_ARG" || bad_arg "--port must be a number from 1 to 65535 (got: $WP_PORT_ARG)"
    WP_PORT_ARG="$((10#$WP_PORT_ARG))"
  fi
  # The arguments for the fresh copy of this script after --upgrade pulled it.
  [ "$WP_YES" -eq 1 ] && WP_REEXEC_ARGS+=(--yes)
  [ "$WP_NO_SERVICE" -eq 1 ] && WP_REEXEC_ARGS+=(--no-service)
  [ -n "$WP_PORT_ARG" ] && WP_REEXEC_ARGS+=(--port "$WP_PORT_ARG")
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
# app/.env helpers. Values are read only to decide what is missing; secrets are never printed.

env_unquote() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  case "$v" in
    \"*\" | \'*\') v="${v:1:${#v}-2}" ;;
    *) v="${v%%[[:space:]]#*}" ;;
  esac
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

# env_get KEY -> the value of the last KEY=... line in app/.env ('' when the key or the file is missing).
env_get() {
  [ -f "$WP_ENV_FILE" ] || return 0
  local line out=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ $WP_ENV_LINE_RE ]] && [ "${BASH_REMATCH[2]}" = "$1" ]; then
      out="$(env_unquote "${BASH_REMATCH[3]}")"
    fi
  done <"$WP_ENV_FILE"
  printf '%s' "$out"
}

# gen_secret BYTES ENCODING (base64 | base64url) -> random secret on stdout.
gen_secret() {
  local out=""
  out="$("$WP_NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1])).toString(process.argv[2]))' "$1" "$2" 2>/dev/null)" || out=""
  if [ -z "$out" ] && command -v openssl >/dev/null 2>&1; then
    out="$(openssl rand -base64 "$1" | tr -d '\n')" || out=""
    [ "$2" = "base64url" ] && out="$(printf '%s' "$out" | tr '+/' '-_' | tr -d '=')"
  fi
  [[ "$out" =~ ^[A-Za-z0-9+/_=-]{16,}$ ]] || return 1
  printf '%s' "$out"
}

# machine_zone -> this computer's IANA time zone (Europe/Berlin) on stdout, as Node.js names it; nothing when Node
# can't name a usable one. Written as WATCHBELL_TIMEZONE into a NEW app/.env only (an existing file keeps the app's
# default, Asia/Jakarta).
machine_zone() {
  local out=""
  # The few old names ICU still prefers are written by their current name (Asia/Calcutta -> Asia/Kolkata). Keep this
  # map and the name rule below in step with app/src/lib/time.ts (LEGACY_ZONES, ZONE_NAME), install.ps1 and the CLI.
  out="$("$WP_NODE_BIN" -e 'const m={"Asia/Calcutta":"Asia/Kolkata","Asia/Katmandu":"Asia/Kathmandu","Asia/Saigon":"Asia/Ho_Chi_Minh","Asia/Rangoon":"Asia/Yangon"};const r=Intl.DateTimeFormat().resolvedOptions().timeZone;const z=m[r]||r;try{new Intl.DateTimeFormat("en-US",{timeZone:z});process.stdout.write(z||"")}catch{}' 2>/dev/null)" || out=""
  # A full Area/Location name or UTC/GMT only: an abbreviation (CET, IST) means another zone to Postgres.
  [[ "$out" =~ ^(UTC|GMT|[A-Za-z]+(/[A-Za-z0-9_+-]+)+)$ ]] || return 0
  printf '%s' "$out"
}

# env_default KEY -> the value install.sh writes for KEY (in REPLY).
env_default() {
  case "$1" in
    WATCHBELL_MODE) REPLY="selfhost" ;;
    DATABASE_URL) REPLY="pglite:" ;;
    WATCHBELL_DATA_DIR) REPLY="./data" ;;
    HOST) REPLY="127.0.0.1" ;;
    PORT) REPLY="$WP_PORT" ;;
    SITE_URL) REPLY="http://localhost:$WP_PORT" ;;
    OPS_ENCRYPTION_KEY) REPLY="$(gen_secret 32 base64)" || fail "could not generate OPS_ENCRYPTION_KEY (node -e failed)" ;;
    COLLECTOR_SECRET) REPLY="$(gen_secret 32 base64url)" || fail "could not generate COLLECTOR_SECRET (node -e failed)" ;;
    CRON_SECRET) REPLY="$(gen_secret 24 base64url)" || fail "could not generate CRON_SECRET (node -e failed)" ;;
    *) fail "internal: no default for $1" ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------------
# Steps

do_upgrade() {
  WP_STEP="upgrade"
  command -v git >/dev/null 2>&1 || fail "git is not installed, so --upgrade cannot update this folder. Install git, or download the new release and copy app/.env and app/data into it."
  git -C "$WP_REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    fail "$WP_REPO_DIR is not a git checkout (a downloaded archive cannot be pulled). Download the new release instead and copy app/.env and app/data into it, or run without --upgrade."
  # An archive unpacked inside some other git repository is "inside a work tree" too: never pull that parent.
  local top="" top_real="" repo_real=""
  top="$(git -C "$WP_REPO_DIR" rev-parse --show-toplevel 2>/dev/null)" || top=""
  top_real="$(cd -- "$top" 2>/dev/null && pwd -P)" || top_real=""
  repo_real="$(cd -- "$WP_REPO_DIR" && pwd -P)"
  [ -n "$top_real" ] && [ "$top_real" = "$repo_real" ] ||
    fail "this folder isn't its own git checkout (the enclosing git repository is ${top:-unknown}), so --upgrade will not pull. Download the new release instead and copy app/.env and app/data into it, or run without --upgrade. Nothing was changed."
  local changes=""
  changes="$(git -C "$WP_REPO_DIR" status --porcelain --untracked-files=no)" || fail "git status did not work in $WP_REPO_DIR"
  [ -z "$changes" ] ||
    fail "the checkout has local changes (see: git status). Commit or stash them first, or run without --upgrade. Nothing was changed."
  say "Updating the checkout: git pull --ff-only"
  git -C "$WP_REPO_DIR" pull --ff-only || fail "git pull --ff-only did not work (see the message above). Nothing else was changed."
  # The pull may have replaced this very script: continue with the new copy (without --upgrade).
  exec bash "$WP_REPO_DIR/install.sh" ${WP_REEXEC_ARGS[@]+"${WP_REEXEC_ARGS[@]}"}
}

check_os() {
  WP_STEP="prerequisites (system)"
  local os=""
  os="$(uname -s 2>/dev/null)" || os="unknown"
  case "$os" in
    Linux) ;;
    Darwin) fail "macOS has no installer yet. Install Node.js 24, then run: cd app && npm ci && npm run build && npm run start:selfhost (see docs/install.md)." ;;
    MINGW* | MSYS* | CYGWIN*) fail "this is Windows: run install.bat instead." ;;
    *) fail "unsupported system: $os. This installer is for Linux." ;;
  esac
  [ -f "$WP_APP_DIR/package.json" ] && [ -f "$WP_APP_DIR/scripts/start-selfhost.mjs" ] ||
    fail "app/ was not found next to install.sh in $WP_REPO_DIR. Run the install.sh that ships in the Watchbell folder."
  if [ "${EUID:-$(id -u)}" -eq 0 ]; then
    [ -z "${SUDO_USER:-}" ] || fail "do not run install.sh with sudo. Run it as the user who will own Watchbell: bash install.sh"
    warn "you are running as root. Watchbell and its service will belong to root; a normal user account is better."
  fi
  say "System: Linux, folder $WP_REPO_DIR"
}

WP_NODE_BIN=""
WP_NPM_BIN=""

# node_major_of BIN -> the major version of that node binary.
node_major_of() {
  local v=""
  v="$("$1" --version 2>/dev/null)" || return 1
  v="${v#v}"
  [[ "$v" =~ ^[0-9]+ ]] || return 1
  printf '%s' "${BASH_REMATCH[0]}"
}

# use_node BIN: every later step runs this node and the npm next to it. Its folder also goes first on PATH, because
# npm starts with "#!/usr/bin/env node" and must not pick up an older system node.
use_node() {
  local dir=""
  dir="$(cd -- "$(dirname -- "$1")" && pwd)" || fail "cannot open the folder of $1"
  WP_NODE_BIN="$dir/$(basename -- "$1")"
  export PATH="$dir:$PATH"
  hash -r
  if [ -x "$dir/npm" ]; then
    WP_NPM_BIN="$dir/npm"
  else
    WP_NPM_BIN="$(command -v npm 2>/dev/null)" || WP_NPM_BIN=""
  fi
}

find_nvm_dir() {
  local d
  for d in "${NVM_DIR:-}" "${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/nvm}" "$HOME/.nvm"; do
    if [ -n "$d" ] && [ -s "$d/nvm.sh" ]; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

# run_nvm SCRIPT [ARGS...]: runs SCRIPT in a separate bash with nvm loaded ($1... are ARGS). nvm never shares a shell
# with this installer, so none of its variables, functions or set -euo pipefail can clash with nvm's own (nvm uses
# names such as NVM_VERSION internally). TERM=dumb keeps nvm's tput quiet when there is no real terminal.
run_nvm() {
  local dir="" script="$1"
  shift
  dir="$(find_nvm_dir)" || return 1
  NVM_DIR="$dir" TERM=dumb bash -c '. "$NVM_DIR/nvm.sh" --no-use || exit 1
'"$script" wp-nvm "$@"
}

# nvm_node_bin -> the absolute path of the Node 24 that nvm has installed (fails when nvm or that Node is missing).
nvm_node_bin() {
  local out=""
  out="$(run_nvm 'v="$(nvm version "$1")"
case "$v" in
  "v$1".*) nvm use "$1" >/dev/null && nvm which "$1" ;;
  *) exit 3 ;;
esac' "$WP_NODE_MAJOR" 2>/dev/null)" || return 1
  out="${out##*$'\n'}"
  [ -n "$out" ] && [ -x "$out" ] || return 1
  printf '%s' "$out"
}

print_manual_node() {
  cat <<EOF

To install Node.js $WP_NODE_MAJOR yourself (no sudo needed), run these commands, then run bash install.sh again:
  curl -o- $WP_NVM_URL | bash
  source ~/.bashrc        (or open a new terminal)
  nvm install $WP_NODE_MAJOR
Or install version $WP_NODE_MAJOR from https://nodejs.org/en/download (pick "Linux" and the version $WP_NODE_MAJOR line).
EOF
}

install_node_with_nvm() {
  if ! find_nvm_dir >/dev/null; then
    say "Downloading and running the nvm $WP_NVM_RELEASE installer: $WP_NVM_URL"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL -o- "$WP_NVM_URL" | bash || fail "the nvm installer did not finish (see the message above)."
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$WP_NVM_URL" | bash || fail "the nvm installer did not finish (see the message above)."
    else
      print_manual_node
      fail "neither curl nor wget is installed, so nvm cannot be downloaded."
    fi
    find_nvm_dir >/dev/null || fail "the nvm installer finished but nvm.sh was not found in ~/.nvm. Open a new terminal and run bash install.sh again."
  fi
  say "Installing Node.js $WP_NODE_MAJOR with nvm: nvm install $WP_NODE_MAJOR"
  run_nvm 'nvm install "$1" && nvm use "$1" >/dev/null' "$WP_NODE_MAJOR" ||
    fail "nvm install $WP_NODE_MAJOR did not work (see the message above)."
  local bin="" major=""
  bin="$(nvm_node_bin)" || fail "nvm install $WP_NODE_MAJOR finished, but nvm which $WP_NODE_MAJOR found no Node.js $WP_NODE_MAJOR."
  major="$(node_major_of "$bin")" || major=""
  [ "$major" = "$WP_NODE_MAJOR" ] || fail "nvm which $WP_NODE_MAJOR points to $bin, which is not Node.js $WP_NODE_MAJOR."
  use_node "$bin"
  WP_NVM_USED=1
}

check_node() {
  WP_STEP="prerequisites (Node.js)"
  local sys="" major="" bin=""
  sys="$(command -v node 2>/dev/null)" || sys=""
  [ -z "$sys" ] || major="$(node_major_of "$sys")" || major=""
  if [ -n "$sys" ] && [ "$major" = "$WP_NODE_MAJOR" ]; then
    use_node "$sys"
  elif bin="$(nvm_node_bin)" && [ "$(node_major_of "$bin" || true)" = "$WP_NODE_MAJOR" ]; then
    # nvm is already here with a Node 24 installed: use that one (nothing is downloaded).
    use_node "$bin"
    WP_NVM_USED=1
  else
    local found="none"
    if [ -n "$major" ]; then found="$("$sys" --version 2>/dev/null || echo "Node.js $major")"; fi
    printf '\nWatchbell needs Node.js %s. Found: %s.\n' "$WP_NODE_MAJOR" "$found"
    if find_nvm_dir >/dev/null; then
      printf 'nvm is installed; it can download Node.js %s into your home folder (no sudo): nvm install %s\n' "$WP_NODE_MAJOR" "$WP_NODE_MAJOR"
    else
      printf 'It can be installed with nvm (Node Version Manager) into your home folder, without sudo:\n'
      printf '  1. download and run the nvm %s installer from %s\n' "$WP_NVM_RELEASE" "$WP_NVM_URL"
      printf '     (it puts nvm in ~/.nvm and adds a few lines to ~/.bashrc)\n'
      printf '  2. nvm install %s\n' "$WP_NODE_MAJOR"
    fi
    if ask "Install Node.js $WP_NODE_MAJOR with nvm now?"; then
      install_node_with_nvm
    else
      print_manual_node
      fail "Node.js $WP_NODE_MAJOR is required and was not installed. Nothing was written."
    fi
  fi
  say "Node.js $("$WP_NODE_BIN" --version) ($WP_NODE_BIN)"

  WP_STEP="prerequisites (npm)"
  [ -n "$WP_NPM_BIN" ] && "$WP_NPM_BIN" --version >/dev/null 2>&1 ||
    fail "npm is missing or does not work. It ships with Node.js $WP_NODE_MAJOR: reinstall Node.js (nvm install $WP_NODE_MAJOR)."
}

check_resources() {
  WP_STEP="prerequisites (disk)"
  local avail=""
  avail="$(df -Pk "$WP_APP_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }')" || avail=""
  if [[ "$avail" =~ ^[0-9]+$ ]]; then
    ((avail >= WP_MIN_DISK_KB)) ||
      fail "only $((avail / 1024)) MB are free on the disk that holds $WP_APP_DIR; installing and building needs at least 2 GB."
  else
    warn "could not read the free disk space; make sure at least 2 GB are free."
  fi

  WP_STEP="prerequisites (memory)"
  local mem=""
  mem="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)" || mem=""
  if [[ "$mem" =~ ^[0-9]+$ ]] && ((mem < WP_MIN_RAM_KB)); then
    warn "this machine has $((mem / 1024)) MB of memory; building Watchbell needs about 2 GB. The build may fail or be slow (adding swap helps)."
  fi
}

has_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

# service_active [NAME]: NAME defaults to the current service.
service_active() {
  has_user_systemd && systemctl --user is-active --quiet "${1:-$WP_SERVICE}" >/dev/null 2>&1
}

# unit_workdir FILE -> the WorkingDirectory= of a unit file ('' when it has none).
unit_workdir() {
  local wd=""
  wd="$(sed -n 's/^WorkingDirectory=//p' "$1" | tail -n 1)" || wd=""
  printf '%s' "$wd"
}

# port_in_use PORT -> 0 busy, 1 free, 2 could not tell.
port_in_use() {
  local out=""
  if command -v ss >/dev/null 2>&1 && out="$(ss -ltn 2>/dev/null)"; then
    if printf '%s\n' "$out" | awk -v p="$1" '{ for (i = 1; i <= NF; i++) { n = split($i, a, ":"); if (n > 1 && a[n] == p) f = 1 } } END { exit f ? 0 : 1 }'; then
      return 0
    fi
    return 1
  fi
  local rc=0
  "$WP_NODE_BIN" -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const probe = (host) => new Promise((done) => {
      const s = net.createServer();
      s.once("error", (e) => done(e.code === "EADDRINUSE" ? "busy" : "unknown"));
      s.listen({ port, host, exclusive: true }, () => s.close(() => done("free")));
    });
    (async () => {
      const local = await probe("127.0.0.1");
      if (local !== "free") process.exit(local === "busy" ? 3 : 4);
      process.exit((await probe(undefined)) === "busy" ? 3 : 0);
    })();
  ' "$1" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) return 1 ;;
    3) return 0 ;;
    *) return 2 ;;
  esac
}

check_port() {
  WP_STEP="prerequisites (port)"
  local from_env=""
  from_env="$(env_get PORT)"
  if [ -n "$from_env" ]; then
    valid_port "$from_env" || fail "app/.env sets PORT=$from_env, which is not a port number. Fix PORT (and SITE_URL) in app/.env."
    WP_PORT="$((10#$from_env))"
    if [ -n "$WP_PORT_ARG" ] && [ "$WP_PORT_ARG" != "$WP_PORT" ]; then
      warn "app/.env already sets PORT=$WP_PORT, so --port $WP_PORT_ARG is ignored. To change the port, edit PORT and SITE_URL in app/.env."
    fi
  else
    WP_PORT="${WP_PORT_ARG:-$WP_DEFAULT_PORT}"
  fi

  local state=0
  port_in_use "$WP_PORT" || state=$?
  case "$state" in
    0)
      if { [ "$WP_UNIT_OURS" -eq 1 ] && service_active; } || { [ "$WP_LEGACY_REMOVE" -eq 1 ] && service_active "$WP_LEGACY_SERVICE"; }; then
        say "Port $WP_PORT: used by the running Watchbell service (it is restarted after the build)"
      else
        local how="bash install.sh --port $((WP_PORT == 3200 ? 3300 : 3200))"
        [ -z "$from_env" ] || how="change PORT and SITE_URL in app/.env (for example to 3200)"
        fail "port $WP_PORT is already in use by another program. Stop that program, or choose another port: $how"
      fi
      ;;
    1) say "Port $WP_PORT is free" ;;
    *) warn "could not check whether port $WP_PORT is free; if Watchbell does not start, choose another port with --port." ;;
  esac
}

# An auto-start left by an earlier install of THIS folder, from when the product was called Watchpost
# (watchpost.service). It is replaced by watchbell.service when you agree (--yes agrees); when you decline, that
# service stays the one in use (updated in place, restarted after the build) and no second service is created.
# A watchpost.service that runs another folder is never touched.
decide_legacy_service() {
  [ -f "$WP_LEGACY_UNIT_FILE" ] || return 0
  local wd=""
  wd="$(unit_workdir "$WP_LEGACY_UNIT_FILE")"
  [ "$wd" = "$(unit_path "$WP_APP_DIR")" ] || return 0
  # Neither the new nor the old name can be managed without a systemd user session: leave it as it is.
  if [ "$WP_NO_SERVICE" -eq 0 ] && has_user_systemd; then
    if ask "An earlier install of this folder created the auto-start $WP_LEGACY_SERVICE.service (Watchpost is now called Watchbell). Replace it with $WP_SERVICE.service?"; then
      # A watchbell.service that already runs ANOTHER folder would be overwritten and restarted by the replacement:
      # that needs its own consent, like on any other run. Declined: the old service stays in use for this folder.
      local nwd="" repoint=1
      if [ -f "$WP_UNIT_FILE" ]; then
        nwd="$(unit_workdir "$WP_UNIT_FILE")"
        if [ "$nwd" != "$(unit_path "$WP_APP_DIR")" ]; then
          ask "The existing $WP_SERVICE.service runs Watchbell from ${nwd:-an unknown folder}. Point it to this folder ($WP_APP_DIR) instead? The other copy then no longer starts automatically." || repoint=0
        fi
      fi
      if [ "$repoint" -eq 1 ]; then
        WP_LEGACY_REMOVE=1
        WP_WANT_SERVICE=1
        say "Auto-start: $WP_LEGACY_SERVICE.service is replaced by $WP_SERVICE.service after the build"
        return 0
      fi
      say "The existing $WP_SERVICE.service (it runs ${nwd:-another folder}) is left as it is, so $WP_LEGACY_SERVICE.service is not replaced"
    fi
  fi
  if [ -f "$WP_UNIT_FILE" ] && [ "$(unit_workdir "$WP_UNIT_FILE")" = "$(unit_path "$WP_APP_DIR")" ]; then
    warn "$WP_SERVICE.service already exists for this folder too. Both $WP_LEGACY_SERVICE.service and $WP_SERVICE.service start Watchbell on the same port, so they may compete for it; remove one with bash uninstall.sh or by hand."
  fi
  WP_SERVICE="$WP_LEGACY_SERVICE"
  WP_UNIT_FILE="$WP_LEGACY_UNIT_FILE"
  say "The older $WP_LEGACY_SERVICE.service stays in use for this folder (no watchbell.service is created)"
}

decide_service() {
  WP_STEP="prerequisites (auto-start)"
  WP_WANT_SERVICE=0
  WP_UNIT_OURS=0
  WP_LEGACY_REMOVE=0
  decide_legacy_service
  if [ "$WP_LEGACY_REMOVE" -eq 1 ]; then
    # Consent was given above. An existing watchbell.service of this folder is rewritten like the legacy one.
    [ ! -f "$WP_UNIT_FILE" ] || [ "$(unit_workdir "$WP_UNIT_FILE")" != "$(unit_path "$WP_APP_DIR")" ] || WP_UNIT_OURS=1
    return 0
  fi
  if [ -f "$WP_UNIT_FILE" ]; then
    local wd=""
    wd="$(unit_workdir "$WP_UNIT_FILE")"
    if [ "$wd" = "$(unit_path "$WP_APP_DIR")" ]; then
      WP_UNIT_OURS=1
    elif [ "$WP_NO_SERVICE" -eq 1 ]; then
      say "The existing $WP_SERVICE.service runs another copy of Watchbell ($wd); it is left as it is (--no-service)"
    elif ask "The existing $WP_SERVICE.service runs Watchbell from $wd. Point it to this folder ($WP_APP_DIR) instead? The other copy then no longer starts automatically."; then
      WP_UNIT_OURS=1
    else
      say "The existing $WP_SERVICE.service is left as it is (it still runs $wd); start this copy by hand (shown at the end)"
    fi
  fi
  [ "$WP_NO_SERVICE" -eq 0 ] || return 0
  if ! has_user_systemd; then
    say "systemd user services are not available here, so Watchbell will not start automatically"
    return 0
  fi
  if [ -f "$WP_UNIT_FILE" ]; then
    if [ "$WP_UNIT_OURS" -eq 1 ]; then
      say "Auto-start: $WP_SERVICE.service is updated and restarted after the build"
      WP_WANT_SERVICE=1
    fi
    return 0
  fi
  if ask "When the build is done, start Watchbell automatically with a systemd user service ($WP_UNIT_FILE)?"; then
    WP_WANT_SERVICE=1
  fi
}

ensure_env_file() {
  WP_STEP="env file"
  local -A state=()
  local line key k
  if [ -f "$WP_ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%$'\r'}"
      [[ "$line" =~ $WP_ENV_LINE_RE ]] || continue
      key="${BASH_REMATCH[2]}"
      if [ -n "$(env_unquote "${BASH_REMATCH[3]}")" ]; then
        state[$key]="set"
      elif [ -z "${state[$key]:-}" ]; then
        state[$key]="empty"
      fi
    done <"$WP_ENV_FILE"
  fi

  local -A fill=()
  local -a added=()
  for k in "${WP_ENV_KEYS[@]}"; do
    [ "${state[$k]:-}" = "set" ] && continue
    # An env file from an earlier install has WATCHPOST_MODE / WATCHPOST_DATA_DIR: the app still reads those names, so
    # they count as the key being there (no duplicate under the new name, the old line is left as it is).
    [[ "$k" == WATCHBELL_* ]] && [ "${state[WATCHPOST_${k#WATCHBELL_}]:-}" = "set" ] && continue
    env_default "$k"
    fill[$k]="$REPLY"
    added+=("$k")
  done

  WP_ENV_TMP="$WP_ENV_FILE.tmp.$$"
  if [ ! -f "$WP_ENV_FILE" ]; then
    local zone
    zone="$(machine_zone)"
    (
      umask 077
      {
        printf '# Watchbell settings, created by install.sh on %s. Keep this file private and back it up:\n' "$(date '+%Y-%m-%d')"
        printf '# OPS_ENCRYPTION_KEY unlocks the tokens you save in the console; without it they cannot be read again.\n'
        printf '# Every setting is explained in app/.env.example and docs/configuration.md.\n'
        for k in "${WP_ENV_KEYS[@]}"; do printf '%s=%s\n' "$k" "${fill[$k]}"; done
        if [ -n "$zone" ]; then
          printf "# Times, the daily job (03:00) and the digest (07:00) follow this zone: this computer's when the file was made.\n"
          printf 'WATCHBELL_TIMEZONE=%s\n' "$zone"
        fi
      } >"$WP_ENV_TMP"
    ) || fail "could not write $WP_ENV_FILE"
    chmod 600 "$WP_ENV_TMP" && mv -f -- "$WP_ENV_TMP" "$WP_ENV_FILE" || fail "could not write $WP_ENV_FILE"
    WP_ENV_TMP=""
    chmod 600 "$WP_ENV_FILE" || fail "could not set the mode of $WP_ENV_FILE to 600"
    say "Created app/.env (mode 600) with fresh secrets. Back it up: it holds OPS_ENCRYPTION_KEY."
    return 0
  fi

  if [ "${#added[@]}" -eq 0 ]; then
    chmod 600 "$WP_ENV_FILE" || fail "could not set the mode of $WP_ENV_FILE to 600"
    say "app/.env already has every needed key; nothing changed"
    return 0
  fi

  # Keys present with an empty value are filled in place; keys not present at all are appended. Every other line
  # (and every existing value) is copied unchanged.
  local -A done_keys=()
  (
    umask 077
    {
      while IFS= read -r line || [ -n "$line" ]; do
        if [[ "${line%$'\r'}" =~ $WP_ENV_LINE_RE ]]; then
          key="${BASH_REMATCH[2]}"
          if [ "${state[$key]:-}" = "empty" ] && [ -n "${fill[$key]+x}" ] && [ -z "${done_keys[$key]:-}" ]; then
            printf '%s=%s\n' "$key" "${fill[$key]}"
            done_keys[$key]=1
            continue
          fi
        fi
        printf '%s\n' "$line"
      done <"$WP_ENV_FILE"
      local header=0
      for k in "${added[@]}"; do
        [ "${state[$k]:-}" = "empty" ] && continue
        if [ "$header" -eq 0 ]; then
          printf '\n# Added by install.sh on %s\n' "$(date '+%Y-%m-%d')"
          header=1
        fi
        printf '%s=%s\n' "$k" "${fill[$k]}"
      done
    } >"$WP_ENV_TMP"
  ) || fail "could not write $WP_ENV_FILE"
  chmod 600 "$WP_ENV_TMP" && mv -f -- "$WP_ENV_TMP" "$WP_ENV_FILE" || fail "could not write $WP_ENV_FILE"
  WP_ENV_TMP=""
  chmod 600 "$WP_ENV_FILE" || fail "could not set the mode of $WP_ENV_FILE to 600"
  say "app/.env: kept every existing value, added ${added[*]}"
}

stop_running_service() {
  # Only a service that runs this copy (or is being pointed to it) is stopped; another copy's service is left alone.
  if [ "$WP_UNIT_OURS" -eq 1 ] && service_active; then
    WP_STEP="stop service"
    say "Stopping the running Watchbell service for the rebuild"
    systemctl --user stop "$WP_SERVICE" || fail "systemctl --user stop $WP_SERVICE did not work"
    WP_SERVICE_WAS_ACTIVE=1
    WP_STOPPED_SERVICE="$WP_SERVICE"
  fi
  if [ "$WP_LEGACY_REMOVE" -eq 1 ] && service_active "$WP_LEGACY_SERVICE"; then
    WP_STEP="stop service"
    say "Stopping the running $WP_LEGACY_SERVICE service for the rebuild (it is replaced by $WP_SERVICE)"
    systemctl --user stop "$WP_LEGACY_SERVICE" || fail "systemctl --user stop $WP_LEGACY_SERVICE did not work"
    WP_SERVICE_WAS_ACTIVE=1
    WP_STOPPED_SERVICE="${WP_STOPPED_SERVICE:-$WP_LEGACY_SERVICE}"
  fi
}

# build_fail MESSAGE: fail, and say so when the service was stopped for this rebuild and is still stopped.
build_fail() {
  if [ "$WP_SERVICE_WAS_ACTIVE" -eq 1 ]; then
    fail "$1 Watchbell is stopped now (its service was stopped for the rebuild). Fix the problem and run bash install.sh again, or start the service again with: systemctl --user start $WP_STOPPED_SERVICE (it may not work until a build succeeds)."
  fi
  fail "$1"
}

build_app() {
  WP_STEP="npm ci"
  say "Installing dependencies: npm ci (in app/)"
  (cd -- "$WP_APP_DIR" && "$WP_NPM_BIN" ci) || build_fail "npm ci did not finish (see the messages above)."

  WP_STEP="npm run build"
  say "Building: npm run build (in app/)"
  (cd -- "$WP_APP_DIR" && WATCHBELL_MODE=selfhost "$WP_NPM_BIN" run build) || build_fail "npm run build did not finish (see the messages above)."
}

# systemd unit values: % starts a specifier everywhere; ExecStart also unescapes \ " and expands $.
unit_path() { printf '%s' "${1//%/%%}"; }
unit_exec_word() {
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g' -e 's/\$/$$/g')"
}

print_manual_start() {
  printf '\nStart Watchbell with:\n'
  printf '  cd app && npm run start:selfhost\n'
  printf '(from %s; stop it with Ctrl+C, or from another terminal: cd app && npm run stop:selfhost)\n' "$WP_REPO_DIR"
  if [ "$WP_NVM_USED" -eq 1 ]; then
    printf 'In a new terminal, run "nvm use %s" first so npm uses Node.js %s.\n' "$WP_NODE_MAJOR" "$WP_NODE_MAJOR"
  fi
}

setup_service() {
  WP_STEP="auto-start"
  if [ "$WP_WANT_SERVICE" -ne 1 ]; then
    if [ "$WP_SERVICE_WAS_ACTIVE" -eq 1 ]; then
      systemctl --user start "$WP_SERVICE" || fail "systemctl --user start $WP_SERVICE did not work"
      say "Started the existing Watchbell service again"
      return 0
    fi
    print_manual_start
    return 0
  fi

  # The absolute Node 24 chosen in the prerequisites (nvm which 24 for an nvm install), never a PATH lookup here.
  local node_bin="$WP_NODE_BIN"
  [ -n "$node_bin" ] || fail "internal: no Node.js binary was chosen"

  mkdir -p -- "$WP_UNIT_DIR" || fail "could not create $WP_UNIT_DIR"
  {
    printf '# Written by Watchbell install.sh. Remove it with bash uninstall.sh.\n'
    printf '[Unit]\n'
    printf 'Description=Watchbell self-hosted ops console\n'
    printf '\n[Service]\n'
    printf 'Type=simple\n'
    printf 'WorkingDirectory=%s\n' "$(unit_path "$WP_APP_DIR")"
    printf 'EnvironmentFile=%s\n' "$(unit_path "$WP_ENV_FILE")"
    printf 'ExecStart=%s scripts/start-selfhost.mjs\n' "$(unit_exec_word "$node_bin")"
    printf 'Restart=on-failure\n'
    printf 'RestartSec=5\n'
    printf 'KillSignal=SIGTERM\n'
    printf 'TimeoutStopSec=30\n'
    printf '\n[Install]\n'
    printf 'WantedBy=default.target\n'
  } >"$WP_UNIT_FILE" || fail "could not write $WP_UNIT_FILE"
  say "Wrote $WP_UNIT_FILE"

  if [ "$WP_LEGACY_REMOVE" -eq 1 ]; then
    # The user agreed to replace the older service: stop and delete it before the new one starts on the same port.
    systemctl --user disable --now "$WP_LEGACY_SERVICE" || fail "systemctl --user disable --now $WP_LEGACY_SERVICE did not work"
    rm -f -- "$WP_LEGACY_UNIT_FILE" || fail "could not delete $WP_LEGACY_UNIT_FILE"
    say "Removed the older $WP_LEGACY_UNIT_FILE"
  fi
  systemctl --user daemon-reload || fail "systemctl --user daemon-reload did not work"
  systemctl --user enable "$WP_SERVICE" || fail "systemctl --user enable $WP_SERVICE did not work"
  systemctl --user restart "$WP_SERVICE" || fail "systemctl --user restart $WP_SERVICE did not work (see: journalctl --user -u $WP_SERVICE)"

  cat <<EOF

Watchbell runs as a systemd user service and starts when you log in.
  Status:  systemctl --user status $WP_SERVICE
  Logs:    journalctl --user -u $WP_SERVICE -f
  Stop:    systemctl --user stop $WP_SERVICE
EOF
  # Suggested only (never run), and only when lingering is not on already.
  local linger=""
  if command -v loginctl >/dev/null 2>&1; then
    linger="$(loginctl show-user "${USER:-$(id -un)}" -p Linger 2>/dev/null)" || linger=""
  fi
  if [ "$linger" != "Linger=yes" ]; then
    printf 'To keep it running after you log out and start it at boot, run once: loginctl enable-linger $USER\n'
  fi
}

main() {
  trap on_exit EXIT
  parse_args "$@"
  if [ "$WP_UPGRADE" -eq 1 ]; then do_upgrade; fi

  check_os
  check_node
  check_resources
  decide_service
  check_port

  ensure_env_file
  stop_running_service
  build_app
  setup_service

  WP_STEP="done"
  printf '\nOpen http://localhost:%s/setup — the one-time setup code is printed in the server log and saved in app/data/setup-code\n' "$WP_PORT"
}

main "$@"; exit
