@echo off
rem ---------------------------------------------------------------------------
rem iOS power sampler (Windows wrapper around monitor_ios_power.py).
rem
rem Use this instead of monitor_temp_ios.bat on iOS 27+: Apple removed the live
rem battery-temperature field from the diagnostics relay in iOS 27, so the only
rem numeric signal left is power telemetry (mW):
rem   PowerTelemetryData.SystemLoad    overall system draw
rem   PowerTelemetryData.BatteryPower  battery charge/discharge
rem   PowerTelemetryData.SystemPowerIn adapter input
rem
rem The CSV it writes keeps the old two leading columns (Time,Temperature) so the
rem existing chart / checker scripts still parse it; Temperature is NA on iOS 27.
rem
rem Every run truncates the CSV first (same rule as monitor_temp_ios.bat).
rem
rem NOTE: keep this file ASCII-only (cmd parses raw bytes under the local code
rem page; multi-byte CJK comments can split the command line).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
chcp 65001 >nul

python monitor_ios_power.py %*

if errorlevel 1 (
  echo.
  echo Exit code: %errorlevel%
  pause
)
