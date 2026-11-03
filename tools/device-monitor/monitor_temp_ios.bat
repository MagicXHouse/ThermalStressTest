@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0monitor_temp_ios.ps1" %*
if errorlevel 1 (
  echo.
  echo Exit code: %errorlevel%
  pause
)
