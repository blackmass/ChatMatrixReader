@echo off
rem Builds cmr-stt.exe, the voice recognition engine, on Windows. Run it from anywhere; it works in this folder.
rem
rem   build.bat                 CPU only (the first engine)
rem   build.bat vulkan          with the Vulkan GPU backend (needs the Vulkan SDK)
rem   build.bat cuda            with the CUDA GPU backend (needs the CUDA Toolkit)
rem   build.bat cpu "D:\path\whisper.cpp-1.9.2"     use an unpacked copy of the official whisper.cpp source (the release zip) instead of fetching it
rem
rem Needs: CMake, Git, and Visual Studio (or its Build Tools) with the "Desktop development with C++" part.
rem Result: dist\engine-<kind>\ with cmr-stt.exe, its SHA-256, the licenses (LICENSE-whisper.cpp.txt, LICENSE.txt) and version.json (what --version says).
rem To release it: release_engines.bat in the project folder   (names the files, writes BUILD-INFO and puts the addresses into the program's catalog)
rem The version of whisper.cpp is the one written in whisper.version (fetched from the official repository at that commit).
setlocal EnableExtensions
cd /d "%~dp0"

set KIND=cpu
set GPU=none
if /i "%~1"=="vulkan" ( set KIND=vulkan& set GPU=vulkan )
if /i "%~1"=="cuda" ( set KIND=cuda& set GPU=cuda )
set SRCARG=
if not "%~2"=="" set SRCARG=-DCMR_WHISPER_DIR=%~2

where cmake >nul 2>nul || ( echo CMake was not found. Install it from https://cmake.org/download/ and run this again. & exit /b 1 )
if "%SRCARG%"=="" ( where git >nul 2>nul || ( echo Git was not found. Install it from https://git-scm.com/ , or give the folder of an unpacked whisper.cpp as the second argument. & exit /b 1 ) )

echo == configure (%KIND%)
cmake -S . -B build-%KIND% -A x64 -DCMR_WITH_WHISPER=ON -DCMR_GPU=%GPU% %SRCARG% || exit /b 1
echo == build
cmake --build build-%KIND% --config Release --parallel || exit /b 1
echo == tests
ctest --test-dir build-%KIND% -C Release --output-on-failure || exit /b 1

if not exist dist\engine-%KIND% mkdir dist\engine-%KIND%
copy /y build-%KIND%\Release\cmr-stt.exe dist\engine-%KIND%\cmr-stt.exe >nul || exit /b 1
certutil -hashfile dist\engine-%KIND%\cmr-stt.exe SHA256 > dist\engine-%KIND%\cmr-stt.exe.sha256
rem The engine is downloaded apart from the program, so the licenses travel with it (MIT: the notice must come with every copy): whisper.cpp's and ours.
set WLIC=build-%KIND%\_deps\whisper-src\LICENSE
if not "%~2"=="" set WLIC=%~2\LICENSE
if not exist "%WLIC%" ( echo The LICENSE file of whisper.cpp was not found: %WLIC% & exit /b 1 )
copy /y "%WLIC%" dist\engine-%KIND%\LICENSE-whisper.cpp.txt >nul || exit /b 1
copy /y "..\..\LICENSE" dist\engine-%KIND%\LICENSE.txt >nul || ( echo The LICENSE file of this project was not found: ..\..\LICENSE & exit /b 1 )
dist\engine-%KIND%\cmr-stt.exe --version > dist\engine-%KIND%\version.json
echo == done: dist\engine-%KIND%\cmr-stt.exe
dist\engine-%KIND%\cmr-stt.exe --version
type dist\engine-%KIND%\cmr-stt.exe.sha256
endlocal
