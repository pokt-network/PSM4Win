@echo off
rem Pocket Service Manager: background runner used by PocketServiceManager.hta.
rem usage: runner.cmd <runsDir> <runId> <signer.ps1>
rem Runs the signer for one request file and leaves .out / .err / .done files
rem that the HTA polls. Never called by hand.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~3" -Request "%~1\%~2.req.json" > "%~1\%~2.out" 2> "%~1\%~2.err"
echo %ERRORLEVEL%> "%~1\%~2.done"
