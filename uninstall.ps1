# Watchbell uninstaller for Windows 10/11 (Windows PowerShell 5.1 or later). Double-click uninstall.bat, or
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1 [-Yes] [-Help]
# The bash-style spellings work too (--yes, --help).
# It stops and removes the per-user Scheduled Task "Watchbell" (and the older "Watchpost" task of this folder, from
# before the product was renamed). It never deletes app\data (the database, the setup
# code, the log) or app\.env (the settings and the encryption key): it prints both paths and how to delete them.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.

$ErrorActionPreference = 'Stop'

$TaskName = 'Watchbell'
# The name an earlier install of this folder used, when the product was still called Watchpost.
$LegacyTaskName = 'Watchpost'
$DefaultPort = 3100
$RepoRoot = $PSScriptRoot
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$AppDir = Join-Path $RepoRoot 'app'
$EnvFile = Join-Path $AppDir '.env'
$DataDir = Join-Path $AppDir 'data'
# Test hook: the Scheduled Task functions record what they would do instead of doing it.
$TestMode = ($env:WATCHBELL_INSTALL_TEST -eq '1')
$script:Step = 'arguments'

function Stop-BadArgs([string]$message) {
  [Console]::Error.WriteLine("uninstall: $message")
  [Console]::Error.WriteLine('Run uninstall.bat --help (or uninstall.ps1 -Help) to see the options.')
  exit 2
}

function Show-Usage {
  Write-Host @'
Watchbell uninstaller for Windows 10/11

Usage: uninstall.bat [options]
       powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [options]

Options (the PowerShell and the bash-style spellings both work):
  -Yes,  --yes    Do not ask before stopping and removing the Scheduled Task "Watchbell"
  -Help, --help   Show this help

An older Scheduled Task "Watchpost" of this install (from before the rename) is removed the same way.
It never deletes app\data (database, setup code, log) or app\.env (settings and encryption key);
it prints both paths and how to delete them by hand.
Exit codes: 0 ok, 1 a step failed (the message names it), 2 bad arguments.
'@
}

$Opt = @{ Yes = $false; Help = $false }
foreach ($raw in @($args)) {
  $a = [string]$raw
  if ($a -eq '/?') { $Opt.Help = $true; continue }
  if ($a -notmatch '^--?([A-Za-z?][A-Za-z-]*)$') { Stop-BadArgs "unexpected argument '$a'" }
  switch ($Matches[1].ToLower()) {
    { $_ -in 'yes', 'y' } { $Opt.Yes = $true }
    { $_ -in 'help', 'h', '?' } { $Opt.Help = $true }
    default { Stop-BadArgs "unknown option '$a'" }
  }
}
if ($Opt.Help) { Show-Usage; exit 0 }

function Confirm-Choice([string]$question) {
  if ($Opt.Yes) { Write-Host "$question [y/N] yes (--yes)"; return $true }
  # Read-Host throws in a host without input (powershell -NonInteractive); no answer is a no, never an error.
  $answer = $null
  try { $answer = Read-Host "$question [y/N]" } catch { Write-Host "$question [y/N]" }
  if ($null -eq $answer) { Write-Host '(no answer: no)'; return $false }
  return ($answer.Trim() -match '^(y|yes)$')
}

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

function Test-SameFolder([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  try {
    $fa = [IO.Path]::GetFullPath($a.Replace('/', '\')).TrimEnd('\')
    $fb = [IO.Path]::GetFullPath($b.Replace('/', '\')).TrimEnd('\')
    return ($fa -ieq $fb)
  } catch { return $false }
}

function Stop-WatchbellTask([string]$name = $TaskName) {
  if ($TestMode) {
    if ($name -eq $LegacyTaskName) { Write-TestRecord 'legacy task stop' } else { Write-TestRecord 'task stop' }
    return
  }
  Stop-ScheduledTask -TaskName $name
}

# Clean stop first (npm run stop:selfhost in app\: the server closes PGlite and exits); Stop-ScheduledTask is a hard
# kill, used only when the clean stop could not run or did not finish in time.
function Stop-WatchbellGracefully([string]$name = $TaskName) {
  $npm = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  $code = 1
  if ($null -eq $npm) {
    Write-Host 'npm was not found, so Watchbell cannot be stopped cleanly.'
  } else {
    Write-Host 'Stopping Watchbell cleanly (npm run stop:selfhost)...'
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $AppDir
    try { & $npm.Source run stop:selfhost | Out-Host; $code = $LASTEXITCODE }
    catch { Write-Host $_.Exception.Message }
    finally { Pop-Location; $ErrorActionPreference = $old }
  }
  if ($code -ne 0) {
    Write-Host "Forcing it with Stop-ScheduledTask $name (a hard stop)."
    Stop-WatchbellTask $name
  }
}

function Unregister-WatchbellTask([string]$name = $TaskName) {
  if ($TestMode) {
    if ($name -eq $LegacyTaskName) { Write-TestRecord 'legacy task unregister' } else { Write-TestRecord 'task unregister' }
    return
  }
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}

function Get-EnvPort {
  if (-not (Test-Path -LiteralPath $EnvFile)) { return $DefaultPort }
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line -match '^\s*PORT\s*=\s*["'']?(\d{1,5})["'']?\s*$') { return [int]$Matches[1] }
  }
  return $DefaultPort
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

try {
  Write-Host "Watchbell uninstaller - $RepoRoot"
  Write-Host ''
  $script:Step = 'auto-start'
  Write-Host '==> Auto-start'
  $info = Get-WatchbellTaskInfo
  $state = $info.State
  if (-not $state) {
    Write-Host "No Scheduled Task ""$TaskName"" was found; nothing to remove."
  } elseif (-not (Test-SameFolder $info.WorkingDirectory $AppDir)) {
    # Only this install's task is removed: its action runs in this install's app folder.
    Write-Host "The Scheduled Task ""$TaskName"" belongs to another install ($($info.WorkingDirectory)); it was left as it is."
    Write-Host 'Run that install''s uninstall.bat to remove it.'
  } elseif (Confirm-Choice "Stop and remove the Scheduled Task ""$TaskName"" (Watchbell will no longer start when you sign in)?") {
    if ($state -eq 'Running') { Stop-WatchbellGracefully; Write-Host 'Stopped Watchbell.' }
    Unregister-WatchbellTask
    Write-Host "Removed the Scheduled Task ""$TaskName""."
  } else {
    Write-Host "Kept the Scheduled Task ""$TaskName"". Nothing was changed."
  }

  # The task an earlier install of THIS folder created under the old name (Watchpost): removed the same way, only when
  # its action runs in this folder. Nothing is printed when there is none.
  $legacy = Get-WatchbellTaskInfo $LegacyTaskName
  if ($legacy.State -and (Test-SameFolder $legacy.WorkingDirectory $AppDir)) {
    if (Confirm-Choice "Stop and remove the older Scheduled Task ""$LegacyTaskName"" too (from before Watchpost was renamed Watchbell)?") {
      if ($legacy.State -eq 'Running') { Stop-WatchbellGracefully $LegacyTaskName; Write-Host 'Stopped Watchbell.' }
      Unregister-WatchbellTask $LegacyTaskName
      Write-Host "Removed the older Scheduled Task ""$LegacyTaskName""."
    } else {
      Write-Host "Kept the older Scheduled Task ""$LegacyTaskName""."
    }
  }

  $script:Step = 'check'
  $port = Get-EnvPort
  if (Test-PortBusy $port) {
    Write-Host ''
    Write-Host "Something still listens on port $port (a Watchbell started by hand?). Stop it with Ctrl+C in its window, or in app\: npm run stop:selfhost"
  }

  $script:Step = 'done'
  Write-Host ''
  Write-Host 'Your data and settings were kept:'
  Write-Host "  $DataDir    (database, setup code, log)"
  Write-Host "  $EnvFile    (settings and the encryption key)"
  Write-Host 'To delete them too, run in PowerShell:'
  Write-Host "  Remove-Item -LiteralPath ""$DataDir"" -Recurse -Force"
  Write-Host "  Remove-Item -LiteralPath ""$EnvFile"" -Force"
  Write-Host "Or delete the whole folder $RepoRoot to remove Watchbell completely."
  exit 0
} catch {
  [Console]::Error.WriteLine("Failed at step '$($script:Step)': $($_.Exception.Message)")
  exit 1
}
