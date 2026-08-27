@echo off
setlocal

cd /d "%~dp0"

echo.
echo ========================================
echo   Fridge9000 Data Import
echo ========================================
echo.

if "%~1"=="" (
    echo No backup ZIP was provided.
    echo.
    echo Drag a fridge9000-backup-*.zip file
    echo onto this BAT file.
    echo.
    echo Or run:
    echo.
    echo   import-fridge-data.bat "C:\path\to\backup.zip"
    echo.
    pause
    exit /b 1
)

set "BACKUP_FILE=%~1"

if not exist "%BACKUP_FILE%" (
    echo ERROR: Backup file does not exist:
    echo.
    echo %BACKUP_FILE%
    echo.
    pause
    exit /b 1
)

echo Backup:
echo %BACKUP_FILE%
echo.
echo WARNING:
echo.
echo This will replace the Fridge9000
echo development database and runtime data
echo on THIS computer.
echo.
echo It will restore:
echo - inventory
echo - annotations
echo - scans
echo - model lifecycle history
echo - active / archived models
echo - trained model files
echo - uploads
echo - datasets
echo - comparison artifacts
echo.
echo Existing laptop Fridge data may be overwritten.
echo.

set /p "CONFIRM=Type IMPORT to continue: "

if /I not "%CONFIRM%"=="IMPORT" (
    echo.
    echo Import cancelled.
    echo.
    pause
    exit /b 0
)

echo.
echo Starting import...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\fridge-data.ps1" ^
  -Mode Import ^
  -Archive "%BACKUP_FILE%" ^
  -ConfirmImport

set "EXIT_CODE=%ERRORLEVEL%"

echo.

if not "%EXIT_CODE%"=="0" (
    echo ========================================
    echo   IMPORT FAILED
    echo ========================================
    echo.
    echo Exit code: %EXIT_CODE%
    echo.
    pause
    exit /b %EXIT_CODE%
)

echo ========================================
echo   IMPORT COMPLETE
echo ========================================
echo.
echo Fridge9000 should now contain the
echo transferred data.
echo.
echo Check:
echo - Inventory
echo - Teach Fridge
echo - AI Progress
echo - active model
echo - archived models
echo.

pause
exit /b 0