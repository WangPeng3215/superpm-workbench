@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop.ps1" %*
set "SUPERPM_STOP_CODE=%ERRORLEVEL%"
if not "%SUPERPM_STOP_CODE%"=="0" (
  if not defined SUPERPM_NO_PAUSE pause
)
exit /b %SUPERPM_STOP_CODE%
