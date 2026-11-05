@echo off
chcp 65001 >nul
title Tuxun - Stop Local Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-location-local.ps1"
set "LOCAL_TEST_EXIT=%ERRORLEVEL%"
pause
exit /b %LOCAL_TEST_EXIT%
