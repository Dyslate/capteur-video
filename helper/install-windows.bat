@echo off
rem Installs the Capteur video local helper (needs Python 3.9+ from python.org or the Microsoft Store).
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0install.py" %*
) else (
  python "%~dp0install.py" %*
)
echo.
pause
