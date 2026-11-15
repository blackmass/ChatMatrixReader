@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
echo === GitHub 업로드 ===

where git >nul 2>&1
if errorlevel 1 (
  echo git 이 설치되어 있지 않습니다.
  pause
  exit /b 1
)

:: 1. 저장소가 아니면 처음 한 번만 만든다 (이 폴더가 어느 브랜치용인지 정한다)
if not exist ".git" (
  echo 이 폴더는 아직 Git 저장소가 아닙니다.
  set /p NEWBR="이 폴더가 올릴 브랜치 이름 (main 또는 legacy): "
  if "!NEWBR!"=="" (
    echo 취소했습니다.
    pause
    exit /b 1
  )
  git init -b !NEWBR!
)

:: 2. 원격 저장소 (이미 연결되어 있으면 그대로 둔다)
git remote get-url origin >nul 2>&1
if errorlevel 1 git remote add origin https://github.com/blackmass/ChatMatrixReader

:: 3. 지금 이 폴더의 브랜치 (절대 이름을 바꾸지 않는다: 여기서 main 으로 바꾸면 legacy 가 main 을 덮을 수 있다)
set BR=
for /f "delims=" %%b in ('git branch --show-current') do set BR=%%b
if "!BR!"=="" (
  echo 현재 브랜치를 알 수 없습니다 ^(분리된 HEAD^). 브랜치를 선택한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
echo.
echo 원격: https://github.com/blackmass/ChatMatrixReader
echo 브랜치: !BR!
set /p OK="이 브랜치 [!BR!] 에 올릴까요? (y/N): "
if /i not "!OK!"=="y" (
  echo 취소했습니다.
  pause
  exit /b 0
)

:: 4. 파일 추가와 커밋 (.gitignore 에 적힌 파일은 제외됨)
git add .
set /p msg="커밋 메시지 (비우면 update): "
if "!msg!"=="" set msg=update
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "!msg!"
) else (
  echo 변경된 파일이 없어 커밋은 건너뜁니다.
)

:: 5. 원격에 같은 브랜치가 있으면 먼저 받아서 합친다 (없으면 새로 만든다)
git ls-remote --exit-code --heads origin !BR! >nul 2>&1
if not errorlevel 1 (
  git pull --rebase origin !BR!
  if errorlevel 1 (
    echo.
    echo 합치기에 실패했습니다. 충돌을 해결하기 전에는 올리지 않습니다.
    pause
    exit /b 1
  )
)

:: 6. 같은 이름의 브랜치로만 올린다
git push -u origin !BR!
if errorlevel 1 (
  echo.
  echo 올리기에 실패했습니다.
  pause
  exit /b 1
)

echo === 업로드가 완료되었습니다 ^(태그는 만들지 않았습니다: 릴리스 때 GitHub 에서 직접^) ===
pause
