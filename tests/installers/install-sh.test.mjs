// Tests for install.sh / uninstall.sh. They run the real scripts with bash against a scratch copy of a minimal
// repo layout, with stub executables first on PATH (node, npm, systemctl, git, curl, ss, uname, df, loginctl) that
// record their arguments in a log. The stub `node` answers `--version` from FAKE_NODE_VERSION and hands everything
// else (secret generation, the port probe) to the real node. Nothing touches the real systemd, npm or network.
// On Windows this needs Git for Windows' bash (never WSL's); set WATCHBELL_TEST_BASH to pick one explicitly.
// Scratch folders go under WATCHBELL_TEST_TMP or <repo>/.cache/tmp, never the system temp folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import crypto from 'node:crypto'

const HERE = import.meta.dirname
const ROOT = path.resolve(HERE, '..', '..') // the folder holding install.sh (public-edition/ here, the repo root in the export)
const IS_WIN = process.platform === 'win32'

function repoRoot() {
  for (let d = ROOT; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d
    if (path.dirname(d) === d) return ROOT
  }
}
const TMP_BASE = process.env.WATCHBELL_TEST_TMP ?? process.env.WATCHPOST_TEST_TMP ?? path.join(repoRoot(), '.cache', 'tmp')

function findBash() {
  const forced = process.env.WATCHBELL_TEST_BASH ?? process.env.WATCHPOST_TEST_BASH
  if (forced) return forced
  if (!IS_WIN) return 'bash'
  const candidates = []
  try {
    const gits = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin; bash.exe in <Git>\bin.
    for (const g of gits) for (let d = path.dirname(g), i = 0; i < 3; d = path.dirname(d), i++) candidates.push(path.join(d, 'bin', 'bash.exe'))
  } catch {
    // no git on PATH; fall through to the default location
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe')
  return candidates.find((c) => fs.existsSync(c) && !/system32/i.test(c)) ?? null
}
const BASH = findBash()
const SKIP = BASH ? false : 'no Git Bash found (set WATCHBELL_TEST_BASH)'

/** A path as bash sees it (D:\a b\c -> /d/a b/c on Windows). */
const toBash = (p) => (IS_WIN ? p.replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()).replace(/\\/g, '/') : p)

const STUB_LOG_FN = `log() { { printf '%s' "$STUB_NAME"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$WATCHBELL_STUB_LOG"; }`

const STUBS = {
  node: `
if [ "\${1:-}" = "--version" ] || [ "\${1:-}" = "-v" ]; then
  log --version
  if [ -z "\${FAKE_NODE_VERSION:-}" ]; then echo "node: not found" >&2; exit 127; fi
  echo "v$FAKE_NODE_VERSION"; exit 0
fi
# FAKE_TZ stands in for this computer's time zone (Git Bash doesn't pass TZ on to a Windows node).
if [ -n "\${FAKE_TZ+x}" ] && [ "\${1:-}" = "-e" ] && [[ "\${2:-}" == *resolvedOptions* ]]; then
  log -e timeZone
  printf '%s' "$FAKE_TZ"; exit 0
fi
log "$1"
exec "$REAL_NODE" "$@"`,
  npm: `
{ printf 'npm'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\tcwd=%s\\tmode=%s\\n' "$(pwd)" "\${WATCHBELL_MODE:-}"; } >> "$WATCHBELL_STUB_LOG"
case "\${1:-}" in
  --version) echo 11.6.2 ;;
  ci) exit "\${FAKE_NPM_CI_EXIT:-0}" ;;
  run) exit "\${FAKE_NPM_BUILD_EXIT:-0}" ;;
esac`,
  systemctl: `
log "$@"
if [ -n "\${FAKE_NO_SYSTEMD:-}" ]; then echo "Failed to connect to bus" >&2; exit 1; fi
case " $* " in
  *" is-active "*) [ -n "\${FAKE_SERVICE_ACTIVE:-}" ] && exit 0; exit 3 ;;
esac
exit 0`,
  git: `
log "$@"
case " $* " in
  *" rev-parse "*)
    [ -n "\${FAKE_GIT_NOT_REPO:-}" ] && exit 128
    case " $* " in
      *" --show-toplevel "*) if [ -n "\${FAKE_GIT_TOPLEVEL:-}" ]; then echo "$FAKE_GIT_TOPLEVEL"; else echo "$2"; fi ;;
      *) echo true ;;
    esac ;;
  *" status "*) printf '%s' "\${FAKE_GIT_STATUS:-}" ;;
  *" pull "*) exit 0 ;;
esac`,
  curl: `
log "$@"
printf 'd="\${NVM_DIR:-$HOME/.nvm}"; mkdir -p "$d"; cp "%s" "$d/nvm.sh"\\n' "$WATCHBELL_STUB_DIR/fake-nvm.sh"`,
  wget: `
log "$@"
exit 1`,
  ss: `
log "$@"
[ -n "\${FAKE_SS_FAIL:-}" ] && exit 1
echo "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process"
echo "LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*"
[ -n "\${FAKE_SS_LISTEN:-}" ] && echo "LISTEN 0      511    0.0.0.0:$FAKE_SS_LISTEN      0.0.0.0:*"
exit 0`,
  uname: `
echo "\${FAKE_UNAME:-Linux}"`,
  df: `
log "$@"
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/sda1 100000000 1000 \${FAKE_DF_AVAIL_KB:-50000000} 1% /"`,
  loginctl: `
log "$@"
case " $* " in *" show-user "*) echo "Linger=\${FAKE_LINGER:-no}" ;; esac`,
}

// What the stub curl's "nvm installer" puts in $NVM_DIR/nvm.sh. Like the real nvm.sh it declares locals with common
// names (NVM_VERSION, VERSION, PROVIDED_VERSION), so a readonly variable of the same name in the shell that sources it
// breaks it (the bug seen on a fresh Ubuntu 22.04). `nvm install 24` creates versions/node/v24.11.1/bin/{node,npm}
// wrappers around the stubs; `use` / `which` / `version` answer from that folder, as the real ones do.
const FAKE_NVM = `nvm() {
  local NVM_VERSION="" || { echo "fake nvm: NVM_VERSION is readonly in the calling shell" >&2; return 3; }
  local VERSION="" PROVIDED_VERSION="" || return 3
  { printf 'nvm'; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$WATCHBELL_STUB_LOG"
  local bin="$NVM_DIR/versions/node/v24.11.1/bin"
  case "$1" in
    install)
      [ "$2" = 24 ] || { echo "fake nvm: only 24 is available" >&2; return 3; }
      mkdir -p "$bin"
      printf '#!/usr/bin/env bash\\nFAKE_NODE_VERSION=24.11.1 exec "$WATCHBELL_STUB_DIR/node" "$@"\\n' > "$bin/node"
      printf '#!/usr/bin/env bash\\nexec "$WATCHBELL_STUB_DIR/npm" "$@"\\n' > "$bin/npm"
      chmod +x "$bin/node" "$bin/npm"
      echo "Now using node v24.11.1" ;;
    use) [ -x "$bin/node" ] || { echo "N/A: version \\"$2\\" is not yet installed." >&2; return 3; }; PATH="$bin:$PATH" ;;
    which) [ -x "$bin/node" ] || { echo "N/A: version \\"$2\\" is not yet installed." >&2; return 1; }; echo "$bin/node" ;;
    version) if [ -x "$bin/node" ]; then echo v24.11.1; else echo N/A; return 3; fi ;;
  esac
}
`

/** Builds a scratch "repo" (install.sh, uninstall.sh, app/) plus a home folder and the stubs. */
function scratch({ spaces = false } = {}) {
  fs.mkdirSync(TMP_BASE, { recursive: true })
  const base = fs.mkdtempSync(path.join(TMP_BASE, 'install-sh-'))
  const repo = path.join(base, spaces ? 'my apps' : 'apps', 'watchbell')
  const home = path.join(base, spaces ? 'home of Jane Doe' : 'home')
  const stubs = path.join(base, spaces ? 'stub bin' : 'stubbin')
  const log = path.join(base, 'stub.log')
  for (const d of [path.join(repo, 'app', 'scripts'), home, stubs]) fs.mkdirSync(d, { recursive: true })
  for (const f of ['install.sh', 'uninstall.sh']) fs.copyFileSync(path.join(ROOT, f), path.join(repo, f))
  fs.writeFileSync(path.join(repo, 'app', 'package.json'), '{ "name": "watchbell", "private": true }\n')
  fs.writeFileSync(path.join(repo, 'app', 'scripts', 'start-selfhost.mjs'), '// stub\n')
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(stubs, name), `#!/usr/bin/env bash\nSTUB_NAME=${name}\n${STUB_LOG_FN}\n${body.trim()}\n`, {
      mode: 0o755,
    })
  }
  fs.writeFileSync(path.join(stubs, 'fake-nvm.sh'), FAKE_NVM)
  fs.writeFileSync(log, '')
  const app = path.join(repo, 'app')
  return {
    base,
    repo,
    app,
    home,
    stubs,
    envFile: path.join(app, '.env'),
    unitFile: path.join(home, '.config', 'systemd', 'user', 'watchbell.service'),
    log: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')),
    run(script, args = [], { env = {}, input = '' } = {}) {
      const childEnv = { ...process.env }
      for (const k of Object.keys(childEnv)) if (/^(FAKE_|NVM_|XDG_CONFIG_HOME$|SUDO_USER$)/.test(k)) delete childEnv[k]
      Object.assign(childEnv, {
        HOME: toBash(home),
        TMPDIR: toBash(base),
        WATCHBELL_STUB_DIR: toBash(stubs),
        WATCHBELL_STUB_LOG: toBash(log),
        REAL_NODE: toBash(process.execPath),
        FAKE_NODE_VERSION: '24.11.1',
        ...env,
      })
      for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k]
      // Stubs first on PATH inside bash itself (Git Bash's launcher prepends its own folders to PATH).
      const boot = 'PATH="$WATCHBELL_STUB_DIR:/usr/bin:/bin:$PATH"; export PATH; exec bash "$@"'
      const r = spawnSync(BASH, ['-c', boot, 'bash', toBash(path.join(repo, script)), ...args], {
        env: childEnv,
        input,
        encoding: 'utf8',
        timeout: 120_000,
      })
      return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '', error: r.error }
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  }
}

const readEnv = (file) => {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd())
    if (m) out[m[1]] = m[2]
  }
  return out
}
const keyLines = (file, key) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith(`${key}=`))
const calls = (s, name) => s.log().filter((l) => l[0] === name)
const npmSteps = (s) =>
  calls(s, 'npm')
    .filter((l) => l[1] === 'ci' || l[1] === 'run')
    .map((l) => ({ cmd: l.slice(1).filter((a) => !a.startsWith('cwd=') && !a.startsWith('mode=')).join(' '), cwd: l.find((a) => a.startsWith('cwd='))?.slice(4), mode: l.find((a) => a.startsWith('mode='))?.slice(5) }))

const SETUP_LINE = (port) =>
  `Open http://localhost:${port}/setup — the one-time setup code is printed in the server log and saved in app/data/setup-code`

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

test('the scripts have LF line endings (bash on Linux fails on CRLF)', () => {
  for (const f of ['install.sh', 'uninstall.sh']) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    assert.ok(text.startsWith('#!/usr/bin/env bash\n'), `${f} shebang`)
    assert.ok(!text.includes('\r'), `${f} contains CR characters`)
  }
})

test('--help lists every flag and exits 0', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--help'])
    assert.equal(r.code, 0, r.out)
    for (const flag of ['--yes', '--no-service', '--port <n>', '--upgrade', '--help']) assert.ok(r.stdout.includes(flag), `missing ${flag}`)
    const u = s.run('uninstall.sh', ['--help'])
    assert.equal(u.code, 0, u.out)
    for (const flag of ['--yes', '--help']) assert.ok(u.stdout.includes(flag), `uninstall missing ${flag}`)
    assert.deepEqual(calls(s, 'npm'), [])
  } finally {
    s.cleanup()
  }
})

test('bad arguments exit 2 without doing anything', { skip: SKIP }, () => {
  const s = scratch()
  try {
    for (const args of [['--bogus'], ['--port'], ['--port', 'abc'], ['--port', '70000'], ['--port=0']]) {
      const r = s.run('install.sh', args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
    }
    assert.equal(s.run('uninstall.sh', ['--nope']).code, 2)
    assert.equal(fs.existsSync(s.envFile), false)
    assert.deepEqual(s.log(), [])
  } finally {
    s.cleanup()
  }
})

test('fresh install with --yes: .env with every key, npm ci then build, service unit, setup URL', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--yes', '--port', '3311'])
    assert.equal(r.code, 0, r.out)

    const env = readEnv(s.envFile)
    assert.equal(env.WATCHBELL_MODE, 'selfhost')
    assert.equal(env.DATABASE_URL, 'pglite:')
    assert.equal(env.WATCHBELL_DATA_DIR, './data')
    assert.equal(env.HOST, '127.0.0.1')
    assert.equal(env.PORT, '3311')
    assert.equal(env.SITE_URL, 'http://localhost:3311')
    assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, 'base64').length, 32)
    assert.match(env.OPS_ENCRYPTION_KEY, /^[A-Za-z0-9+/]{43}=$/)
    assert.match(env.COLLECTOR_SECRET, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(env.COLLECTOR_SECRET, 'base64url').length, 32)
    assert.match(env.CRON_SECRET, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(Buffer.from(env.CRON_SECRET, 'base64url').length, 24)
    // Secrets are never printed.
    for (const k of ['OPS_ENCRYPTION_KEY', 'COLLECTOR_SECRET', 'CRON_SECRET']) assert.ok(!r.out.includes(env[k]), `${k} was printed`)
    // Mode 600 (Git Bash on Windows has no Unix modes, so only checked on Linux/macOS).
    if (!IS_WIN) assert.equal(fs.statSync(s.envFile).mode & 0o777, 0o600)

    const steps = npmSteps(s)
    assert.deepEqual(
      steps.map((x) => x.cmd),
      ['ci', 'run build'],
    )
    for (const x of steps) assert.equal(x.cwd, toBash(s.app))
    assert.equal(steps[1].mode, 'selfhost')

    const unit = fs.readFileSync(s.unitFile, 'utf8')
    assert.ok(unit.includes(`WorkingDirectory=${toBash(s.app)}\n`), unit)
    assert.ok(unit.includes(`EnvironmentFile=${toBash(s.app)}/.env\n`), unit)
    assert.ok(unit.includes(`ExecStart="${toBash(s.stubs)}/node" scripts/start-selfhost.mjs\n`), unit)
    for (const line of ['Restart=on-failure', 'KillSignal=SIGTERM', 'TimeoutStopSec=30', 'WantedBy=default.target'])
      assert.ok(unit.includes(`${line}\n`), `unit lacks ${line}`)

    const sc = calls(s, 'systemctl').map((l) => l.slice(1).join(' '))
    const reload = sc.indexOf('--user daemon-reload')
    assert.ok(reload >= 0 && sc.indexOf('--user enable watchbell') > reload && sc.indexOf('--user restart watchbell') > reload, sc.join('\n'))

    assert.ok(r.out.includes('systemctl --user status watchbell'))
    assert.ok(r.out.includes('journalctl --user -u watchbell -f'))
    assert.ok(r.out.includes('loginctl enable-linger'))
    assert.ok(!calls(s, 'loginctl').some((l) => l.includes('enable-linger')), 'loginctl enable-linger must never be run')
    assert.deepEqual(calls(s, 'curl'), [], 'nothing is downloaded when Node 24 is present')
    assert.ok(r.stdout.trimEnd().endsWith(SETUP_LINE(3311)), r.stdout)
  } finally {
    s.cleanup()
  }
})

test('the service unit is written only with consent', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const no = s.run('install.sh', ['--port', '3312'], { input: 'n\n' })
    assert.equal(no.code, 0, no.out)
    assert.ok(no.out.includes('[y/N]'), 'asked about the service')
    assert.equal(fs.existsSync(s.unitFile), false)
    // start-selfhost.mjs reads PORT from app/.env, so the start line has no PORT= prefix.
    assert.ok(no.out.includes('\n  cd app && npm run start:selfhost\n'), no.out)
    assert.ok(!no.out.includes('PORT=3312 npm'), no.out)
    assert.ok(!calls(s, 'systemctl').some((l) => l.includes('enable')), 'nothing enabled')

    const noService = s.run('install.sh', ['--yes', '--no-service'])
    assert.equal(noService.code, 0, noService.out)
    assert.equal(fs.existsSync(s.unitFile), false)

    // No user systemd (containers, WSL without systemd): no question, the start command instead.
    fs.rmSync(s.envFile)
    const noSystemd = s.run('install.sh', [], { env: { FAKE_NO_SYSTEMD: '1' } })
    assert.equal(noSystemd.code, 0, noSystemd.out)
    assert.ok(noSystemd.out.includes('cd app && npm run start:selfhost'), noSystemd.out)
    assert.ok(!noSystemd.out.includes('[y/N]'))
    assert.equal(fs.existsSync(s.unitFile), false)

    const yes = s.run('install.sh', [], { input: 'y\n' })
    assert.equal(yes.code, 0, yes.out)
    assert.ok(fs.existsSync(s.unitFile))
  } finally {
    s.cleanup()
  }
})

test('re-run keeps every existing value, adds only missing keys and rebuilds', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--no-service', '--port', '3313']).code, 0)
    const first = readEnv(s.envFile)
    // The user edits the file: removes CRON_SECRET, adds their own key, empties nothing else.
    const edited = fs
      .readFileSync(s.envFile, 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('CRON_SECRET='))
      .concat(['TELEGRAM_BOT_TOKEN=123:abc # mine', ''])
      .join('\n')
    fs.writeFileSync(s.envFile, edited)
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')

    const r = s.run('install.sh', ['--yes', '--no-service', '--port', '4000'])
    assert.equal(r.code, 0, r.out)
    const second = readEnv(s.envFile)
    for (const k of ['OPS_ENCRYPTION_KEY', 'COLLECTOR_SECRET', 'PORT', 'SITE_URL', 'HOST', 'WATCHBELL_MODE']) assert.equal(second[k], first[k], k)
    assert.equal(second.TELEGRAM_BOT_TOKEN, '123:abc # mine')
    assert.match(second.CRON_SECRET, /^[A-Za-z0-9_-]{32}$/)
    assert.notEqual(second.CRON_SECRET, first.CRON_SECRET)
    assert.equal(keyLines(s.envFile, 'OPS_ENCRYPTION_KEY').length, 1)
    assert.ok(r.out.includes('--port 4000 is ignored'), r.out)
    assert.ok(r.out.includes('added CRON_SECRET'), r.out)
    assert.ok(!r.out.includes(first.OPS_ENCRYPTION_KEY) && !r.out.includes(second.CRON_SECRET), 'secrets printed')
    assert.deepEqual(
      npmSteps(s).map((x) => x.cmd),
      ['ci', 'run build'],
    )
    assert.ok(r.stdout.includes(SETUP_LINE(3313)))

    // A third run with nothing missing leaves the file byte for byte.
    const before = fs.readFileSync(s.envFile, 'utf8')
    assert.equal(s.run('install.sh', ['--yes', '--no-service']).code, 0)
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), before)
  } finally {
    s.cleanup()
  }
})

test('an .env copied from .env.example gets its empty secrets filled in place, other values kept', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.writeFileSync(
      s.envFile,
      ['# my notes', 'WATCHBELL_MODE=selfhost', 'OPS_ENCRYPTION_KEY=', 'SITE_URL=https://watch.example.com', 'COLLECTOR_SECRET=""', 'HOST=0.0.0.0', ''].join('\n'),
    )
    const r = s.run('install.sh', ['--yes', '--no-service'])
    assert.equal(r.code, 0, r.out)
    const env = readEnv(s.envFile)
    assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, 'base64').length, 32)
    assert.match(env.COLLECTOR_SECRET, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(env.SITE_URL, 'https://watch.example.com')
    assert.equal(env.HOST, '0.0.0.0')
    assert.equal(env.PORT, '3100')
    assert.equal(keyLines(s.envFile, 'OPS_ENCRYPTION_KEY').length, 1)
    assert.equal(keyLines(s.envFile, 'COLLECTOR_SECRET').length, 1)
    const text = fs.readFileSync(s.envFile, 'utf8')
    assert.ok(text.startsWith('# my notes\nWATCHBELL_MODE=selfhost\nOPS_ENCRYPTION_KEY='), text)
  } finally {
    s.cleanup()
  }
})

test('paths with spaces: npm runs in the right folder, the unit and uninstall work', { skip: SKIP }, () => {
  const s = scratch({ spaces: true })
  try {
    assert.ok(s.repo.includes('my apps') && s.home.includes(' '))
    const r = s.run('install.sh', ['--yes', '--port', '3314'])
    assert.equal(r.code, 0, r.out)
    assert.ok(fs.existsSync(s.envFile))
    for (const x of npmSteps(s)) assert.equal(x.cwd, toBash(s.app))
    const unit = fs.readFileSync(s.unitFile, 'utf8')
    assert.ok(unit.includes(`WorkingDirectory=${toBash(s.app)}\n`), unit)
    assert.ok(unit.includes(`EnvironmentFile=${toBash(s.app)}/.env\n`), unit)
    assert.ok(unit.includes(`ExecStart="${toBash(s.stubs)}/node" scripts/start-selfhost.mjs\n`), unit)

    const u = s.run('uninstall.sh', ['--yes'])
    assert.equal(u.code, 0, u.out)
    assert.equal(fs.existsSync(s.unitFile), false)
    assert.ok(fs.existsSync(s.envFile))
    assert.ok(u.out.includes(`rm -rf '${toBash(s.app)}/data'`), u.out)
  } finally {
    s.cleanup()
  }
})

test('Node 22 and the user declines: manual steps, exit 1, nothing written or downloaded', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', [], { env: { FAKE_NODE_VERSION: '22.11.0' }, input: 'n\n' })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('Found: v22.11.0'), r.out)
    assert.ok(r.out.includes('nvm install 24'), r.out)
    assert.ok(r.out.includes('https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh'), r.out)
    assert.ok(r.out.includes('https://nodejs.org/en/download'), r.out)
    assert.ok(r.out.includes('step "prerequisites (Node.js)" failed'), r.out)
    assert.equal(fs.existsSync(s.envFile), false)
    assert.equal(fs.existsSync(path.join(s.home, '.nvm')), false)
    assert.deepEqual(calls(s, 'curl'), [])
    assert.deepEqual(calls(s, 'npm'), [])

    // No answer at all (no terminal) counts as no.
    const silent = s.run('install.sh', [], { env: { FAKE_NODE_VERSION: '' } })
    assert.equal(silent.code, 1, silent.out)
    assert.ok(silent.out.includes('Found: none'), silent.out)
    assert.equal(fs.existsSync(s.envFile), false)
  } finally {
    s.cleanup()
  }
})

for (const [label, version] of [
  ['missing', ''],
  ['an old system Node 20 (fresh Ubuntu 22.04)', '20.20.2'],
]) {
  test(`Node ${label} and the user agrees: nvm from the pinned URL, nvm install/use/which 24, that node everywhere`, { skip: SKIP }, () => {
    const s = scratch({ spaces: true })
    try {
      const r = s.run('install.sh', ['--port', '3318'], { env: { FAKE_NODE_VERSION: version }, input: 'y\ny\n' })
      assert.equal(r.code, 0, r.out)
      assert.ok(!r.out.includes('readonly'), r.out)
      const curl = calls(s, 'curl')
      assert.equal(curl.length, 1)
      assert.ok(curl[0].includes('https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh'))
      const nvm = calls(s, 'nvm').map((l) => l.slice(1).join(' '))
      for (const c of ['install 24', 'use 24', 'which 24']) assert.ok(nvm.includes(c), `nvm ${c} not called:\n${nvm.join('\n')}`)
      assert.ok(nvm.indexOf('install 24') < nvm.lastIndexOf('which 24'))

      const nodeBin = `${toBash(s.home)}/.nvm/versions/node/v24.11.1/bin/node`
      assert.ok(r.out.includes(`Node.js v24.11.1 (${nodeBin})`), r.out)
      // The unit runs nvm's Node 24 by its absolute path, not whatever node is first on PATH.
      const unit = fs.readFileSync(s.unitFile, 'utf8')
      assert.ok(unit.includes(`ExecStart="${nodeBin}" scripts/start-selfhost.mjs\n`), unit)
      const env = readEnv(s.envFile)
      assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, 'base64').length, 32)
      const steps = npmSteps(s)
      assert.deepEqual(
        steps.map((x) => x.cmd),
        ['ci', 'run build'],
      )
      for (const x of steps) assert.equal(x.cwd, toBash(s.app))
      assert.ok(r.out.includes(SETUP_LINE(3318)), r.out)
    } finally {
      s.cleanup()
    }
  })
}

test('system Node 22 but nvm already has Node 24: uses it without asking or downloading', { skip: SKIP }, () => {
  const s = scratch()
  try {
    // Install nvm + Node 24 the way the fake installer does, then run with an old system node.
    const nvmDir = path.join(s.home, '.nvm')
    fs.mkdirSync(nvmDir, { recursive: true })
    fs.copyFileSync(path.join(s.stubs, 'fake-nvm.sh'), path.join(nvmDir, 'nvm.sh'))
    const prep = spawnSync(BASH, ['-c', '. "$NVM_DIR/nvm.sh"; nvm install 24 >/dev/null'], {
      env: { ...process.env, NVM_DIR: toBash(nvmDir), WATCHBELL_STUB_LOG: toBash(path.join(s.base, 'stub.log')) },
      encoding: 'utf8',
    })
    assert.equal(prep.status, 0, prep.stderr)
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')

    const r = s.run('install.sh', ['--yes', '--port', '3319'], { env: { FAKE_NODE_VERSION: '22.11.0' } })
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes('Install Node.js 24 with nvm now?'), r.out)
    assert.deepEqual(calls(s, 'curl'), [])
    const nvm = calls(s, 'nvm').map((l) => l.slice(1).join(' '))
    assert.ok(!nvm.includes('install 24') && nvm.includes('which 24'), nvm.join('\n'))
    const unit = fs.readFileSync(s.unitFile, 'utf8')
    assert.ok(unit.includes(`ExecStart="${toBash(nvmDir)}/versions/node/v24.11.1/bin/node" scripts/start-selfhost.mjs\n`), unit)
  } finally {
    s.cleanup()
  }
})

test('busy port (ss): says so before building, suggests --port, writes nothing', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--yes', '--port', '3315'], { env: { FAKE_SS_LISTEN: '3315' } })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('port 3315 is already in use'), r.out)
    assert.ok(r.out.includes('--port'), r.out)
    assert.deepEqual(calls(s, 'npm').filter((l) => l[1] !== '--version'), [])
    assert.equal(fs.existsSync(s.envFile), false)
    assert.equal(fs.existsSync(s.unitFile), false)
  } finally {
    s.cleanup()
  }
})

test('busy port without ss: the node probe finds it', { skip: SKIP }, async () => {
  const s = scratch()
  const port = await freePort()
  const server = net.createServer()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  try {
    // spawnSync blocks this process, but the listening socket stays bound in the kernel, so the probe sees it.
    const r = s.run('install.sh', ['--yes', '--port', String(port)], { env: { FAKE_SS_FAIL: '1' } })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes(`port ${port} is already in use`), r.out)
    assert.deepEqual(calls(s, 'npm').filter((l) => l[1] !== '--version'), [])
  } finally {
    server.close()
    s.cleanup()
  }
  const s2 = scratch()
  try {
    const free = await freePort()
    const r = s2.run('install.sh', ['--yes', '--no-service', '--port', String(free)], { env: { FAKE_SS_FAIL: '1' } })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.includes(`Port ${free} is free`), r.out)
  } finally {
    s2.cleanup()
  }
})

test('re-run while the service runs: the busy port is ours; stop, rebuild, refresh the unit and restart', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3316']).code, 0)
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const r = s.run('install.sh', [], { env: { FAKE_SS_LISTEN: '3316', FAKE_SERVICE_ACTIVE: '1' } })
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.out.includes('[y/N]'), 'an existing unit is refreshed without asking again')
    const log = s.log().map((l) => l.slice(0, 2).join(' ') + ' ' + l.slice(2).join(' '))
    const stop = log.findIndex((l) => l.startsWith('systemctl --user stop'))
    const ci = log.findIndex((l) => l.startsWith('npm ci'))
    const restart = log.findIndex((l) => l.startsWith('systemctl --user restart'))
    assert.ok(stop >= 0 && stop < ci && ci < restart, log.join('\n'))
  } finally {
    s.cleanup()
  }
})

test('--upgrade: git pull --ff-only only on a clean checkout, then the normal steps', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--upgrade', '--yes', '--no-service'])
    assert.equal(r.code, 0, r.out)
    const git = calls(s, 'git').map((l) => l.slice(1).join(' '))
    assert.ok(git.some((l) => l.endsWith('status --porcelain --untracked-files=no')), git.join('\n'))
    assert.ok(git.some((l) => l.endsWith('pull --ff-only')), git.join('\n'))
    assert.deepEqual(
      npmSteps(s).map((x) => x.cmd),
      ['ci', 'run build'],
    )

    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const dirty = s.run('install.sh', ['--upgrade', '--yes'], { env: { FAKE_GIT_STATUS: ' M app/src/x.ts\n' } })
    assert.equal(dirty.code, 1, dirty.out)
    assert.ok(dirty.out.includes('step "upgrade" failed'), dirty.out)
    assert.ok(!calls(s, 'git').some((l) => l.includes('pull')))
    assert.deepEqual(calls(s, 'npm'), [])

    const notRepo = s.run('install.sh', ['--upgrade'], { env: { FAKE_GIT_NOT_REPO: '1' } })
    assert.equal(notRepo.code, 1, notRepo.out)
    assert.ok(notRepo.out.includes('not a git checkout'), notRepo.out)
  } finally {
    s.cleanup()
  }
})

test('other prerequisites: not Linux, too little disk, a failing build each exit 1 naming the step', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const mac = s.run('install.sh', ['--yes'], { env: { FAKE_UNAME: 'Darwin' } })
    assert.equal(mac.code, 1, mac.out)
    assert.ok(mac.out.includes('step "prerequisites (system)" failed') && mac.out.includes('macOS'), mac.out)

    const disk = s.run('install.sh', ['--yes'], { env: { FAKE_DF_AVAIL_KB: '1048576' } })
    assert.equal(disk.code, 1, disk.out)
    assert.ok(disk.out.includes('step "prerequisites (disk)" failed'), disk.out)
    assert.equal(fs.existsSync(s.envFile), false)

    const build = s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_NPM_BUILD_EXIT: '1' } })
    assert.equal(build.code, 1, build.out)
    assert.ok(build.out.includes('step "npm run build" failed'), build.out)
  } finally {
    s.cleanup()
  }
})

test('uninstall.sh stops and removes the unit, keeps app/data and app/.env, prints both paths', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3317']).code, 0)
    fs.mkdirSync(path.join(s.app, 'data'), { recursive: true })
    fs.writeFileSync(path.join(s.app, 'data', 'setup-code'), crypto.randomUUID())
    const envBefore = fs.readFileSync(s.envFile, 'utf8')

    const declined = s.run('uninstall.sh', [], { input: 'n\n' })
    assert.equal(declined.code, 0, declined.out)
    assert.ok(fs.existsSync(s.unitFile), 'declining keeps the unit')

    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const r = s.run('uninstall.sh', ['--yes'])
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.existsSync(s.unitFile), false)
    const sc = calls(s, 'systemctl').map((l) => l.slice(1).join(' '))
    assert.ok(sc.includes('--user disable --now watchbell'), sc.join('\n'))
    assert.ok(sc.includes('--user daemon-reload'), sc.join('\n'))
    assert.ok(fs.existsSync(path.join(s.app, 'data', 'setup-code')))
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), envBefore)
    assert.ok(r.out.includes(`${toBash(s.app)}/data`) && r.out.includes(`${toBash(s.app)}/.env`), r.out)
    assert.ok(r.out.includes('rm -rf') && r.out.includes('rm -f'), r.out)

    const again = s.run('uninstall.sh', ['--yes'])
    assert.equal(again.code, 0, again.out)
    assert.ok(again.out.includes('No Watchbell service found'), again.out)
  } finally {
    s.cleanup()
  }
})

test('--upgrade refuses when this folder is not its own git checkout (an archive inside another repo)', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--upgrade', '--yes'], { env: { FAKE_GIT_TOPLEVEL: toBash(s.base) } })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('step "upgrade" failed') && r.out.includes("isn't its own git checkout"), r.out)
    assert.ok(!calls(s, 'git').some((l) => l.includes('pull')), 'the parent repository must never be pulled')
    assert.deepEqual(calls(s, 'npm'), [])
    assert.equal(fs.existsSync(s.envFile), false)
  } finally {
    s.cleanup()
  }
})

test('a failed npm ci / build after the service was stopped says Watchbell is stopped and how to start it', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3320']).code, 0)
    for (const [fakeEnv, step] of [
      [{ FAKE_NPM_CI_EXIT: '1' }, 'npm ci'],
      [{ FAKE_NPM_BUILD_EXIT: '1' }, 'npm run build'],
    ]) {
      fs.writeFileSync(path.join(s.base, 'stub.log'), '')
      const r = s.run('install.sh', [], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3320', ...fakeEnv } })
      assert.equal(r.code, 1, r.out)
      assert.ok(r.out.includes(`step "${step}" failed`), r.out)
      assert.ok(r.out.includes('Watchbell is stopped now'), r.out)
      assert.ok(r.out.includes('systemctl --user start watchbell'), r.out)
      assert.ok(calls(s, 'systemctl').some((l) => l.slice(1).join(' ') === '--user stop watchbell'))
    }
    // Without a running service the failure does not talk about a stopped service.
    const plain = s.run('install.sh', [], { env: { FAKE_NPM_BUILD_EXIT: '1' } })
    assert.equal(plain.code, 1, plain.out)
    assert.ok(!plain.out.includes('Watchbell is stopped now'), plain.out)
  } finally {
    s.cleanup()
  }
})

test('an existing unit for another folder is repointed only with consent; declining leaves it and its service alone', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3321']).code, 0)
    const otherUnit = fs
      .readFileSync(s.unitFile, 'utf8')
      .replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/other copy/app')
      .replace(/^EnvironmentFile=.*$/m, 'EnvironmentFile=/srv/other copy/app/.env')
    fs.writeFileSync(s.unitFile, otherUnit)

    // Declined: the unit stays as it is, the other copy's service is not stopped or restarted, manual start printed.
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const no = s.run('install.sh', [], { env: { FAKE_SERVICE_ACTIVE: '1' }, input: 'n\n' })
    assert.equal(no.code, 0, no.out)
    assert.ok(no.out.includes('runs Watchbell from /srv/other copy/app'), no.out)
    assert.equal(fs.readFileSync(s.unitFile, 'utf8'), otherUnit)
    const sc = calls(s, 'systemctl').map((l) => l.slice(1).join(' '))
    assert.ok(!sc.some((c) => /^--user (stop|restart|enable|start) watchbell$/.test(c)), sc.join('\n'))
    assert.ok(no.out.includes('cd app && npm run start:selfhost'), no.out)

    // Declined while the other copy's service holds the port: the port is not "ours", so it is busy.
    const busy = s.run('install.sh', [], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3321' }, input: 'n\n' })
    assert.equal(busy.code, 1, busy.out)
    assert.ok(busy.out.includes('port 3321 is already in use'), busy.out)

    // --yes repoints it to this folder (stopping the running service before the rebuild).
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const yes = s.run('install.sh', ['--yes'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3321' } })
    assert.equal(yes.code, 0, yes.out)
    const unit = fs.readFileSync(s.unitFile, 'utf8')
    assert.ok(unit.includes(`WorkingDirectory=${toBash(s.app)}\n`), unit)
    const log = s.log().map((l) => l.join(' '))
    const at = (prefix) => log.findIndex((l) => l.startsWith(prefix))
    const stop = at('systemctl --user stop watchbell')
    assert.ok(stop >= 0 && stop < at('npm ci') && at('npm ci') < at('systemctl --user restart watchbell'), log.join('\n'))
  } finally {
    s.cleanup()
  }
})

test('the enable-linger hint is shown only when lingering is off, and never run', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const off = s.run('install.sh', ['--yes', '--port', '3322'])
    assert.equal(off.code, 0, off.out)
    assert.ok(off.out.includes('loginctl enable-linger $USER'), off.out)
    const on = s.run('install.sh', ['--yes'], { env: { FAKE_LINGER: 'yes' } })
    assert.equal(on.code, 0, on.out)
    assert.ok(!on.out.includes('enable-linger'), on.out)
    assert.ok(calls(s, 'loginctl').every((l) => l[1] === 'show-user'), 'only show-user is ever called')
  } finally {
    s.cleanup()
  }
})

test('uninstall.sh leaves a unit that belongs to another folder, says which, and exits 0', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3323']).code, 0)
    const otherUnit = fs
      .readFileSync(s.unitFile, 'utf8')
      .replace(/^WorkingDirectory=.*$/m, 'WorkingDirectory=/srv/other copy/app')
    fs.writeFileSync(s.unitFile, otherUnit)

    for (const args of [['--yes'], []]) {
      fs.writeFileSync(path.join(s.base, 'stub.log'), '')
      const r = s.run('uninstall.sh', args, { input: 'y\n' })
      assert.equal(r.code, 0, r.out)
      assert.equal(fs.readFileSync(s.unitFile, 'utf8'), otherUnit, 'the other copy\'s unit is untouched')
      assert.ok(r.out.includes('/srv/other copy/app'), r.out)
      assert.ok(!r.out.includes('[y/N]'), 'nothing to confirm when nothing is removed')
      assert.deepEqual(calls(s, 'systemctl'), [], 'its service is not stopped or reloaded')
    }
  } finally {
    s.cleanup()
  }
})

test('uninstall.sh shows the unit folder in the confirm prompt (path with spaces)', { skip: SKIP }, () => {
  const s = scratch({ spaces: true })
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3324']).code, 0)
    const declined = s.run('uninstall.sh', [], { input: 'n\n' })
    assert.equal(declined.code, 0, declined.out)
    assert.ok(declined.out.includes(`[y/N]`) && declined.out.includes(toBash(s.app)), declined.out)
    assert.ok(fs.existsSync(s.unitFile))
    const ok = s.run('uninstall.sh', [], { input: 'y\n' })
    assert.equal(ok.code, 0, ok.out)
    assert.equal(fs.existsSync(s.unitFile), false)
  } finally {
    s.cleanup()
  }
})

test('uninstall.sh leaves a unit with no readable WorkingDirectory instead of guessing', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3325']).code, 0)
    const bare = fs.readFileSync(s.unitFile, 'utf8').replace(/^WorkingDirectory=.*\n/m, '')
    fs.writeFileSync(s.unitFile, bare)
    const r = s.run('uninstall.sh', ['--yes'])
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.readFileSync(s.unitFile, 'utf8'), bare)
    assert.ok(/WorkingDirectory/.test(r.out), r.out)
  } finally {
    s.cleanup()
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// The rename from Watchpost: old env keys and the old service of THIS folder.

/** A watchpost.service as the pre-rename installer wrote it, for the folder `app`. */
const legacyUnit = (app) =>
  [
    '# Written by Watchpost install.sh. Remove it with bash uninstall.sh.',
    '[Unit]',
    'Description=Watchpost monitoring console',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${app}`,
    `EnvironmentFile=${app}/.env`,
    'ExecStart="/usr/bin/node" scripts/start-selfhost.mjs',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')

const legacyUnitFile = (s) => path.join(path.dirname(s.unitFile), 'watchpost.service')

test('a fresh install writes only WATCHBELL_* keys', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--no-service']).code, 0)
    const text = fs.readFileSync(s.envFile, 'utf8')
    assert.ok(text.includes('WATCHBELL_MODE=selfhost') && text.includes('WATCHBELL_DATA_DIR=./data'), text)
    assert.ok(!/WATCHPOST/i.test(text), text)
  } finally {
    s.cleanup()
  }
})

test('an env file with the old WATCHPOST_* keys counts as having them: no duplicates, old lines untouched', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const original = ['# from the first install', 'WATCHPOST_MODE=selfhost', 'DATABASE_URL=pglite:', 'WATCHPOST_DATA_DIR=./mydata', 'PORT=3340', ''].join('\n')
    fs.writeFileSync(s.envFile, original)
    const r = s.run('install.sh', ['--yes', '--no-service'])
    assert.equal(r.code, 0, r.out)
    const text = fs.readFileSync(s.envFile, 'utf8')
    assert.ok(text.startsWith(original), text)
    assert.ok(!text.includes('WATCHBELL_MODE') && !text.includes('WATCHBELL_DATA_DIR'), text)
    assert.equal(keyLines(s.envFile, 'WATCHPOST_MODE').length, 1)
    assert.equal(Buffer.from(readEnv(s.envFile).OPS_ENCRYPTION_KEY, 'base64').length, 32)
    // The build still gets the new name in its environment.
    assert.equal(npmSteps(s).find((x) => x.cmd === 'run build').mode, 'selfhost')
  } finally {
    s.cleanup()
  }
})

test('an old watchpost.service of this folder is replaced by watchbell.service with consent (--yes)', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const r = s.run('install.sh', ['--yes', '--port', '3341'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3341' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.existsSync(oldFile), false, 'the old unit is deleted')
    const unit = fs.readFileSync(s.unitFile, 'utf8')
    assert.ok(unit.includes(`WorkingDirectory=${toBash(s.app)}\n`) && unit.includes('Description=Watchbell'), unit)
    const log = s.log().map((l) => l.join(' '))
    const at = (prefix) => log.findIndex((l) => l.startsWith(prefix))
    const stopOld = at('systemctl --user stop watchpost')
    assert.ok(stopOld >= 0 && stopOld < at('npm ci'), log.join('\n'))
    assert.ok(at('systemctl --user disable --now watchpost') > at('npm ci'), log.join('\n'))
    assert.ok(at('systemctl --user restart watchbell') > at('systemctl --user disable --now watchpost'), log.join('\n'))
    assert.ok(r.out.includes('Replace it with watchbell.service?'), r.out)
  } finally {
    s.cleanup()
  }
})

test('declining the replacement keeps the old watchpost.service in use and creates no second service', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const r = s.run('install.sh', ['--port', '3342'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3342' }, input: 'n\n' })
    assert.equal(r.code, 0, r.out)
    assert.ok(fs.existsSync(oldFile), 'the old unit stays')
    assert.equal(fs.existsSync(s.unitFile), false, 'no watchbell.service')
    const sc = calls(s, 'systemctl').map((l) => l.slice(1).join(' '))
    assert.ok(sc.includes('--user stop watchpost') && sc.includes('--user restart watchpost'), sc.join('\n'))
    assert.ok(!sc.some((c) => c.includes('watchbell')), sc.join('\n'))
    assert.ok(r.out.includes('systemctl --user status watchpost'), r.out)
  } finally {
    s.cleanup()
  }
})

test('--no-service leaves an old watchpost.service of this folder alone and asks nothing', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const r = s.run('install.sh', ['--yes', '--no-service'])
    assert.equal(r.code, 0, r.out)
    assert.ok(fs.existsSync(oldFile) && !fs.existsSync(s.unitFile))
    assert.ok(!r.out.includes('Replace it with'), r.out)
  } finally {
    s.cleanup()
  }
})

test('a watchpost.service that runs another folder is never touched or asked about', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    const body = legacyUnit('/srv/elsewhere/app')
    fs.writeFileSync(oldFile, body)
    const r = s.run('install.sh', ['--yes', '--port', '3343'])
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.readFileSync(oldFile, 'utf8'), body)
    assert.ok(!r.out.includes('Replace it with'), r.out)
    assert.ok(fs.existsSync(s.unitFile), 'the new service is created as usual')
    const u = s.run('uninstall.sh', ['--yes'])
    assert.equal(u.code, 0, u.out)
    assert.equal(fs.readFileSync(oldFile, 'utf8'), body, 'uninstall leaves the other folder service alone')
  } finally {
    s.cleanup()
  }
})

test('uninstall.sh also removes an old watchpost.service of this folder (after asking)', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const no = s.run('uninstall.sh', [], { input: 'n\n' })
    assert.equal(no.code, 0, no.out)
    assert.ok(fs.existsSync(oldFile), 'declined: kept')
    const r = s.run('uninstall.sh', ['--yes'])
    assert.equal(r.code, 0, r.out)
    assert.equal(fs.existsSync(oldFile), false)
    assert.ok(calls(s, 'systemctl').some((l) => l.slice(1).join(' ') === '--user disable --now watchpost'))
  } finally {
    s.cleanup()
  }
})

test('replacing the old watchpost.service never repoints another folder\'s watchbell.service without asking', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.mkdirSync(path.dirname(s.unitFile), { recursive: true })
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const otherUnit = legacyUnit('/srv/other/app').replace('Watchpost', 'Watchbell')
    fs.writeFileSync(s.unitFile, otherUnit)

    // Yes to the replacement, no to repointing the other folder's service: nothing changes, the old service stays in use.
    const no = s.run('install.sh', ['--port', '3351'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3351' }, input: 'y\nn\n' })
    assert.equal(no.code, 0, no.out)
    assert.ok(no.out.includes('The existing watchbell.service runs Watchbell from /srv/other/app. Point it to this folder'), no.out)
    assert.equal(fs.readFileSync(s.unitFile, 'utf8'), otherUnit, 'the other folder service file is untouched')
    assert.ok(fs.existsSync(oldFile), 'the old unit stays')
    const sc = calls(s, 'systemctl').map((l) => l.slice(1).join(' '))
    assert.ok(!sc.some((c) => /^--user (stop|restart|enable|start|disable --now) watchbell$/.test(c)), sc.join('\n'))
    assert.ok(sc.includes('--user restart watchpost'), sc.join('\n'))

    // Declining the replacement itself behaves the same and asks nothing about the other folder.
    const first = s.run('install.sh', ['--port', '3351'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3351' }, input: 'n\n' })
    assert.equal(first.code, 0, first.out)
    assert.ok(!first.out.includes('Point it to this folder'), first.out)
    assert.equal(fs.readFileSync(s.unitFile, 'utf8'), otherUnit)

    // --yes agrees to both: the old unit goes, watchbell.service now runs this folder.
    fs.writeFileSync(path.join(s.base, 'stub.log'), '')
    const yes = s.run('install.sh', ['--yes', '--port', '3351'], { env: { FAKE_SERVICE_ACTIVE: '1', FAKE_SS_LISTEN: '3351' } })
    assert.equal(yes.code, 0, yes.out)
    assert.equal(fs.existsSync(oldFile), false)
    assert.ok(fs.readFileSync(s.unitFile, 'utf8').includes(`WorkingDirectory=${toBash(s.app)}\n`))
  } finally {
    s.cleanup()
  }
})

test('declining the replacement while watchbell.service also runs this folder warns that both may compete for the port', { skip: SKIP }, () => {
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--port', '3352']).code, 0) // creates watchbell.service for this folder
    const oldFile = legacyUnitFile(s)
    fs.writeFileSync(oldFile, legacyUnit(toBash(s.app)))
    const r = s.run('install.sh', ['--port', '3352'], { input: 'n\n' })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.out.includes('watchbell.service already exists for this folder too') && r.out.includes('may compete for it'), r.out)
    assert.ok(fs.existsSync(oldFile))
  } finally {
    s.cleanup()
  }
})

test('a new app/.env gets this computer\'s time zone as WATCHBELL_TIMEZONE; a re-run never changes it', { skip: SKIP }, () => {
  const s = scratch()
  try {
    const r = s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_TZ: 'Europe/Berlin' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(readEnv(s.envFile).WATCHBELL_TIMEZONE, 'Europe/Berlin')
    assert.equal(keyLines(s.envFile, 'WATCHBELL_TIMEZONE').length, 1)
    const before = fs.readFileSync(s.envFile, 'utf8')
    assert.equal(s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_TZ: 'America/New_York' } }).code, 0)
    assert.equal(fs.readFileSync(s.envFile, 'utf8'), before)
  } finally {
    s.cleanup()
  }
})

test('an existing app/.env never gets WATCHBELL_TIMEZONE (it keeps the default, Asia/Jakarta)', { skip: SKIP }, () => {
  const s = scratch()
  try {
    fs.writeFileSync(s.envFile, ['WATCHBELL_MODE=selfhost', 'PORT=3360', ''].join('\n'))
    const r = s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_TZ: 'Europe/Berlin' } })
    assert.equal(r.code, 0, r.out)
    assert.equal(readEnv(s.envFile).WATCHBELL_TIMEZONE, undefined)
    assert.ok(!r.out.includes('WATCHBELL_TIMEZONE'), r.out)
  } finally {
    s.cleanup()
  }
})

test('UTC, GMT and full Area/Location names are written as they are (the same rule as the app)', { skip: SKIP }, () => {
  for (const zone of ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT-7', 'Etc/GMT+5', 'US/Pacific', 'America/Argentina/Buenos_Aires']) {
    const s = scratch()
    try {
      assert.equal(s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_TZ: zone } }).code, 0)
      assert.equal(readEnv(s.envFile).WATCHBELL_TIMEZONE, zone)
    } finally {
      s.cleanup()
    }
  }
})

test('a time zone Node.js can\'t name is left out; without the stub it is Node\'s own zone', { skip: SKIP }, () => {
  for (const zone of ['', 'Europe/Berlin; rm -rf ~', 'CET', 'IST', 'BST', 'AET', 'ECT', 'EST', 'EST5EDT', 'GB']) {
    const s = scratch()
    try {
      assert.equal(s.run('install.sh', ['--yes', '--no-service'], { env: { FAKE_TZ: zone } }).code, 0)
      assert.ok(!fs.readFileSync(s.envFile, 'utf8').includes('WATCHBELL_TIMEZONE'), zone)
    } finally {
      s.cleanup()
    }
  }
  const s = scratch()
  try {
    assert.equal(s.run('install.sh', ['--yes', '--no-service']).code, 0)
    assert.equal(readEnv(s.envFile).WATCHBELL_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone)
  } finally {
    s.cleanup()
  }
})
