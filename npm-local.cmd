@echo off
setlocal
cd /d "%~dp0"
set "RUNTIME=%~dp0..\LabChain\.tools\node"
if exist "%RUNTIME%\npm.cmd" set "PATH=%RUNTIME%;%PATH%"
where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo Cai Node.js 24 LTS va mo lai Terminal, sau do chay lai lenh nay.
    exit /b 1
)
call npm.cmd %*
exit /b %errorlevel%
