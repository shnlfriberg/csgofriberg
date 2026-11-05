@echo off
chcp 65001 >nul
title Tuxun - Start Local Test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-location-local.ps1"
set "LOCAL_TEST_EXIT=%ERRORLEVEL%"
pause
exit /b %LOCAL_TEST_EXIT%
