@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js 22.13 or later and retry. >&2
  exit /b 127
)
node "%~dp0..\scripts\package.mjs" %*
exit /b %errorlevel%
