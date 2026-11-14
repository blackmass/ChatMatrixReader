@echo off
cd /d "%~dp0"
if exist ".venv\.ready" goto run
echo First run: creating virtual environment ...
py -3.11 -m venv .venv 2>nul || py -3 -m venv .venv || python -m venv .venv || goto fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
copy /y requirements.txt ".venv\requirements.done" >nul
echo ok> ".venv\.ready"
:run
rem requirements.txt changed since the last install (a new package): install what is missing. The program starts anyway if this fails.
fc /b requirements.txt ".venv\requirements.done" >nul 2>&1 && goto start
echo Installing new requirements ...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt && copy /y requirements.txt ".venv\requirements.done" >nul || echo Could not install the new requirements: the program starts without them.
:start
start "" ".venv\Scripts\pythonw.exe" app\app.py
exit /b 0
:fail
echo Setup failed. Install Python 3.11 ^(python.org^) and check:  py -3.11 --version
rmdir /s /q ".venv" 2>nul
pause
exit /b 1
