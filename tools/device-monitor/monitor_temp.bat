@echo off
setlocal enabledelayedexpansion
echo Time,Temperature > temp_log.csv

:loop
for /f "tokens=2 delims=:" %%a in ('adb shell dumpsys battery ^| findstr /i temperature') do set raw=%%a
set raw=!raw: =!
set /a intpart=!raw!/10
set last=!raw:~-1!
set now=%time:~0,8%
echo !now!  !intpart!.!last! C
echo !now!,!intpart!.!last! >> temp_log.csv
timeout /t 5 /nobreak >nul
goto loop