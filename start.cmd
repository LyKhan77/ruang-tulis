@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"
if errorlevel 1 goto directory_failed

where node >nul 2>&1
if errorlevel 1 goto node_missing

rem This double-click entrypoint uses defaults. Use npm start -- --help or --no-open for flags.
node ./scripts/start-local.mjs
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" goto failed
endlocal & exit /b %exit_code%

:directory_failed
set "exit_code=%errorlevel%"
echo Failed to open the launcher directory. 1>&2
goto failed

:node_missing
set "exit_code=1"
echo Node.js was not found. Install the current Node.js LTS release (22.12.0 or newer), then try again. 1>&2
goto failed

:failed
echo The local launcher failed with exit code %exit_code%. 1>&2
pause
endlocal & exit /b %exit_code%
