#!/usr/bin/env bash
# Watchbell uninstaller for Linux. Run it from the folder it ships in: bash uninstall.sh
#
# It stops and removes the auto-start (the systemd user service watchbell.service) that install.sh created, but only when
# that service runs THIS folder; a service that belongs to another copy of Watchbell is left alone. It never
# deletes your data: app/data (the database) and app/.env (settings and the encryption key) stay, and it prints how to
# delete them by hand.
#
# Exit codes: 0 done (or nothing to do), 1 a step failed (the message names the step), 2 bad arguments.
set -euo pipefail

readonly SERVICE="watchbell"
# The name an earlier install of this folder used, when the product was still called Watchpost.
readonly LEGACY_SERVICE="watchpost"

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$REPO_DIR/app"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$SERVICE.service"
LEGACY_UNIT_FILE="$UNIT_DIR/$LEGACY_SERVICE.service"

YES=0
STEP="arguments"
REPORTED=0

usage() {
  cat <<'EOF'
Usage: bash uninstall.sh [options]

Stops and removes the Watchbell auto-start (the systemd user service
~/.config/systemd/user/watchbell.service, or watchpost.service from an earlier install of this folder). Your data is kept: app/data (the database) and app/.env (settings and
the encryption key) are never deleted; the script prints how to delete them by hand. If the service belongs to
another copy of Watchbell (another folder), it is left alone and the script says which folder it runs.

Options:
  --yes    Do not ask for confirmation.
  --help   Show this help.

Exit codes: 0 done, 1 a step failed (the message names the step), 2 bad arguments.
EOF
}

say() { printf '==> %s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }

fail() {
  REPORTED=1
  printf '\nuninstall.sh: step "%s" failed: %s\n' "$STEP" "$*" >&2
  exit 1
}

bad_arg() {
  REPORTED=1
  printf 'uninstall.sh: %s\nRun bash uninstall.sh --help to see the options.\n' "$*" >&2
  exit 2
}

on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$REPORTED" -eq 0 ]; then
    printf '\nuninstall.sh: step "%s" failed unexpectedly (exit code %s).\n' "$STEP" "$rc" >&2
    exit 1
  fi
}

# Quote a path for a command the user copies into a shell.
shquote() { printf "'%s'" "$(printf '%s' "$1" | sed -e "s/'/'\\\\''/g")"; }

ask() {
  if [ "$YES" -eq 1 ]; then
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

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes | -y) YES=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) bad_arg "unknown option: $1" ;;
    esac
    shift
  done
}

has_user_systemd() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

remove_service() {
  STEP="remove auto-start"
  if [ ! -f "$UNIT_FILE" ]; then
    say "No Watchbell service found ($UNIT_FILE does not exist); nothing to stop."
    printf 'If you started Watchbell by hand (npm run start:selfhost), stop it with Ctrl+C in its terminal or with: cd app && npm run stop:selfhost\n'
    return 0
  fi
  # The unit is shared by every copy of Watchbell under this user: only remove it when it runs THIS copy.
  # install.sh writes the folder with a literal % doubled (systemd specifier syntax), so compare that form.
  local wd mine="${APP_DIR//%/%%}"
  wd="$(sed -n 's/^WorkingDirectory=//p' "$UNIT_FILE" | tail -n 1)" || wd=""
  if [ "$wd" != "$mine" ]; then
    if [ -n "$wd" ]; then
      say "$UNIT_FILE belongs to another copy of Watchbell (it runs $wd, not $APP_DIR); it is left as it is and its service keeps running."
    else
      say "$UNIT_FILE has no WorkingDirectory= line, so it cannot be tied to this folder ($APP_DIR); it is left as it is."
    fi
    return 0
  fi
  if ! ask "Stop Watchbell and remove its auto-start ($UNIT_FILE, which runs $APP_DIR)?"; then
    say "Cancelled; nothing was changed."
    exit 0
  fi
  if has_user_systemd; then
    systemctl --user disable --now "$SERVICE" || fail "systemctl --user disable --now $SERVICE did not work (see the message above). Nothing was removed."
  else
    warn "systemd user services are not available in this session, so the service could not be stopped here. If it is still running, stop it after the next login with: systemctl --user stop $SERVICE"
  fi
  rm -f -- "$UNIT_FILE" || fail "could not delete $UNIT_FILE"
  if has_user_systemd; then
    systemctl --user daemon-reload || warn "systemctl --user daemon-reload did not work"
    systemctl --user reset-failed "$SERVICE" >/dev/null 2>&1 || true
  fi
  say "Stopped Watchbell and removed $UNIT_FILE"
}

print_kept() {
  STEP="done"
  cat <<EOF

Your data was kept:
  Database:                          $APP_DIR/data
  Settings and the encryption key:   $APP_DIR/.env
To delete them for good (this cannot be undone; without app/.env the tokens saved in the database can never be
read again), run:
  rm -rf $(shquote "$APP_DIR/data")
  rm -f $(shquote "$APP_DIR/.env")
To remove the program too, delete the folder $(shquote "$REPO_DIR").
Node.js stays installed. If you installed it with nvm only for Watchbell: nvm uninstall 24
If you ran loginctl enable-linger only for Watchbell, undo it with: loginctl disable-linger \$USER
EOF
}

# The service an earlier install of this folder created under the old name (watchpost.service): removed the same way,
# only when it runs THIS folder, and silently skipped when there is none.
remove_legacy_service() {
  STEP="remove auto-start"
  [ -f "$LEGACY_UNIT_FILE" ] || return 0
  local wd mine="${APP_DIR//%/%%}"
  wd="$(sed -n 's/^WorkingDirectory=//p' "$LEGACY_UNIT_FILE" | tail -n 1)" || wd=""
  [ "$wd" = "$mine" ] || return 0
  if ! ask "Stop and remove the older auto-start too ($LEGACY_UNIT_FILE, from before Watchpost was renamed Watchbell; it runs $APP_DIR)?"; then
    say "The older $LEGACY_UNIT_FILE was left as it is."
    return 0
  fi
  if has_user_systemd; then
    systemctl --user disable --now "$LEGACY_SERVICE" || fail "systemctl --user disable --now $LEGACY_SERVICE did not work (see the message above). Nothing was removed."
  else
    warn "systemd user services are not available in this session, so the service could not be stopped here. If it is still running, stop it after the next login with: systemctl --user stop $LEGACY_SERVICE"
  fi
  rm -f -- "$LEGACY_UNIT_FILE" || fail "could not delete $LEGACY_UNIT_FILE"
  if has_user_systemd; then
    systemctl --user daemon-reload || warn "systemctl --user daemon-reload did not work"
    systemctl --user reset-failed "$LEGACY_SERVICE" >/dev/null 2>&1 || true
  fi
  say "Stopped the older service and removed $LEGACY_UNIT_FILE"
}

main() {
  trap on_exit EXIT
  parse_args "$@"
  remove_service
  remove_legacy_service
  print_kept
}

main "$@"; exit
