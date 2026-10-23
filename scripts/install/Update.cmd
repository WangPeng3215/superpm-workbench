@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0bin\updater.mjs" %*
) else (
  node "%~dp0bin\updater.mjs" %*
)
exit /b %ERRORLEVEL%
