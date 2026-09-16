@echo off
rem PhotoMap - one-click launcher (Windows). Needs Node.js 18+ (https://nodejs.org)
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [PhotoMap] Node.js not found. Install it from https://nodejs.org then run this again.
  pause
  exit /b 1
)
node "%~dp0tools\serve.js"
