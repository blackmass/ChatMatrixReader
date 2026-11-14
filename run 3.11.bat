@echo off
rem Starts ChatMatrixReader with Python 3.11 (own virtual environment: .venv311).
rem If Python 3.11 is not installed: https://www.python.org/downloads/  (check "py launcher").
cd /d "%~dp0"
if exist ".venv311\.ready" goto run
echo First run: creating virtual environment with Python 3.11 ...
py -3.11 -m venv .venv311 || goto fail
".venv311\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
copy /y requirements.txt ".venv311\requirements.done" >nul
echo ok> ".venv311\.ready"
:run
rem requirements.txt changed since the last install (a new package): install what is missing. The program starts anyway if this fails.
fc /b requirements.txt ".venv311\requirements.done" >nul 2>&1 && goto start
echo Installing new requirements ...
".venv311\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt && copy /y requirements.txt ".venv311\requirements.done" >nul || echo Could not install the new requirements: the program starts without them.
:start
start "" ".venv311\Scripts\pythonw.exe" app\app.py
exit /b 0
:fail
echo Setup failed. Is Python 3.11 installed?  Check:  py -3.11 --version
rmdir /s /q ".venv311" 2>nul
pause
exit /b 1
