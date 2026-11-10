@echo off
rem Windows has no sh for the script beside this one.
set NODE_USE_ENV_PROXY=1
where node >nul 2>nul || (echo WildCrane needs Node.js 22 or later. Install it from https://nodejs.org, then restart Codex. 1>&2 & exit /b 1)
node "%~dp0..\dist\start.mjs" %*
