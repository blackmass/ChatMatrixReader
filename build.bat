@echo off
cd /d "%~dp0src-tauri"
cargo build --release || goto fail
copy /y "target\release\chatmatrix-reader.exe" "..\ChatMatrixReader.exe" >nul
echo.
echo Done: ChatMatrixReader.exe  (it needs the "app" folder next to it)
pause
exit /b 0
:fail
echo.
echo Build failed. Copy the error text above and send it.
pause
exit /b 1
