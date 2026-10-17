@echo off
rem Starts the Capteur video test lab (http://127.0.0.1:8765) and opens it in the browser.
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py) || (python serve.py)
pause
