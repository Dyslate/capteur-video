@echo off
rem Checks the files downloaded from the test lab.
title Capteur video - verification
cd /d "%~dp0"
rem Find a working Python 3 ("python" can be the Microsoft Store placeholder, so test it).
set "PY="
py -3 --version >nul 2>&1 && set "PY=py -3"
if not defined PY python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  echo.
  echo  Python 3 est introuvable sur ce PC.
  echo  Installez-le depuis python.org en cochant "Add python.exe to PATH",
  echo  puis relancez ce fichier.
  echo.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)
%PY% verify.py %*
echo.
pause
