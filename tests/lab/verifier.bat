@echo off
rem Checks the files downloaded from the test lab.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 verify.py %*) || (python verify.py %*)
echo.
pause
