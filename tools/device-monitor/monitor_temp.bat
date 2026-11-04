@echo off
rem Host-side temperature sampler: one Time,Temperature row every 5s.
rem Design rule: write NA instead of reusing the previous reading.
rem Temperature is the only core acceptance metric, so an invisible flat
rem segment of stale data would invalidate the whole run.
rem NOTE: keep this file ASCII-only. cmd parses raw bytes under the local
rem code page, and multi-byte CJK comments can contain 0x7C/0x26 bytes that
rem split the command line.
setlocal enabledelayedexpansion
echo Time,Temperature> temp_log.csv

:loop
rem Reset every iteration: adb may be offline and the old raw must not leak.
set "raw="
for /f "tokens=2 delims=:" %%a in ('adb shell dumpsys battery 2^>nul ^| findstr /i temperature') do set "raw=%%a"
if not defined raw (
    rem One retry on transient adb timeout, then give up and record NA.
    for /f "tokens=2 delims=:" %%a in ('adb shell dumpsys battery 2^>nul ^| findstr /i temperature') do set "raw=%%a"
)

rem Zero-pad the hour (0-9 gives " 9:33:12"), keep centiseconds for alignment.
set "now=%time: =0%"

if not defined raw (
    echo !now!,NA>> temp_log.csv
    timeout /t 5 /nobreak >nul
    goto loop
)

set "raw=!raw: =!"
rem Guard: non-numeric output means a broken adb reply, not 0.0.
echo !raw!| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo !now!,NA>> temp_log.csv
    timeout /t 5 /nobreak >nul
    goto loop
)

set /a intpart=!raw!/10
set "last=!raw:~-1!"
echo !now! !intpart!.!last! C
echo !now!,!intpart!.!last!>> temp_log.csv
timeout /t 5 /nobreak >nul
goto loop
