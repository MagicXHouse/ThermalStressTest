@echo off
rem ---------------------------------------------------------------------------
rem iOS temperature sampler (Windows wrapper around monitor_temp_ios.ps1).
rem
rem Behaviour mirrors monitor_temp.bat (Android), which starts every run with
rem "echo Time,Temperature> temp_log.csv" -- the previous run's data is thrown
rem away. Here we get the same result by always passing -Fresh to the
rem PowerShell script (it truncates the CSV and rewrites the header).
rem
rem Why this matters: a silent append makes two different rounds share one
rem file, and the second round's dT baseline gets poisoned by the tail
rem temperature of the first one.
rem
rem Set KEEP_PREV=1 to keep the old file and append instead (rarely needed).
rem
rem NOTE: keep this file ASCII-only. cmd parses raw bytes under the local code
rem page, and multi-byte CJK comments can contain 0x7C/0x26 bytes that split the
rem command line (same rule as monitor_temp.bat).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
chcp 65001 >nul

set "FRESH_ARG="
if "%KEEP_PREV%"=="1" goto run

rem Do not duplicate -Fresh when the caller already asked for it.
echo %* | findstr /i /c:"-Fresh" >nul
if errorlevel 1 set "FRESH_ARG=-Fresh"

:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0monitor_temp_ios.ps1" %FRESH_ARG% %*

if errorlevel 1 (
  echo.
  echo Exit code: %errorlevel%
  pause
)
