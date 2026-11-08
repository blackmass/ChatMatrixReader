@echo off
cd /d "%~dp0"
rem Same as run.bat but with a console window, so Python errors are visible. Use it only for debugging.
".venv\Scripts\python.exe" app.py
pause
