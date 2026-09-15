@echo off
rem Creates "Pocket Service Manager" shortcuts on the Desktop and in the Start menu,
rem with the Pocket icon, pointing at PocketServiceManager.hta in this folder.
rem Run once (double-click). Safe to run again; it overwrites the shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shortcut.ps1"
echo.
echo Pin the Start menu entry or the Desktop shortcut to the taskbar if you like.
pause
