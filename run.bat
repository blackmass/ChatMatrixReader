@echo off
cd /d "%~dp0"
if exist ".venv\.ready" goto run
echo First run: creating virtual environment ...
py -3 -m venv .venv || python -m venv .venv || goto fail
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto fail
echo ok> ".venv\.ready"
:run
start "" ".venv\Scripts\pythonw.exe" app.py
exit /b 0
:fail
echo Setup failed. Make sure Python 3 is installed ^(py -3 --version^).
rmdir /s /q ".venv" 2>nul
pause
exit /b 1
