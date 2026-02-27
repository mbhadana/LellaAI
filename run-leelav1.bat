@echo off
REM Launcher for LeelaV1 — double-click this to run the app
cd /d "%~dp0"
REM Prefer using the locally installed electron if available, otherwise fall back to npm start
if exist node_modules\.bin\electron (
  node_modules\.bin\electron .
) else (
  npm start
)
