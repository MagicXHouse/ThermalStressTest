@echo off
rem ---------------------------------------------------------------------------
rem HarmonyOS NEXT temperature sampler (Windows wrapper around
rem monitor_temp_harmony.ps1).
rem
rem Why a wrapper and not pure batch: reading temperature on NEXT needs
rem   hdc shell "hidumper -s BatteryService -a '-i'"
rem i.e. a nested-quote command line, plus parsing of "temperature: 240".
rem Doing that in batch is fragile; the PowerShell script already handles it
rem (including zone selection and NA on failure), so keep one implementation.
rem
rem Behaviour matches monitor_temp.bat (Android): every run starts a NEW file
rem (the script truncates and rewrites the Time,Temperature header). A silent
rem append would let two rounds share one file and poison the second round's
rem dT baseline with the first round's tail temperature.
rem
rem Usage:
rem   monitor_temp_harmony.bat                        (5s interval, temp_log_harmony.csv)
rem   monitor_temp_harmony.bat -Interval 2 -Out run1.csv
rem   monitor_temp_harmony.bat -Source thermal -Zone shell_back -Out body.csv
rem   monitor_temp_harmony.bat -HdcPath "C:\path\to\hdc.exe"
rem
rem NOTE: keep this file ASCII-only. cmd parses raw bytes under the local code
rem page, and multi-byte CJK comments can contain 0x7C/0x26 bytes that split
rem the command line (same rule as monitor_temp.bat / monitor_temp_ios.bat).
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
chcp 65001 >nul

if not exist "%~dp0monitor_temp_harmony.ps1" (
  echo [ERROR] monitor_temp_harmony.ps1 not found next to this .bat
  pause
  exit /b 1
)

rem --- locate hdc: PATH first, then the usual Command Line Tools layout --------
set "HDC_EXE="
for %%P in (hdc.exe) do if not "%%~$PATH:P"=="" set "HDC_EXE=%%~$PATH:P"

if not defined HDC_EXE (
  for /d %%D in ("D:\commandline-tools-windows-*") do (
    if exist "%%~fD\command-line-tools\sdk\default\openharmony\toolchains\hdc.exe" (
      set "HDC_EXE=%%~fD\command-line-tools\sdk\default\openharmony\toolchains\hdc.exe"
    )
  )
)
if not defined HDC_EXE (
  for /d %%D in ("%LOCALAPPDATA%\Huawei\Sdk\*") do (
    if exist "%%~fD\toolchains\hdc.exe" set "HDC_EXE=%%~fD\toolchains\hdc.exe"
  )
)

rem --- pass -HdcPath only when hdc is not already on PATH ---------------------
set "HDC_ARG="
for %%P in (hdc.exe) do if "%%~$PATH:P"=="" (
  if defined HDC_EXE (
    set HDC_ARG=-HdcPath "%HDC_EXE%"
  ) else (
    echo [ERROR] hdc.exe not found.
    echo         Install Huawei Command Line Tools, then either add its
    echo         sdk\default\openharmony\toolchains folder to PATH, or pass
    echo         -HdcPath "C:\...\hdc.exe" to this .bat
    pause
    exit /b 1
  )
)

rem --- default output file, unless caller supplied -Out ------------------------
set "OUT_ARG="
echo %* | findstr /i /c:"-Out" >nul
if errorlevel 1 set "OUT_ARG=-Out temp_log_harmony.csv"

echo HarmonyOS temperature sampler
if defined HDC_EXE echo   hdc: %HDC_EXE%
echo   Ctrl+C to stop; a new CSV is created on every run.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0monitor_temp_harmony.ps1" %OUT_ARG% %HDC_ARG% %*

if errorlevel 1 (
  echo.
  echo Exit code: %errorlevel%
  pause
)
