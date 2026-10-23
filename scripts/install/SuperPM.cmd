@echo off
setlocal
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0bin\launcher.mjs" %*
) else (
  node "%~dp0bin\launcher.mjs" %*
)
exit /b %ERRORLEVEL%
