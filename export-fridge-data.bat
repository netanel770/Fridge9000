@echo off
setlocal

cd /d "%~dp0"

echo.
echo ========================================
echo   Fridge9000 Data Export
echo ========================================
echo.
echo This will back up:
echo - PostgreSQL database
echo - uploads
echo - trained candidate models
echo - dataset exports
echo - model comparisons
echo - base dataset
echo - remote training job data
echo - .env
echo.
echo The backend will be stopped during export.
echo.

pause

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\fridge-data.ps1" ^
  -Mode Export

set "EXIT_CODE=%ERRORLEVEL%"

echo.

if not "%EXIT_CODE%"=="0" (
    echo ========================================
    echo   EXPORT FAILED
    echo ========================================
    echo.
    echo Exit code: %EXIT_CODE%
    echo.
    pause
    exit /b %EXIT_CODE%
)

echo ========================================
echo   EXPORT COMPLETE
echo ========================================
echo.
echo The backup ZIP should be in the parent
echo directory of this repository.
echo.
echo Copy that ZIP to your laptop.
echo.

pause
exit /b 0