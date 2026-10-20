# Watchbell installer for Windows 10/11 (Windows PowerShell 5.1 or later). Run it from the folder it ships in:
# double-click install.bat, or
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [-Yes] [-NoService] [-Port <n>] [-Upgrade] [-Help]
# The bash-style spellings work too (--yes, --no-service, --port <n>, --upgrade, --help).
# It never needs admin rights and never writes outside this folder, except the optional per-user Scheduled Task
# "Watchbell" (and it offers to replace the "Watchpost" task an earlier install of this folder created, from before the
# product was renamed). Keep this file ASCII-only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.

$ErrorActionPreference = 'Stop'

$TaskName = 'Watchbell'
# The name an earlier install of this folder used, when the product was still called Watchpost.
$LegacyTaskName = 'Watchpost'
$NodeMajor = 24
$DefaultPort = 3100

$RepoRoot = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$AppDir = Join-Path $RepoRoot 'app'
$EnvFile = Join-Path $AppDir '.env'
$DataDir = Join-Path $AppDir 'data'
$LogFile = Join-Path $DataDir 'watchbell.log'
# Test hook: the Scheduled Task functions record what they would do instead of doing it.
$TestMode = ($env:WATCHBELL_INSTALL_TEST -eq '1')
$script:Step = 'arguments'
$script:StoppedTasks = @()
$script:LegacyState = ''
$script:LegacyRunning = $false
$script:LegacyReplace = $false
$script:OtherTaskDir = ''

# ---------------------------------------------------------------------------------------------------------- output

function Write-Section([string]$step, [string]$title) {
  $script:Step = $step
  Write-Host ''
  Write-Host "==> $title"
}

function Write-Warn([string]$message) { Write-Host "Warning: $message" }

function Stop-Failed([string]$message) {
  [Console]::Error.WriteLine("Failed at step '$($script:Step)': $message")
  foreach ($stopped in $script:StoppedTasks) {
    [Console]::Error.WriteLine("The Scheduled Task ""$stopped"" was stopped for the rebuild. Start it again in PowerShell: Start-ScheduledTask $stopped")
  }
  exit 1
}

function Stop-BadArgs([string]$message) {
  [Console]::Error.WriteLine("install: $message")
  [Console]::Error.WriteLine('Run install.bat --help (or install.ps1 -Help) to see the options.')
  exit 2
}

function Show-Usage {
  Write-Host @'
Watchbell installer for Windows 10/11

Usage: install.bat [options]
       powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [options]

Options (the PowerShell and the bash-style spellings both work):
  -Yes,       --yes          Answer yes to every question (creates the auto-start)
  -NoService, --no-service   Do not create the auto-start (the per-user Scheduled Task "Watchbell")
  -Port <n>,  --port <n>     Port to listen on (default 3100); app\.env keeps its PORT if it already has one
  -Upgrade,   --upgrade      git pull --ff-only first (only in a clean checkout of its own), then the new installer
  -Help,      --help         Show this help

An older Scheduled Task "Watchpost" from an earlier install of this folder is offered for replacement by "Watchbell".
Steps: check Node.js 24, npm, disk and memory; write app\.env (only missing or empty keys; a value that is
set is never changed) and limit it to your user; npm ci; npm run build; optionally a Scheduled Task that starts Watchbell when you sign in.
Exit codes: 0 ok, 1 a step failed (the message names it), 2 bad arguments.
'@
}

# ------------------------------------------------------------------------------------------------------- arguments

$Opt = @{ Yes = $false; NoService = $false; Upgrade = $false; Help = $false; Port = $null }
$argList = @($args)
for ($i = 0; $i -lt $argList.Count; $i++) {
  $raw = [string]$argList[$i]
  if ($raw -eq '/?') { $Opt.Help = $true; continue }
  if ($raw -notmatch '^--?([A-Za-z?][A-Za-z-]*)(?:[=:](.*))?$') { Stop-BadArgs "unexpected argument '$raw'" }
  $name = $Matches[1].ToLower().Replace('-', '')
  $inline = $Matches[2]
  switch ($name) {
    { $_ -in 'yes', 'y' } { $Opt.Yes = $true }
    'noservice' { $Opt.NoService = $true }
    'upgrade' { $Opt.Upgrade = $true }
    { $_ -in 'help', 'h', '?' } { $Opt.Help = $true }
    'port' {
      $value = $inline
      if ($null -eq $value) {
        if ($i + 1 -ge $argList.Count) { Stop-BadArgs '--port needs a number, for example --port 3100' }
        $i++
        $value = [string]$argList[$i]
      }
      $n = 0
      if (-not ($value -match '^\d{1,5}$' -and [int]::TryParse($value, [ref]$n) -and $n -ge 1 -and $n -le 65535)) {
        Stop-BadArgs "--port must be a number from 1 to 65535, not '$value'"
      }
      $Opt.Port = $n
    }
    default { Stop-BadArgs "unknown option '$raw'" }
  }
}

if ($Opt.Help) { Show-Usage; exit 0 }

# --------------------------------------------------------------------------------------------------------- helpers

function Confirm-Choice([string]$question) {
  if ($Opt.Yes) { Write-Host "$question [y/N] yes (--yes)"; return $true }
  # Read-Host throws in a host without input (powershell -NonInteractive); no answer is a no, never an error.
  $answer = $null
  try { $answer = Read-Host "$question [y/N]" } catch { Write-Host "$question [y/N]" }
  if ($null -eq $answer) { Write-Host '(no answer: no)'; return $false }
  return ($answer.Trim() -match '^(y|yes)$')
}

# Runs a program with its output shown; returns the exit code. Native stderr must never become a terminating error.
function Invoke-Program([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe @argv | Out-Host; return $LASTEXITCODE }
  catch { Write-Host $_.Exception.Message; return 1 }
  finally { $ErrorActionPreference = $old }
}

# Runs a program and captures its standard output (stderr dropped).
function Get-ProgramOutput([string]$exe, [string[]]$argv) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $exe @argv 2>$null
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ((@($out) | ForEach-Object { [string]$_ }) -join "`n").Trim() }
  } catch {
    return [pscustomobject]@{ Code = 1; Text = '' }
  } finally { $ErrorActionPreference = $old }
}

function Find-Program([string]$name) {
  return Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-NodeInfo {
  $cmd = Find-Program 'node'
  if ($null -eq $cmd) { return [pscustomobject]@{ Path = $null; Version = ''; Major = 0 } }
  $v = Get-ProgramOutput $cmd.Source @('-v')
  $major = 0
  if ($v.Text -match '^v?(\d+)\.') { $major = [int]$Matches[1] }
  return [pscustomobject]@{ Path = $cmd.Source; Version = $v.Text; Major = $major }
}

# KEY=VALUE pairs of app\.env (comments and blank lines skipped); a key with a value anywhere counts as set. Values are
# never printed.
function Read-EnvFile {
  $values = [ordered]@{}
  if (-not (Test-Path -LiteralPath $EnvFile)) { return $values }
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
      $v = $Matches[2].Trim()
      if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      if ($v -or -not $values[$Matches[1]]) { $values[$Matches[1]] = $v }
    }
  }
  return $values
}

function Test-SameFolder([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  try {
    $fa = [IO.Path]::GetFullPath($a.Replace('/', '\')).TrimEnd('\')
    $fb = [IO.Path]::GetFullPath($b.Replace('/', '\')).TrimEnd('\')
    return ($fa -ieq $fb)
  } catch { return $false }
}

# Restricts app\.env (it holds OPS_ENCRYPTION_KEY) to the current user, without admin rights: no inherited entries,
# read, write and delete for this user's SID only (without D the user could not delete the file or the Watchbell folder
# where the parent folder grants no delete-child right, e.g. on a second drive). A missing or failing icacls only warns.
function Protect-EnvFile {
  $icacls = Find-Program 'icacls'
  if ($null -eq $icacls) {
    Write-Warn 'icacls was not found, so app\.env keeps the permissions of its folder. Keep this folder private.'
    return
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $r = Get-ProgramOutput $icacls.Source @($EnvFile, '/inheritance:r', '/grant:r', "*${sid}:(R,W,D)")
  if ($r.Code -ne 0) {
    Write-Warn "icacls could not limit app\.env to your user (exit $($r.Code)); it keeps the permissions of its folder."
  } else {
    Write-Host 'app\.env can be read and changed by your user only.'
  }
}

function New-RandomBytes([int]$count) {
  $bytes = New-Object byte[] $count
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return , $bytes
}

function New-Base64Secret([int]$count) { return [Convert]::ToBase64String((New-RandomBytes $count)) }

function New-Base64UrlSecret([int]$count) {
  return [Convert]::ToBase64String((New-RandomBytes $count)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-PortBusy([int]$port) {
  try {
    $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop
    if ($conn) { return $true }
  } catch { }
  $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, $port)
  $listener.ExclusiveAddressUse = $true
  try { $listener.Start(); return $false } catch { return $true } finally { try { $listener.Stop() } catch { } }
}

# ------------------------------------------------------------------------------ Scheduled Task (stubbed in tests)

function Write-TestRecord([string]$text) {
  if ($env:WATCHBELL_INSTALL_TEST_LOG) {
    [IO.File]::AppendAllText($env:WATCHBELL_INSTALL_TEST_LOG, "$text`r`n", (New-Object Text.UTF8Encoding $false))
  }
  Write-Host "[test] $text"
}

# State '' when there is no task, otherwise its state (Ready, Running, Disabled, ...), plus the WorkingDirectory of its
# action, which tells which install owns it.
function Get-WatchbellTaskInfo([string]$name = $TaskName) {
  if ($TestMode) {
    $dir = $AppDir
    if ($name -eq $LegacyTaskName) {
      if ($env:WATCHBELL_TEST_LEGACY_TASK_DIR) { $dir = $env:WATCHBELL_TEST_LEGACY_TASK_DIR }
      return [pscustomobject]@{ State = [string]$env:WATCHBELL_TEST_LEGACY_TASK_STATE; WorkingDirectory = $dir }
    }
    if ($env:WATCHBELL_TEST_TASK_DIR) { $dir = $env:WATCHBELL_TEST_TASK_DIR }
    return [pscustomobject]@{ State = [string]$env:WATCHBELL_TEST_TASK_STATE; WorkingDirectory = $dir }
  }
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($null -eq $task) { return [pscustomobject]@{ State = ''; WorkingDirectory = '' } }
  $dir = ''
  $action = @($task.Actions) | Select-Object -First 1
  if ($action -and $action.WorkingDirectory) { $dir = [string]$action.WorkingDirectory }
  return [pscustomobject]@{ State = [string]$task.State; WorkingDirectory = $dir }
}

# The task's action: a headless console runs cmd, which appends the server's output to app\data\watchbell.log.
# scripts\start-selfhost.mjs reads app\.env itself (HOST, PORT and the rest), so the action passes no environment.
function Get-WatchbellTaskDefinition([string]$nodePath) {
  $system32 = Join-Path $env:SystemRoot 'System32'
  $cmdExe = Join-Path $system32 'cmd.exe'
  $line = '(if not exist data mkdir data) & "' + $nodePath + '" scripts\start-selfhost.mjs >> data\watchbell.log 2>&1'
  return [pscustomobject]@{
    Execute = (Join-Path $system32 'conhost.exe')
    Argument = '--headless "' + $cmdExe + '" /d /s /c "' + $line + '"'
    WorkingDirectory = $AppDir
    User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  }
}

function New-WatchbellTask($def) {
  $action = New-ScheduledTaskAction -Execute $def.Execute -Argument $def.Argument -WorkingDirectory $def.WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $def.User
  $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -Priority 5
  $principal = New-ScheduledTaskPrincipal -UserId $def.User -LogonType Interactive -RunLevel Limited
  return New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Starts Watchbell when you sign in. Created by install.ps1; remove it with uninstall.bat.'
}

function Register-WatchbellTask($def) {
  $task = New-WatchbellTask $def
  if ($TestMode) {
    $record = [ordered]@{
      Execute = $task.Actions[0].Execute
      Argument = $task.Actions[0].Arguments
      WorkingDirectory = $task.Actions[0].WorkingDirectory
      Trigger = $task.Triggers[0].CimClass.CimClassName
      TriggerUser = $task.Triggers[0].UserId
      LogonType = [string]$task.Principal.LogonType
      RunLevel = [string]$task.Principal.RunLevel
      RestartCount = $task.Settings.RestartCount
      RestartInterval = $task.Settings.RestartInterval
      ExecutionTimeLimit = $task.Settings.ExecutionTimeLimit
      DisallowStartIfOnBatteries = $task.Settings.DisallowStartIfOnBatteries
    }
    Write-TestRecord ('task register ' + ($record | ConvertTo-Json -Compress))
    return
  }
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

# The task functions take the task's name: Watchbell by default, Watchpost for the older task of an earlier install.
function Start-WatchbellTask([string]$name = $TaskName) {
  if ($TestMode) {
    if ($name -eq $LegacyTaskName) { Write-TestRecord 'legacy task start' } else { Write-TestRecord 'task start' }
    return
  }
  Start-ScheduledTask -TaskName $name
}

function Stop-WatchbellTask([string]$name = $TaskName) {
  if ($TestMode) {
    if ($name -eq $LegacyTaskName) { Write-TestRecord 'legacy task stop' } else { Write-TestRecord 'task stop' }
    return
  }
  Stop-ScheduledTask -TaskName $name
}

function Remove-LegacyWatchbellTask {
  if ($TestMode) { Write-TestRecord 'legacy task unregister'; return }
  Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false
}

# Clean stop first (npm run stop:selfhost: a stop-request file, the server closes PGlite and exits); Stop-ScheduledTask
# is a hard kill, used only when the clean stop did not finish in time.
function Stop-WatchbellGracefully([string]$name = $TaskName) {
  Write-Host 'Stopping Watchbell cleanly (npm run stop:selfhost)...'
  Push-Location -LiteralPath $AppDir
  try { $code = Invoke-Program $script:NpmPath @('run', 'stop:selfhost') } finally { Pop-Location }
  if ($code -ne 0) {
    Write-Warn "the clean stop did not finish (exit $code); forcing it with Stop-ScheduledTask $name."
    Stop-WatchbellTask $name
  }
}

# --------------------------------------------------------------------------------------------------------- steps

function Invoke-Upgrade {
  Write-Section 'upgrade' 'Updating the code (git pull --ff-only)'
  $git = Find-Program 'git'
  if ($null -eq $git) { Stop-Failed 'git was not found. Install Git for Windows, or download the new release by hand.' }
  $top = Get-ProgramOutput $git.Source @('-C', $RepoRoot, 'rev-parse', '--show-toplevel')
  if ($top.Code -ne 0 -or -not $top.Text) {
    Stop-Failed "$RepoRoot is not a git checkout. Download the new release and copy app\.env and app\data into it."
  }
  # Never pull a parent repository that merely contains this folder.
  if (-not (Test-SameFolder $top.Text $RepoRoot)) {
    Stop-Failed ("$RepoRoot is not a git checkout of its own (it is inside $($top.Text)), so --upgrade will not pull. " +
      'Download the new release and copy app\.env and app\data into it.')
  }
  $status = Get-ProgramOutput $git.Source @('-C', $RepoRoot, 'status', '--porcelain', '--untracked-files=no')
  if ($status.Code -ne 0) { Stop-Failed 'git status failed.' }
  if ($status.Text) {
    Stop-Failed 'the checkout has local changes (git status). Commit or stash them, or run without --upgrade.'
  }
  $code = Invoke-Program $git.Source @('-C', $RepoRoot, 'pull', '--ff-only')
  if ($code -ne 0) { Stop-Failed "git pull --ff-only failed (exit $code). Fix the checkout by hand and run again." }

  # The pull may have brought a newer installer: run that one for the remaining steps, with the same options minus
  # --upgrade, and finish with its exit code.
  $rest = @($argList | ForEach-Object { [string]$_ } | Where-Object { $_ -notmatch '^--?upgrade$' })
  Write-Host 'Running the updated installer for the remaining steps...'
  $exe = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $ErrorActionPreference = 'Continue'
  & $exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'install.ps1') @rest
  exit $LASTEXITCODE
}

function Assert-Prerequisites {
  Write-Section 'prerequisites' 'Checking prerequisites'
  $os = [Environment]::OSVersion
  if ($os.Platform -ne [PlatformID]::Win32NT -or $os.Version.Major -lt 10) {
    Stop-Failed 'Watchbell needs Windows 10 or 11.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $AppDir 'package.json'))) {
    Stop-Failed "app\package.json was not found next to install.ps1 ($RepoRoot). Run the installer from the Watchbell folder."
  }

  $node = Get-NodeInfo
  if ($node.Major -ne $NodeMajor) {
    # No automatic install: the Node.js MSIs are machine-wide and need admin rights, which this installer never uses.
    if ($node.Major -eq 0) { Write-Host 'Node.js was not found.' }
    else { Write-Host "Node.js $($node.Version) is installed." }
    Write-Host 'Watchbell needs Node.js 24. Download the Windows installer (.msi) from https://nodejs.org/dist/latest-v24.x/, install it, then run install.bat again.'
    Stop-Failed "Node.js $NodeMajor is required."
  }
  Write-Host "Node.js $($node.Version) ($($node.Path))"
  $script:NodePath = $node.Path

  $npm = Find-Program 'npm'
  if ($null -eq $npm) { Stop-Failed 'npm was not found. It comes with Node.js: reinstall Node.js 24 with its default options.' }
  $script:NpmPath = $npm.Source
  Write-Host "npm ($($npm.Source))"

  $free = $null
  try { $free = (New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($RepoRoot))).AvailableFreeSpace } catch { }
  if ($null -eq $free) { Write-Warn 'could not check the free disk space (at least 2 GB is needed).' }
  elseif ($free -lt 2GB) {
    Stop-Failed ("only {0:N1} GB free on the drive of $RepoRoot; at least 2 GB is needed." -f ($free / 1GB))
  } else { Write-Host ('Free disk space: {0:N1} GB' -f ($free / 1GB)) }

  try {
    $ram = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory
    if ($ram -lt 2GB) { Write-Warn ('{0:N1} GB of memory; Watchbell wants at least 2 GB, the build may be slow or fail.' -f ($ram / 1GB)) }
    else { Write-Host ('Memory: {0:N1} GB' -f ($ram / 1GB)) }
  } catch { Write-Warn 'could not check the memory (at least 2 GB is recommended).' }
}

function Assert-PortFree([int]$port) {
  Write-Section 'port' "Checking that port $port is free"
  $running = @()
  if ($script:TaskWasRunning) { $running += $TaskName }
  if ($script:LegacyRunning) { $running += $LegacyTaskName }
  foreach ($name in $running) {
    Write-Host "The Scheduled Task ""$name"" is running; stopping it for the rebuild (it starts again at the end)."
    Stop-WatchbellGracefully $name
    $script:StoppedTasks += $name
  }
  if ($running.Count -gt 0) {
    for ($t = 0; $t -lt 15 -and (Test-PortBusy $port); $t++) { Start-Sleep -Seconds 1 }
  }
  if (Test-PortBusy $port) {
    Stop-Failed ("port $port is already in use by another program. Stop that program, or choose another port, " +
      'for example: install.bat --port 3200 (install.ps1 -Port 3200). When app\.env already has PORT, edit it there.')
  }
  Write-Host "Port $port is free."
}

function Write-EnvFile([System.Collections.Specialized.OrderedDictionary]$existing, [int]$port) {
  Write-Section 'env file' 'Writing app\.env'
  if (-not (Test-Path -LiteralPath $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
  $wanted = [ordered]@{
    WATCHBELL_MODE = { 'selfhost' }
    DATABASE_URL = { 'pglite:' }
    WATCHBELL_DATA_DIR = { './data' }
    HOST = { '127.0.0.1' }
    PORT = { "$port" }
    SITE_URL = { "http://localhost:$port" }
    OPS_ENCRYPTION_KEY = { New-Base64Secret 32 }
    COLLECTOR_SECRET = { New-Base64UrlSecret 32 }
    CRON_SECRET = { New-Base64UrlSecret 24 }
  }
  # Only a non-empty value counts: a key present but empty (app\.env.example copied by hand) is filled in place, a key
  # not present at all is appended. Every other line and every non-empty value stays exactly as it is.
  $fill = [ordered]@{}
  foreach ($k in $wanted.Keys) {
    if ($existing[$k]) { continue }
    # An env file from an earlier install has WATCHPOST_MODE / WATCHPOST_DATA_DIR: the app still reads those names, so
    # they count as the key being there (no duplicate under the new name; the old line stays as it is).
    if ($k -like 'WATCHBELL_*' -and $existing['WATCHPOST_' + $k.Substring('WATCHBELL_'.Length)]) { continue }
    $fill[$k] = [string](& $wanted[$k])
  }
  $utf8 = New-Object Text.UTF8Encoding $false

  if (-not (Test-Path -LiteralPath $EnvFile)) {
    $out = @(
      '# Watchbell settings, written by install.ps1. app\.env.example explains every option.',
      '# Never change or lose OPS_ENCRYPTION_KEY: it encrypts the tokens you save, without it they cannot be read.'
    ) + @($fill.Keys | ForEach-Object { "$_=$($fill[$_])" })
    [IO.File]::WriteAllText($EnvFile, ($out -join "`r`n") + "`r`n", $utf8)
    Write-Host "Created $EnvFile with new secrets (they are not shown here)."
  } elseif ($fill.Count -eq 0) {
    Write-Host 'app\.env already has every key; nothing changed.'
  } else {
    $text = [IO.File]::ReadAllText($EnvFile)
    $nl = "`n"
    if ($text.Contains("`r`n")) { $nl = "`r`n" }
    $src = @($text -split "\r?\n")
    if ($text.EndsWith("`n")) { $src = @($src | Select-Object -First ($src.Count - 1)) }
    $out = New-Object System.Collections.Generic.List[string]
    $filled = @{}
    foreach ($line in $src) {
      if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=' -and $fill.Contains($Matches[1])) {
        $out.Add("$($Matches[1])=$($fill[$Matches[1]])")
        $filled[$Matches[1]] = $true
        continue
      }
      $out.Add($line)
    }
    $added = @($fill.Keys | Where-Object { -not $filled[$_] })
    foreach ($k in $added) { $out.Add("$k=$($fill[$k])") }
    [IO.File]::WriteAllText($EnvFile, ($out -join $nl) + $nl, $utf8)
    if ($filled.Count) { Write-Host "Filled in the empty keys in app\.env: $(@($fill.Keys | Where-Object { $filled[$_] }) -join ', ')." }
    if ($added.Count) { Write-Host "Added the missing keys to app\.env: $($added -join ', ')." }
    Write-Host 'Every value that was already set was kept (new secrets are not shown here).'
  }
  Protect-EnvFile
}

function Invoke-InApp([string]$step, [string]$title, [string[]]$argv) {
  Write-Section $step $title
  Push-Location -LiteralPath $AppDir
  try { $code = Invoke-Program $script:NpmPath $argv } finally { Pop-Location }
  if ($code -ne 0) { Stop-Failed "npm $($argv -join ' ') failed (exit $code). Read the output above." }
}

function Show-ManualStart {
  Write-Host 'Start Watchbell from this folder with:'
  Write-Host '  cd app && npm run start:selfhost        (Command Prompt)'
  Write-Host '  cd app; npm run start:selfhost          (PowerShell)'
  Write-Host 'Stop it with Ctrl+C in that window, or from another window in app\: npm run stop:selfhost'
}

function Set-AutoStart {
  Write-Section 'auto-start' 'Auto-start'
  if ($Opt.NoService) {
    Write-Host 'Skipped (--no-service).'
  } elseif ($script:OtherTaskDir) {
    Write-Host "Not created: the Scheduled Task ""$TaskName"" belongs to another install ($($script:OtherTaskDir))."
    Write-Host 'Run that install''s uninstall.bat first if this one should start automatically.'
  } elseif ($script:LegacyState -and -not $script:LegacyReplace) {
    Write-Host "Not created: the older Scheduled Task ""$LegacyTaskName"" still starts Watchbell for this folder."
  } elseif ($script:LegacyReplace -or (Confirm-Choice "Start Watchbell automatically when you sign in to Windows? This adds the Scheduled Task ""$TaskName"" for your user (no admin rights)")) {
    Register-WatchbellTask (Get-WatchbellTaskDefinition $script:NodePath)
    if ($script:LegacyReplace) {
      Remove-LegacyWatchbellTask
      Write-Host "Removed the older Scheduled Task ""$LegacyTaskName"" (replaced by ""$TaskName"")."
    }
    Start-WatchbellTask
    $script:StoppedTasks = @()
    Write-Host "Scheduled Task ""$TaskName"" created and started. It starts Watchbell hidden each time you sign in."
    Write-Host 'Stop it cleanly (it closes its database first), in app\:'
    Write-Host '  npm run stop:selfhost'
    Write-Host 'Start it again, in PowerShell:'
    Write-Host "  Start-ScheduledTask $TaskName"
    Write-Host "Only if npm run stop:selfhost says it timed out, force it (a hard stop), in PowerShell:"
    Write-Host "  Stop-ScheduledTask $TaskName"
    Write-Host "Log: app\data\watchbell.log ($LogFile)"
    return $true
  } else {
    Write-Host 'No auto-start created.'
  }
  $startedAgain = $false
  $left = @()
  if ($script:TaskState) { $left += , @($TaskName, $script:TaskWasRunning) }
  if ($script:LegacyState -and -not $script:LegacyReplace) { $left += , @($LegacyTaskName, $script:LegacyRunning) }
  foreach ($t in $left) {
    Write-Host "The existing Scheduled Task ""$($t[0])"" was left as it is (uninstall.bat removes it)."
    if ($t[1]) {
      Start-WatchbellTask $t[0]
      $script:StoppedTasks = @($script:StoppedTasks | Where-Object { $_ -ne $t[0] })
      Write-Host 'It was running before, so it was started again.'
      $startedAgain = $true
    }
  }
  if ($startedAgain) { return $true }
  Show-ManualStart
  return $false
}

# ---------------------------------------------------------------------------------------------------------- main

try {
  Write-Host "Watchbell installer - $RepoRoot"
  if ($Opt.Upgrade) { Invoke-Upgrade }
  Assert-Prerequisites

  $existing = Read-EnvFile
  $port = $DefaultPort
  if ($Opt.Port) { $port = $Opt.Port }
  if ($existing['PORT']) {
    # A set PORT is never changed; an empty one is filled with the chosen port by Write-EnvFile.
    $envPort = 0
    $raw = [string]$existing['PORT']
    if (-not ($raw -match '^\d{1,5}$' -and [int]::TryParse($raw, [ref]$envPort) -and $envPort -ge 1 -and $envPort -le 65535)) {
      $script:Step = 'env file'
      Stop-Failed "app\.env sets PORT=$raw, which is not a port number. Fix PORT (and SITE_URL) in app\.env, or empty it to use $port."
    }
    if ($Opt.Port -and $Opt.Port -ne $envPort) {
      Write-Warn "app\.env already sets PORT=$envPort; keeping it. Edit PORT and SITE_URL in app\.env to change it."
    }
    $port = $envPort
  }

  # The task is ours only when its action runs in this install's app folder; another install's task is left alone.
  $info = Get-WatchbellTaskInfo
  $script:TaskState = ''
  $script:OtherTaskDir = ''
  if ($info.State) {
    if (Test-SameFolder $info.WorkingDirectory $AppDir) { $script:TaskState = $info.State }
    else {
      $script:OtherTaskDir = $info.WorkingDirectory
      Write-Warn "the Scheduled Task ""$TaskName"" belongs to another install ($($info.WorkingDirectory)); it is left as it is."
    }
  }
  $script:TaskWasRunning = ($script:TaskState -eq 'Running')
  # The task a Watchpost-era install of THIS folder left behind: replaced by "Watchbell" when you agree (--yes agrees);
  # when you decline (or pass --no-service) it stays as it is. Another folder's Watchpost task is never touched.
  $legacy = Get-WatchbellTaskInfo $LegacyTaskName
  if ($legacy.State -and (Test-SameFolder $legacy.WorkingDirectory $AppDir)) {
    $script:LegacyState = $legacy.State
    $script:LegacyRunning = ($legacy.State -eq 'Running')
    if (-not $Opt.NoService -and -not $script:OtherTaskDir -and (Confirm-Choice "An earlier install of this folder created the Scheduled Task ""$LegacyTaskName"" (Watchpost is now called Watchbell). Replace it with ""$TaskName""?")) {
      $script:LegacyReplace = $true
    } else {
      Write-Host "The older Scheduled Task ""$LegacyTaskName"" is left as it is; it keeps starting Watchbell for this folder."
    }
  }
  Assert-PortFree $port
  Write-EnvFile $existing $port
  Invoke-InApp 'npm ci' 'Installing dependencies (npm ci)' @('ci')
  $env:WATCHBELL_MODE = 'selfhost'
  Invoke-InApp 'build' 'Building (npm run build)' @('run', 'build')
  $running = Set-AutoStart

  $script:Step = 'done'
  Write-Host ''
  Write-Host 'Watchbell is installed.'
  if (-not $running) { Write-Host 'After you start it:' }
  Write-Host "Open http://localhost:$port/setup - the one-time setup code is printed in the server log and saved in app\data\setup-code"
  exit 0
} catch {
  [Console]::Error.WriteLine("Failed at step '$($script:Step)': $($_.Exception.Message)")
  exit 1
}
