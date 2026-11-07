@echo off
rem Starts ChatMatrixReader with Python 3.11 (own virtual environment: .venv311).
rem If Python 3.11 is not installed: https://www.python.org/downloads/  (check "py launcher").
cd /d "%~dp0"
if exist ".venv311\.ready" goto run
echo First run: creating virtual environment with Python 3.11 ...
py -3.11 -m venv .venv311 || goto fail
".venv311\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
echo ok> ".venv311\.ready"
:run
start "" ".venv311\Scripts\pythonw.exe" app.py
exit /b 0
:fail
echo Setup failed. Is Python 3.11 installed?  Check:  py -3.11 --version
rmdir /s /q ".venv311" 2>nul
pause
exit /b 1
