@echo off
rem Installs or updates the Capteur video local helper (yt-dlp + ffmpeg).
rem Double-click it. Add --uninstall to remove the helper.
title Capteur video - module local
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
echo Python trouve : %PY%
%PY% "%~dp0helper\install.py" %*
echo.
if errorlevel 1 (
  echo  L'installation a echoue : copiez le texte ci-dessus et envoyez-le.
) else (
  echo  Termine. Redemarrez Chrome, puis ouvrez le panneau de l'extension.
)
echo.
pause
