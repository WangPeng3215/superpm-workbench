@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0.agents\skills\superpm\scripts\stop-services.ps1" -Target all
set "SUPERPM_CODE=%ERRORLEVEL%"
if not defined SUPERPM_NO_PAUSE pause
exit /b %SUPERPM_CODE%
