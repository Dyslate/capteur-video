@echo off
rem Starts the Capteur video test lab (http://127.0.0.1:8765) and opens it in the browser.
title Capteur video - test lab
cd /d "%~dp0"
rem Find a working Python 3 ("python" can be the Microsoft Store placeholder, so test it).
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  echo.
  echo  Python 3 was not found on this PC.
  echo  Install it from python.org and tick "Add python.exe to PATH",
  echo  then run this file again.
  echo.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)
%PY% serve.py
pause
