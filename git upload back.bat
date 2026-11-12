@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === GitHub 업로드 ===

git rev-parse --is-inside-work-tree >nul 2>&1 || git init
git remote get-url origin >nul 2>&1 || git remote add origin https://github.com/blackmass/ChatMatrixReader
git branch -M main

:: 이미 추적 중인 파일을 .gitignore에 맞춰 정리하려면 한 번만 아래 줄의 :: 를 지우고 실행
:: git rm -r --cached . >nul

git add -A
echo.
echo --- 올라갈 변경 내용 (R=이름 변경, D=삭제, A=추가, M=수정) ---
git status --short
echo.
set "msg="
set /p msg="커밋 메시지 (비우면 취소): "
if not defined msg ( echo 취소했습니다. & pause & exit /b 1 )

git commit -m "%msg%"
git pull --rebase origin main || ( echo [중단] pull 실패: 충돌이나 원격 변경을 확인하세요. & pause & exit /b 1 )
git push -u origin main || ( echo [실패] push가 거절되었습니다. & pause & exit /b 1 )
echo === 업로드 완료 ===
pause