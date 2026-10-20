@echo off
rem Runs install.ps1 for this process only (no system policy change); the options are passed through, e.g. --yes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "WATCHBELL_EXIT=%ERRORLEVEL%"
rem Keep the window open when double-clicked; --yes (unattended) skips the pause.
echo(%*| findstr /i /c:"-yes" >nul || pause
exit /b %WATCHBELL_EXIT%
