// Tests for the Windows installer (install.ps1 / uninstall.ps1 / the .bat launchers). Windows only: each test copies the
// scripts into a scratch folder whose path has spaces, puts stub node/npm/git .cmd shims first on PATH (they log
// their arguments) and runs Windows PowerShell 5.1. WATCHBELL_INSTALL_TEST=1 makes the Scheduled Task functions record
// instead of registering, so no task is ever created.
// Scratch space: WATCHBELL_TEST_TMP, or <repo>/.cache/tmp (never the system temp folder).
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.resolve(HERE, '..', '..')
const TMP_ROOT = process.env.WATCHBELL_TEST_TMP || process.env.WATCHPOST_TEST_TMP || path.join(SCRIPTS, '.cache', 'tmp')
const IS_WINDOWS = process.platform === 'win32'
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const CMD = path.join(SYSTEM_ROOT, 'System32', 'cmd.exe')
const NODE_MESSAGE =
  'Watchbell needs Node.js 24. Download the Windows installer (.msi) from https://nodejs.org/dist/latest-v24.x/, install it, then run install.bat again.'
const ENV_KEYS = ['WATCHBELL_MODE', 'DATABASE_URL', 'WATCHBELL_DATA_DIR', 'HOST', 'PORT', 'SITE_URL', 'OPS_ENCRYPTION_KEY', 'COLLECTOR_SECRET', 'CRON_SECRET']

const crlf = (lines) => lines.join('\r\n') + '\r\n'
const SHIMS = {
  'node.cmd': crlf([
    '@echo off',
    'if /i "%~1"=="-v" goto version',
    'if /i "%~1"=="--version" goto version',
    'if /i "%~1"=="-e" goto zone',
    '>>"%WATCHBELL_STUB_LOG%" echo node %* ^| cwd=%CD%',
    'echo stub node started: %* ^| cwd=%CD%',
    'exit /b 0',
    ':version',
    'echo %WATCHBELL_STUB_NODE_VERSION%',
    'exit /b 0',
    ':zone',
    'if not defined WATCHBELL_STUB_TZ exit /b 1',
    'echo %WATCHBELL_STUB_TZ%',
    'exit /b 0',
  ]),
  'npm.cmd': crlf([
    '@echo off',
    '>>"%WATCHBELL_STUB_LOG%" echo npm %* ^| cwd=%CD% ^| mode=%WATCHBELL_MODE%',
    'if /i "%~1"=="%WATCHBELL_STUB_NPM_FAIL%" exit /b 3',
    'if defined WATCHBELL_STUB_NPM_FAIL_ARGS if /i "%*"=="%WATCHBELL_STUB_NPM_FAIL_ARGS%" exit /b 1',
    'exit /b 0',
  ]),
  'icacls.cmd': crlf([
    '@echo off',
    '>>"%WATCHBELL_STUB_LOG%" echo icacls %*',
    'if defined WATCHBELL_STUB_ICACLS_FAIL exit /b 5',
    'exit /b 0',
  ]),
  'git.cmd': crlf([
    '@echo off',
    '>>"%WATCHBELL_STUB_LOG%" echo git %*',
    'if "%~3"=="rev-parse" goto revparse',
    'if "%~3"=="status" goto status',
    'exit /b 0',
    ':revparse',
    'if defined WATCHBELL_STUB_GIT_NOREPO exit /b 128',
    'if defined WATCHBELL_STUB_GIT_TOPLEVEL goto toplevel',
    'echo %~2',
    'exit /b 0',
    ':toplevel',
    'echo %WATCHBELL_STUB_GIT_TOPLEVEL%',
    'exit /b 0',
    ':status',
    'if defined WATCHBELL_STUB_GIT_STATUS echo %WATCHBELL_STUB_GIT_STATUS%',
    'exit /b 0',
  ]),
}

const boxes = []

/** A scratch install: <tmp>/ps1 <id>/my repo (the scripts + a fake app/), stub bin/, calls.log. */
function makeBox({ without = [] } = {}) {
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  const base = fs.mkdtempSync(path.join(TMP_ROOT, 'ps1 '))
  boxes.push(base)
  const repo = path.join(base, 'my repo')
  const app = path.join(repo, 'app')
  const stubs = path.join(base, 'stub bin')
  for (const d of [path.join(app, 'scripts'), stubs]) fs.mkdirSync(d, { recursive: true })
  for (const f of ['install.ps1', 'uninstall.ps1', 'install.bat', 'uninstall.bat']) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, f))
  }
  fs.writeFileSync(path.join(app, 'package.json'), '{ "name": "watchbell-test" }\n')
  fs.writeFileSync(path.join(app, 'scripts', 'start-selfhost.mjs'), '// placeholder\n')
  for (const [name, body] of Object.entries(SHIMS)) {
    if (!without.includes(name)) fs.writeFileSync(path.join(stubs, name), body)
  }
  const log = path.join(base, 'calls.log')
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase()
    if (K === 'PATH' || K === 'NODE_OPTIONS' || K.startsWith('NPM_') || K.startsWith('WATCHBELL_') || K.startsWith('WATCHPOST_')) continue
    env[k] = v
  }
  Object.assign(env, {
    Path: [stubs, path.join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT, path.dirname(POWERSHELL)].join(';'),
    TMP: TMP_ROOT,
    TEMP: TMP_ROOT,
    PSModuleAnalysisCachePath: path.join(TMP_ROOT, 'ps-module-cache', 'ModuleAnalysisCache'),
    WATCHBELL_INSTALL_TEST: '1',
    WATCHBELL_INSTALL_TEST_LOG: log,
    WATCHBELL_STUB_LOG: log,
    WATCHBELL_STUB_NODE_VERSION: 'v24.10.0',
  })
  return {
    base, repo, app, stubs, log, env,
    envFile: path.join(app, '.env'),
    dataDir: path.join(app, 'data'),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []),
  }
}

function run(file, args, { env, input = '', cwd, verbatim = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, windowsHide: true, windowsVerbatimArguments: verbatim })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, out: stdout + stderr })
    })
    child.stdin.end(input)
  })
}

const ps = (box, script, args = [], opts = {}) =>
  run(POWERSHELL, [...(opts.psFlags || []), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(box.repo, script), ...args], {
    env: { ...box.env, ...(opts.env || {}) },
    input: opts.input ?? '',
    cwd: box.repo,
  })

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

function parseEnv(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const taskRecord = (box) => {
  const line = box.calls().find((l) => l.startsWith('task register '))
  return line ? JSON.parse(line.slice('task register '.length)) : null
}

describe('install.ps1 (Windows)', { skip: !IS_WINDOWS && 'Windows only', concurrency: 4 }, () => {
  before(() => fs.mkdirSync(TMP_ROOT, { recursive: true }))
  after(() => {
    for (const b of boxes) fs.rmSync(b, { recursive: true, force: true })
  })

  test('-Help and --help list every option in both spellings and touch nothing', async () => {
    const box = makeBox()
    for (const flag of ['-Help', '--help', '/?']) {
      const r = await ps(box, 'install.ps1', [flag])
      assert.equal(r.code, 0, r.out)
      for (const opt of ['-Yes', '--yes', '-NoService', '--no-service', '-Port <n>', '--port <n>', '-Upgrade', '--upgrade', '-Help', '--help']) {
        assert.ok(r.stdout.includes(opt), `${flag}: missing ${opt}`)
      }
    }
    const u = await ps(box, 'uninstall.ps1', ['--help'])
    assert.equal(u.code, 0, u.out)
    for (const opt of ['-Yes', '--yes', '-Help', '--help']) assert.ok(u.stdout.includes(opt), opt)
    assert.deepEqual(box.calls(), [])
    assert.ok(!fs.existsSync(box.envFile))
  })

  test('bad arguments exit 2 before any step', async () => {
    const box = makeBox()
    for (const args of [['--bogus'], ['--port'], ['--port', '70000'], ['-Port', 'abc'], ['stray']]) {
      const r = await ps(box, 'install.ps1', args)
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.out}`)
    }
    assert.equal((await ps(box, 'uninstall.ps1', ['--no-such'])).code, 2)
    assert.deepEqual(box.calls(), [])
    assert.ok(!fs.existsSync(box.envFile))
  })

  test('fresh install --yes in a path with spaces: .env, npm ci then build, Scheduled Task with consent', async () => {
    const box = makeBox()
    const port = await freePort()
    const r = await ps(box, 'install.ps1', ['--yes', '--port', String(port)])
    assert.equal(r.code, 0, r.out)

    const raw = fs.readFileSync(box.envFile)
    assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], '.env must not start with a BOM')
    const env = parseEnv(raw.toString('utf8'))
    for (const k of ENV_KEYS) assert.ok(env[k], `missing ${k}`)
    assert.equal(env.WATCHBELL_MODE, 'selfhost')
    assert.equal(env.DATABASE_URL, 'pglite:')
    assert.equal(env.WATCHBELL_DATA_DIR, './data')
    assert.equal(env.HOST, '127.0.0.1')
    assert.equal(env.PORT, String(port))
    assert.equal(env.SITE_URL, `http://localhost:${port}`)
    assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, 'base64').length, 32)
    assert.match(env.OPS_ENCRYPTION_KEY, /^[A-Za-z0-9+/]{43}=$/)
    assert.match(env.COLLECTOR_SECRET, /^[A-Za-z0-9_-]{43}$/)
    assert.match(env.CRON_SECRET, /^[A-Za-z0-9_-]{32}$/)
    for (const k of ['OPS_ENCRYPTION_KEY', 'COLLECTOR_SECRET', 'CRON_SECRET']) {
      assert.ok(!r.out.includes(env[k]), `${k} must never be printed`)
    }
    assert.ok(fs.existsSync(box.dataDir))

    const npm = box.calls().filter((l) => l.startsWith('npm '))
    assert.equal(npm.length, 2, npm.join('\n'))
    assert.match(npm[0], /^npm ci \| cwd=(.*) \| mode=/)
    assert.equal(npm[0].split(' | ')[1], `cwd=${box.app}`)
    assert.match(npm[1], /^npm run build \| cwd=.* \| mode=selfhost$/)
    assert.equal(npm[1].split(' | ')[1], `cwd=${box.app}`)

    const calls = box.calls()
    assert.ok(calls.indexOf('task start') > calls.findIndex((l) => l.startsWith('npm run build')), 'task starts after the build')
    const task = taskRecord(box)
    assert.ok(task, 'task registered')
    assert.equal(task.Execute, path.join(SYSTEM_ROOT, 'System32', 'conhost.exe'))
    assert.equal(task.WorkingDirectory, box.app)
    assert.ok(task.Argument.includes(`"${path.join(box.stubs, 'node.cmd')}" scripts\\start-selfhost.mjs >> data\\watchbell.log 2>&1`), task.Argument)
    assert.equal(task.Trigger, 'MSFT_TaskLogonTrigger')
    assert.equal(task.LogonType, 'Interactive')
    assert.equal(task.RunLevel, 'Limited')
    assert.equal(task.RestartCount, 3)
    assert.equal(task.RestartInterval, 'PT1M')
    assert.equal(task.ExecutionTimeLimit, 'PT0S')
    assert.equal(task.DisallowStartIfOnBatteries, false)
    assert.ok(task.TriggerUser, 'trigger limited to the current user')

    for (const s of ['npm run stop:selfhost', 'Start-ScheduledTask Watchbell', 'Stop-ScheduledTask Watchbell', 'app\\data\\watchbell.log', `http://localhost:${port}/setup`, 'app\\data\\setup-code']) {
      assert.ok(r.stdout.includes(s), `output lacks ${s}`)
    }
    assert.ok(!calls.some((l) => l.startsWith('git ')), 'no git without --upgrade')
  })

  test('the Scheduled Task action really starts node in app\\ and appends to app\\data\\watchbell.log', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['-Yes', '-Port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    const task = taskRecord(box)
    fs.rmSync(box.dataDir, { recursive: true, force: true }) // the action creates data\ itself
    const launch = await run(POWERSHELL, ['-NoProfile', '-Command',
      'Start-Process -FilePath $env:T_EXE -ArgumentList $env:T_ARG -WorkingDirectory $env:T_WD -Wait'], {
      env: { ...box.env, T_EXE: task.Execute, T_ARG: task.Argument, T_WD: task.WorkingDirectory },
    })
    assert.equal(launch.code, 0, launch.out)
    const logFile = path.join(box.dataDir, 'watchbell.log')
    for (let i = 0; i < 50 && !(fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('stub node')); i++) {
      await new Promise((res) => setTimeout(res, 200))
    }
    const log = fs.readFileSync(logFile, 'utf8')
    assert.ok(log.includes(`stub node started: scripts\\start-selfhost.mjs | cwd=${box.app}`), log)
  })

  test('-NoService (PowerShell spelling): no task, prints the manual start command', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['-Yes', '-NoService', '-Port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    assert.equal(taskRecord(box), null)
    assert.ok(!box.calls().includes('task start'))
    assert.ok(r.stdout.includes('cd app && npm run start:selfhost'), r.stdout)
    assert.ok(r.stdout.includes('/setup'))
  })

  test('auto-start is only created after a yes', async () => {
    const no = makeBox()
    const r1 = await ps(no, 'install.ps1', ['--port', String(await freePort())], { input: 'n\r\n' })
    assert.equal(r1.code, 0, r1.out)
    assert.equal(taskRecord(no), null)
    assert.ok(r1.stdout.includes('cd app && npm run start:selfhost'))

    const silent = makeBox() // no answer at all (stdin closed) counts as no
    const r2 = await ps(silent, 'install.ps1', ['--port', String(await freePort())])
    assert.equal(r2.code, 0, r2.out)
    assert.equal(taskRecord(silent), null)

    const yes = makeBox()
    const r3 = await ps(yes, 'install.ps1', ['--port', String(await freePort())], { input: 'y\r\n' })
    assert.equal(r3.code, 0, r3.out)
    assert.ok(taskRecord(yes))
  })

  test('re-run keeps every existing value (above all OPS_ENCRYPTION_KEY) and appends only missing keys', async () => {
    const box = makeBox()
    const port = await freePort()
    const key = Buffer.alloc(32, 7).toString('base64')
    const original = `# mine\r\nOPS_ENCRYPTION_KEY=${key}\r\nPORT=${port}\r\nTELEGRAM_BOT_TOKEN=keep-me\r\nSITE_URL=https://watch.example.test`
    fs.writeFileSync(box.envFile, original) // no trailing newline on purpose
    const other = await freePort()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(other)])
    assert.equal(r.code, 0, r.out)
    const after1 = fs.readFileSync(box.envFile, 'utf8')
    assert.ok(after1.startsWith(original + '\r\n'), 'existing lines are untouched')
    const env = parseEnv(after1)
    assert.equal(env.OPS_ENCRYPTION_KEY, key)
    assert.equal(env.PORT, String(port), 'existing PORT wins over --port')
    assert.equal(env.SITE_URL, 'https://watch.example.test')
    assert.equal(env.TELEGRAM_BOT_TOKEN, 'keep-me')
    for (const k of ENV_KEYS) assert.equal(after1.split(/\r?\n/).filter((l) => l.startsWith(`${k}=`)).length, 1, `${k} once`)
    assert.ok(!r.out.includes(key), 'the existing key is never printed')
    assert.ok(r.stdout.includes(`PORT=${port}`), 'warns that the existing PORT is kept')
    assert.ok(r.stdout.includes(`http://localhost:${port}/setup`))
    assert.ok(box.calls().some((l) => l.startsWith('npm run build')), 'rebuilds')

    const r2 = await ps(box, 'install.ps1', ['--yes', '--no-service'])
    assert.equal(r2.code, 0, r2.out)
    assert.equal(fs.readFileSync(box.envFile, 'utf8'), after1, 'a third run changes nothing')
  })

  test('Node 22: points to the Node.js 24 installer, exit 1, nothing written, nothing installed (even with --yes)', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--port', String(await freePort())], {
      env: { WATCHBELL_STUB_NODE_VERSION: 'v22.11.0' },
    })
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('Node.js v22.11.0 is installed.'))
    assert.ok(r.stdout.includes(NODE_MESSAGE), r.stdout)
    assert.ok(!r.out.includes('[y/N]'), 'no question about Node')
    assert.match(r.stderr, /Failed at step 'prerequisites': Node\.js 24 is required\./)
    assert.deepEqual(box.calls(), [], 'npm never ran')
    assert.ok(!fs.existsSync(box.envFile))
    assert.ok(!fs.existsSync(box.dataDir))
  })

  test('Node missing: the same message, exit 1, nothing written', async () => {
    const box = makeBox({ without: ['node.cmd'] })
    const r = await ps(box, 'install.ps1', [])
    assert.equal(r.code, 1, r.out)
    assert.ok(r.out.includes('Node.js was not found'))
    assert.ok(r.stdout.includes(NODE_MESSAGE), r.stdout)
    assert.deepEqual(box.calls(), [])
    assert.ok(!fs.existsSync(box.envFile))
    assert.ok(!fs.existsSync(box.dataDir))
  })

  test('busy port: says so before building and suggests --port', async () => {
    const box = makeBox()
    const server = net.createServer()
    await new Promise((res) => server.listen(0, '127.0.0.1', res))
    const { port } = server.address()
    try {
      const r = await ps(box, 'install.ps1', ['--yes', '--port', String(port)])
      assert.equal(r.code, 1, r.out)
      assert.match(r.stderr, new RegExp(`Failed at step 'port': port ${port} is already in use`))
      assert.ok(r.stderr.includes('--port'))
      assert.deepEqual(box.calls(), [], 'no npm before the port is free')
      assert.ok(!fs.existsSync(box.envFile))
    } finally {
      await new Promise((res) => server.close(res))
    }
  })

  test('a failing npm ci stops with the step name and never builds', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--port', String(await freePort())], { env: { WATCHBELL_STUB_NPM_FAIL: 'ci' } })
    assert.equal(r.code, 1, r.out)
    assert.match(r.stderr, /Failed at step 'npm ci': npm ci failed \(exit 3\)/)
    assert.ok(!box.calls().some((l) => l.startsWith('npm run build')))
    assert.equal(taskRecord(box), null)
  })

  test('a running task is stopped cleanly (npm run stop:selfhost) before the port check and started again at the end', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_TASK_STATE: 'Running' },
    })
    assert.equal(r.code, 0, r.out)
    const calls = box.calls()
    const stop = calls.findIndex((l) => l.startsWith('npm run stop:selfhost'))
    const ci = calls.findIndex((l) => l.startsWith('npm ci'))
    const start = calls.indexOf('task start')
    assert.ok(stop >= 0 && stop < ci && ci < start, calls.join('\n'))
    assert.equal(calls[stop].split(' | ')[1], `cwd=${box.app}`)
    assert.ok(!calls.includes('task stop'), 'no hard stop after a clean one')
    assert.equal(taskRecord(box), null, '--no-service does not re-register')
  })

  test('Stop-ScheduledTask is only the fallback when the clean stop times out', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_TASK_STATE: 'Running', WATCHBELL_STUB_NPM_FAIL_ARGS: 'run stop:selfhost' },
    })
    assert.equal(r.code, 0, r.out)
    const calls = box.calls()
    const clean = calls.findIndex((l) => l.startsWith('npm run stop:selfhost'))
    const hard = calls.indexOf('task stop')
    assert.ok(clean >= 0 && hard === clean + 1 && hard < calls.findIndex((l) => l.startsWith('npm ci')), calls.join('\n'))
  })

  test('--upgrade pulls only in a clean checkout, before npm ci', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--upgrade', '--yes', '--no-service', '--port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    const calls = box.calls()
    assert.deepEqual(calls.filter((l) => l.startsWith('git ')), [
      `git -C "${box.repo}" rev-parse --show-toplevel`,
      `git -C "${box.repo}" status --porcelain --untracked-files=no`,
      `git -C "${box.repo}" pull --ff-only`,
    ])
    assert.ok(calls.findIndex((l) => l.includes('pull --ff-only')) < calls.findIndex((l) => l.startsWith('npm ci')))

    const dirty = makeBox()
    const d = await ps(dirty, 'install.ps1', ['-Upgrade', '-Yes'], { env: { WATCHBELL_STUB_GIT_STATUS: ' M app/package.json' } })
    assert.equal(d.code, 1, d.out)
    assert.match(d.stderr, /Failed at step 'upgrade'/)
    assert.ok(!dirty.calls().some((l) => l.includes('pull') || l.startsWith('npm ')))

    const notRepo = makeBox()
    const n = await ps(notRepo, 'install.ps1', ['--upgrade', '--yes'], { env: { WATCHBELL_STUB_GIT_NOREPO: '1' } })
    assert.equal(n.code, 1, n.out)
    assert.match(n.stderr, /not a git checkout/)
  })

  test('uninstall stops and removes the task, keeps app\\data and app\\.env and says how to delete them', async () => {
    const box = makeBox()
    fs.mkdirSync(box.dataDir, { recursive: true })
    fs.writeFileSync(path.join(box.dataDir, 'setup-code'), 'x')
    fs.writeFileSync(box.envFile, 'OPS_ENCRYPTION_KEY=keep\r\n')
    const r = await ps(box, 'uninstall.ps1', ['--yes'], { env: { WATCHBELL_TEST_TASK_STATE: 'Running' } })
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(box.calls(), [`npm run stop:selfhost | cwd=${box.app} | mode=`, 'task unregister'], 'clean stop, no hard stop')
    assert.ok(fs.existsSync(path.join(box.dataDir, 'setup-code')))
    assert.equal(fs.readFileSync(box.envFile, 'utf8'), 'OPS_ENCRYPTION_KEY=keep\r\n')
    for (const s of [box.dataDir, box.envFile, 'Remove-Item']) assert.ok(r.stdout.includes(s), `output lacks ${s}`)

    const declined = makeBox()
    const d = await ps(declined, 'uninstall.ps1', [], { input: 'n\r\n', env: { WATCHBELL_TEST_TASK_STATE: 'Ready' } })
    assert.equal(d.code, 0, d.out)
    assert.deepEqual(declined.calls(), [])

    const none = makeBox()
    const n = await ps(none, 'uninstall.ps1', ['-Yes'])
    assert.equal(n.code, 0, n.out)
    assert.deepEqual(none.calls(), [])
    assert.ok(n.stdout.includes('No Scheduled Task "Watchbell" was found'))
  })

  test('uninstall falls back to Stop-ScheduledTask only when the clean stop times out', async () => {
    const box = makeBox()
    const r = await ps(box, 'uninstall.ps1', ['--yes'], {
      env: { WATCHBELL_TEST_TASK_STATE: 'Running', WATCHBELL_STUB_NPM_FAIL_ARGS: 'run stop:selfhost' },
    })
    assert.equal(r.code, 0, r.out)
    assert.deepEqual(box.calls(), [`npm run stop:selfhost | cwd=${box.app} | mode=`, 'task stop', 'task unregister'])
  })

  test('powershell -NonInteractive without --yes: every question is a no, never a crash', async () => {
    const box = makeBox()
    const port = await freePort()
    const r = await ps(box, 'install.ps1', ['--port', String(port)], { psFlags: ['-NonInteractive'] })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.stdout.includes('(no answer: no)'))
    assert.equal(taskRecord(box), null)
    assert.ok(r.stdout.includes('cd app && npm run start:selfhost'))
    assert.ok(r.stdout.includes(`http://localhost:${port}/setup`))

    const node22 = makeBox()
    const n = await ps(node22, 'install.ps1', ['--port', String(await freePort())], {
      psFlags: ['-NonInteractive'],
      env: { WATCHBELL_STUB_NODE_VERSION: 'v22.11.0' },
    })
    assert.equal(n.code, 1, n.out)
    assert.ok(n.stdout.includes(NODE_MESSAGE), 'the Node.js 24 download message')
    assert.match(n.stderr, /Failed at step 'prerequisites': Node\.js 24 is required\./)
    assert.deepEqual(node22.calls(), [])
    assert.ok(!fs.existsSync(node22.envFile))

    const un = makeBox()
    const u = await ps(un, 'uninstall.ps1', [], { psFlags: ['-NonInteractive'], env: { WATCHBELL_TEST_TASK_STATE: 'Ready' } })
    assert.equal(u.code, 0, u.out)
    assert.deepEqual(un.calls(), [])
  })

  test('--upgrade re-runs the pulled installer with the same options minus --upgrade, and returns its exit code', async () => {
    const box = makeBox()
    const port = await freePort()
    const r = await ps(box, 'install.ps1', ['--upgrade', '--yes', '--no-service', '--port', String(port)])
    assert.equal(r.code, 0, r.out)
    assert.equal(r.stdout.split('Watchbell installer - ').length - 1, 2, 'the installer ran twice')
    assert.ok(r.stdout.includes('Running the updated installer'))
    const calls = box.calls()
    assert.equal(calls.filter((l) => l.includes('pull --ff-only')).length, 1, 'the second run does not pull again')
    assert.equal(calls.filter((l) => l.startsWith('npm ci')).length, 1)
    assert.equal(parseEnv(fs.readFileSync(box.envFile, 'utf8')).PORT, String(port), 'options passed on')

    const failing = makeBox()
    const f2 = await ps(failing, 'install.ps1', ['-Upgrade', '-Yes', '-Port', String(await freePort())], { env: { WATCHBELL_STUB_NPM_FAIL: 'ci' } })
    assert.equal(f2.code, 1, f2.out)
    assert.match(f2.stderr, /Failed at step 'npm ci'/)
  })

  test('--upgrade never pulls a parent repository that only contains the install', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--upgrade', '--yes'], { env: { WATCHBELL_STUB_GIT_TOPLEVEL: box.base.replaceAll('\\', '/') } })
    assert.equal(r.code, 1, r.out)
    assert.match(r.stderr, /Failed at step 'upgrade': .* is not a git checkout of its own/)
    assert.ok(!box.calls().some((l) => l.includes('status') || l.includes('pull') || l.startsWith('npm ')), box.calls().join('\n'))

    const same = makeBox() // git prints forward slashes: still the same folder
    const ok = await ps(same, 'install.ps1', ['--upgrade', '--yes', '--no-service', '--port', String(await freePort())], {
      env: { WATCHBELL_STUB_GIT_TOPLEVEL: same.repo.replaceAll('\\', '/') },
    })
    assert.equal(ok.code, 0, ok.out)
    assert.ok(same.calls().some((l) => l.includes('pull --ff-only')))
  })

  test('an .env copied from .env.example gets its empty keys filled in place, set values kept', async () => {
    const box = makeBox()
    const port = await freePort()
    const original = ['# my notes', 'WATCHBELL_MODE=selfhost', 'OPS_ENCRYPTION_KEY=', 'SITE_URL=https://watch.example.com', 'COLLECTOR_SECRET=""', 'HOST=0.0.0.0', 'PORT=', 'TELEGRAM_BOT_TOKEN=', '']
    fs.writeFileSync(box.envFile, original.join('\n'))
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(port)])
    assert.equal(r.code, 0, r.out)
    const text = fs.readFileSync(box.envFile, 'utf8')
    const env = parseEnv(text)
    assert.equal(Buffer.from(env.OPS_ENCRYPTION_KEY, 'base64').length, 32)
    assert.match(env.COLLECTOR_SECRET, /^[A-Za-z0-9_-]{43}$/)
    assert.match(env.CRON_SECRET, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(env.SITE_URL, 'https://watch.example.com')
    assert.equal(env.HOST, '0.0.0.0')
    assert.equal(env.PORT, String(port), 'an empty PORT gets the chosen port')
    assert.equal(env.TELEGRAM_BOT_TOKEN, '', 'keys the installer does not own stay empty')
    for (const k of ENV_KEYS) assert.equal(text.split(/\r?\n/).filter((l) => l.startsWith(`${k}=`)).length, 1, `${k} once`)
    assert.ok(text.startsWith('# my notes\nWATCHBELL_MODE=selfhost\nOPS_ENCRYPTION_KEY='), text.slice(0, 80))
    assert.ok(text.includes('\nSITE_URL=https://watch.example.com\nCOLLECTOR_SECRET='), 'filled in place, order kept')
    for (const k of ['OPS_ENCRYPTION_KEY', 'COLLECTOR_SECRET', 'CRON_SECRET']) assert.ok(!r.out.includes(env[k]), `${k} printed`)
    assert.ok(r.stdout.includes('Filled in the empty keys in app\\.env: PORT, OPS_ENCRYPTION_KEY, COLLECTOR_SECRET'), r.stdout)

    const bad = makeBox()
    fs.writeFileSync(bad.envFile, 'PORT=abc\n')
    const b = await ps(bad, 'install.ps1', ['--yes', '--no-service'])
    assert.equal(b.code, 1, b.out)
    assert.match(b.stderr, /Failed at step 'env file': app\\.env sets PORT=abc, which is not a port number/)
    assert.equal(fs.readFileSync(bad.envFile, 'utf8'), 'PORT=abc\n', 'a set value is never changed')
    assert.ok(!bad.calls().some((l) => l.startsWith('npm ')))
  })

  test('app\\.env is limited to the current user with icacls, also on a re-run; a failing icacls only warns', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    const icacls = box.calls().filter((l) => l.startsWith('icacls '))
    assert.equal(icacls.length, 1, box.calls().join('\n'))
    assert.match(icacls[0], /^icacls "(.+)" \/inheritance:r \/grant:r \*S-1-5-[0-9-]+:\(R,W,D\)$/)
    assert.equal(/^icacls "(.+)"/.exec(icacls[0])[1], box.envFile)
    assert.ok(box.calls().indexOf(icacls[0]) < box.calls().findIndex((l) => l.startsWith('npm ci')))
    const again = await ps(box, 'install.ps1', ['--yes', '--no-service'])
    assert.equal(again.code, 0, again.out)
    assert.equal(box.calls().filter((l) => l.startsWith('icacls ')).length, 2, 'a re-run restricts it again')

    const failing = makeBox()
    const f2 = await ps(failing, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], { env: { WATCHBELL_STUB_ICACLS_FAIL: '1' } })
    assert.equal(f2.code, 0, f2.out)
    assert.ok(f2.stdout.includes('Warning: icacls could not limit app\\.env to your user (exit 5)'), f2.stdout)
  })

  test('the real icacls leaves app\\.env with no inherited entries and only the current user', async () => {
    const box = makeBox({ without: ['icacls.cmd'] }) // System32\icacls.exe on a scratch file
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    assert.ok(r.stdout.includes('app\\.env can be read and changed by your user only.'), r.stdout)
    const acl = await run(path.join(SYSTEM_ROOT, 'System32', 'icacls.exe'), [box.envFile], { env: box.env })
    assert.equal(acl.code, 0, acl.out)
    const entries = acl.stdout.split(/\r?\n/).filter((l) => /:\(/.test(l))
    assert.equal(entries.length, 1, acl.stdout)
    assert.ok(!acl.stdout.includes('(I)'), 'no inherited entries')
    assert.ok(entries[0].toLowerCase().includes(String(process.env.USERNAME).toLowerCase()), acl.stdout)
    assert.ok(fs.readFileSync(box.envFile, 'utf8').includes('OPS_ENCRYPTION_KEY='), 'still readable by this user')
    fs.appendFileSync(box.envFile, 'TELEGRAM_BOT_TOKEN=\r\n') // and writable
    fs.rmSync(box.envFile) // and deletable: without D the user could not remove it (or the folder) on a second drive
    assert.ok(!fs.existsSync(box.envFile))
  })

  test("another install's Scheduled Task is never stopped, replaced or removed", async () => {
    const other = 'D:\\elsewhere\\watchbell\\app'
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_TASK_STATE: 'Running', WATCHBELL_TEST_TASK_DIR: other },
    })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.stdout.includes(`belongs to another install (${other})`), r.stdout)
    const calls = box.calls()
    assert.ok(!calls.some((l) => l.startsWith('task ') || l.startsWith('npm run stop:selfhost')), calls.join('\n'))

    const un = makeBox()
    const u = await ps(un, 'uninstall.ps1', ['--yes'], { env: { WATCHBELL_TEST_TASK_STATE: 'Running', WATCHBELL_TEST_TASK_DIR: other } })
    assert.equal(u.code, 0, u.out)
    assert.deepEqual(un.calls(), [])
    assert.ok(u.stdout.includes(`belongs to another install (${other}); it was left as it is.`), u.stdout)

    const mine = makeBox() // same folder spelled differently (case, trailing slash) is still this install
    const m = await ps(mine, 'uninstall.ps1', ['--yes'], {
      env: { WATCHBELL_TEST_TASK_STATE: 'Ready', WATCHBELL_TEST_TASK_DIR: mine.app.toUpperCase() + '\\' },
    })
    assert.equal(m.code, 0, m.out)
    assert.deepEqual(mine.calls(), ['task unregister'])
  })

  test('a fresh install writes only WATCHBELL_* keys; an old WATCHPOST_* env file counts as having them', async () => {
    const fresh = makeBox()
    const r = await ps(fresh, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())])
    assert.equal(r.code, 0, r.out)
    const text = fs.readFileSync(fresh.envFile, 'utf8')
    assert.ok(text.includes('WATCHBELL_MODE=selfhost') && text.includes('WATCHBELL_DATA_DIR=./data'), text)
    assert.ok(!/WATCHPOST/i.test(text), text)

    const old = makeBox()
    const original = ['# from the first install', 'WATCHPOST_MODE=selfhost', 'DATABASE_URL=pglite:', 'WATCHPOST_DATA_DIR=./mydata', 'PORT=3340', ''].join('\r\n')
    fs.writeFileSync(old.envFile, original)
    const o = await ps(old, 'install.ps1', ['--yes', '--no-service'])
    assert.equal(o.code, 0, o.out)
    const kept = fs.readFileSync(old.envFile, 'utf8')
    assert.ok(kept.startsWith(original), kept)
    assert.ok(!kept.includes('WATCHBELL_MODE') && !kept.includes('WATCHBELL_DATA_DIR'), kept)
    assert.equal(kept.split(/\r?\n/).filter((l) => l.startsWith('WATCHPOST_MODE=')).length, 1)
  })

  test('an old "Watchpost" task of this folder is replaced by "Watchbell" with consent (--yes), after a clean stop', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Running' },
    })
    assert.equal(r.code, 0, r.out)
    assert.ok(r.stdout.includes('Replace it with "Watchbell"?'), r.stdout)
    const calls = box.calls()
    const stop = calls.findIndex((l) => l.startsWith('npm run stop:selfhost'))
    const ci = calls.findIndex((l) => l.startsWith('npm ci'))
    const register = calls.findIndex((l) => l.startsWith('task register '))
    const unregister = calls.indexOf('legacy task unregister')
    const start = calls.indexOf('task start')
    assert.ok(stop >= 0 && stop < ci && ci < register && register < unregister && unregister < start, calls.join('\n'))
    assert.ok(!calls.includes('legacy task start'), 'the old task is not started again')
  })

  test('declining the replacement keeps the old "Watchpost" task in use, starts it again and creates no second task', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--port', String(await freePort())], {
      input: 'n\r\nn\r\n',
      env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Running' },
    })
    assert.equal(r.code, 0, r.out)
    const calls = box.calls()
    assert.ok(calls.some((l) => l.startsWith('npm run stop:selfhost')), calls.join('\n'))
    assert.ok(calls.includes('legacy task start'), calls.join('\n'))
    assert.equal(taskRecord(box), null, 'no Watchbell task registered')
    assert.ok(!calls.includes('legacy task unregister') && !calls.includes('task start'), calls.join('\n'))
  })

  test('--no-service leaves an old "Watchpost" task alone; one of another folder is never touched or asked about', async () => {
    const box = makeBox()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Ready' },
    })
    assert.equal(r.code, 0, r.out)
    assert.ok(!r.stdout.includes('Replace it with'), r.stdout)
    assert.ok(!box.calls().some((l) => l.includes('unregister') || l.startsWith('task register')), box.calls().join('\n'))

    const other = makeBox()
    const o = await ps(other, 'install.ps1', ['--yes', '--port', String(await freePort())], {
      env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Running', WATCHBELL_TEST_LEGACY_TASK_DIR: 'D:\\elsewhere\\watchpost\\app' },
    })
    assert.equal(o.code, 0, o.out)
    assert.ok(!o.stdout.includes('Replace it with'), o.stdout)
    assert.ok(!other.calls().some((l) => l.startsWith('legacy task') || l.startsWith('npm run stop:selfhost')), other.calls().join('\n'))
    assert.ok(other.calls().some((l) => l.startsWith('task register ')), 'the new task is created as usual')
  })

  test('uninstall also removes an old "Watchpost" task of this folder (after asking), never another folder\'s', async () => {
    const box = makeBox()
    const r = await ps(box, 'uninstall.ps1', ['--yes'], { env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Running' } })
    assert.equal(r.code, 0, r.out)
    const calls = box.calls()
    assert.ok(calls.some((l) => l.startsWith('npm run stop:selfhost')) && calls.includes('legacy task unregister'), calls.join('\n'))
    assert.ok(!calls.includes('task unregister'), 'there was no Watchbell task to remove')

    const declined = makeBox()
    const d = await ps(declined, 'uninstall.ps1', [], { input: 'n\r\n', env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Ready' } })
    assert.equal(d.code, 0, d.out)
    assert.deepEqual(declined.calls(), [])

    const other = makeBox()
    const o = await ps(other, 'uninstall.ps1', ['--yes'], {
      env: { WATCHBELL_TEST_LEGACY_TASK_STATE: 'Running', WATCHBELL_TEST_LEGACY_TASK_DIR: 'D:\\elsewhere\\watchpost\\app' },
    })
    assert.equal(o.code, 0, o.out)
    assert.deepEqual(other.calls(), [])
  })

  test('install.bat and uninstall.bat forward the arguments and the exit code', async () => {
    const box = makeBox()
    const bat = (name, args) =>
      run(CMD, ['/d', '/s', '/c', `""${path.join(box.repo, name)}" ${args}"`], { env: box.env, cwd: box.base, verbatim: true })
    const help = await bat('install.bat', '--help --yes')
    assert.equal(help.code, 0, help.out)
    assert.ok(help.stdout.includes('--no-service'))
    const bad = await bat('install.bat', '--bogus --yes')
    assert.equal(bad.code, 2, bad.out)
    const u = await bat('uninstall.bat', '--help --yes')
    assert.equal(u.code, 0, u.out)
    assert.ok(u.stdout.includes('uninstall'))
    assert.deepEqual(box.calls(), [])
  })
  test('a new app\.env gets this computer\'s time zone as WATCHBELL_TIMEZONE; an existing one never does', async () => {
    const box = makeBox()
    const port = await freePort()
    const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(port)], { env: { WATCHBELL_STUB_TZ: 'Europe/Berlin' } })
    assert.equal(r.code, 0, r.out)
    const text = fs.readFileSync(box.envFile, 'utf8')
    assert.equal(parseEnv(text).WATCHBELL_TIMEZONE, 'Europe/Berlin')
    assert.equal(text.split(/\r?\n/).filter((l) => l.startsWith('WATCHBELL_TIMEZONE=')).length, 1)
    // A re-run changes nothing, even when the computer's zone has changed since.
    const again = await ps(box, 'install.ps1', ['--yes', '--no-service'], { env: { WATCHBELL_STUB_TZ: 'America/New_York' } })
    assert.equal(again.code, 0, again.out)
    assert.equal(fs.readFileSync(box.envFile, 'utf8'), text)

    const old = makeBox()
    fs.writeFileSync(old.envFile, `WATCHBELL_MODE=selfhost\r\nPORT=${await freePort()}\r\n`)
    const kept = await ps(old, 'install.ps1', ['--yes', '--no-service'], { env: { WATCHBELL_STUB_TZ: 'Europe/Berlin' } })
    assert.equal(kept.code, 0, kept.out)
    assert.equal(parseEnv(fs.readFileSync(old.envFile, 'utf8')).WATCHBELL_TIMEZONE, undefined)
  })

  test('a time zone Node.js can\'t name is left out of the new app\.env', async () => {
    for (const env of [{}, ...['not a zone', 'CET', 'IST', 'BST', 'AET', 'ECT', 'EST', 'EST5EDT', 'GB'].map((z) => ({ WATCHBELL_STUB_TZ: z }))]) {
      const box = makeBox()
      const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], { env })
      assert.equal(r.code, 0, r.out)
      assert.ok(!fs.readFileSync(box.envFile, 'utf8').includes('WATCHBELL_TIMEZONE'), JSON.stringify(env))
    }
  })

  test('UTC, GMT and full Area/Location names are written as they are (the same rule as the app)', async () => {
    for (const zone of ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT-7', 'Etc/GMT+5', 'US/Pacific', 'America/Argentina/Buenos_Aires']) {
      const box = makeBox()
      const r = await ps(box, 'install.ps1', ['--yes', '--no-service', '--port', String(await freePort())], { env: { WATCHBELL_STUB_TZ: zone } })
      assert.equal(r.code, 0, r.out)
      assert.equal(parseEnv(fs.readFileSync(box.envFile, 'utf8')).WATCHBELL_TIMEZONE, zone)
    }
  })
})

