@echo off
rem Starts ChatMatrixReader with Python 3.15 (own virtual environment: .venv315).
rem If Python 3.15 is not installed: https://www.python.org/downloads/  (check "py launcher").
cd /d "%~dp0"
if exist ".venv315\.ready" goto run
echo First run: creating virtual environment with Python 3.15 ...
py -3.15 -m venv .venv315 || goto fail
".venv315\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
echo ok> ".venv315\.ready"
:run
start "" ".venv315\Scripts\pythonw.exe" app.py
exit /b 0
:fail
echo Setup failed. Is Python 3.15 installed?  Check:  py -3.15 --version
rmdir /s /q ".venv315" 2>nul
pause
exit /b 1
