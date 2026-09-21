@echo off
title Tindahan Manager
cd /d "%~dp0"
node server.js
echo.
echo The server has stopped. If you saw an error above, read it, then press any key.
pause >nul
