@echo off
setlocal EnableExtensions

rem Fridge9000 full validation runner.
rem Place this file in the repository root.

pushd "%~dp0" >nul

set "FAILED=0"
set "TEST_PROJECT=fridge9000-test"
set "TEST_COMPOSE=docker-compose.test.yml"

echo.
echo ============================================================
echo  Fridge9000 - Full Test Suite
echo ============================================================
echo.

echo [1/9] Starting isolated test database...
docker compose -f "%TEST_COMPOSE%" -p "%TEST_PROJECT%" up -d --wait
if errorlevel 1 (
    echo [FAIL] Could not start the test environment.
    set "FAILED=1"
) else (
    echo [PASS] Test environment started.
)

echo.
echo [2/9] Running backend pytest suite...
pytest
if errorlevel 1 (
    echo [FAIL] Backend pytest suite failed.
    set "FAILED=1"
) else (
    echo [PASS] Backend pytest suite passed.
)

echo.
echo [3/9] Running training-provider tests...
pytest backend/test_training_providers.py -v
if errorlevel 1 (
    echo [FAIL] Training-provider tests failed.
    set "FAILED=1"
) else (
    echo [PASS] Training-provider tests passed.
)

echo.
echo [4/9] Running Kaggle worker tests...
pytest kaggle_trainer/test_train.py -v
if errorlevel 1 (
    echo [FAIL] Kaggle worker tests failed.
    set "FAILED=1"
) else (
    echo [PASS] Kaggle worker tests passed.
)

echo.
echo [5/9] Stopping isolated test database...
docker compose -f "%TEST_COMPOSE%" -p "%TEST_PROJECT%" down
if errorlevel 1 (
    echo [FAIL] Could not cleanly stop the test environment.
    set "FAILED=1"
) else (
    echo [PASS] Test environment stopped.
)

echo.
echo [6/9] Running TypeScript checks...
pushd "mobile" >nul
call npx tsc --noEmit
if errorlevel 1 (
    echo [FAIL] TypeScript checks failed.
    set "FAILED=1"
) else (
    echo [PASS] TypeScript checks passed.
)

echo.
echo [7/9] Running mobile lint...
call npm run lint
if errorlevel 1 (
    echo [FAIL] Mobile lint failed.
    set "FAILED=1"
) else (
    echo [PASS] Mobile lint passed.
)

echo.
echo [8/9] Running Expo Doctor...
call npx expo-doctor
if errorlevel 1 (
    echo [FAIL] Expo Doctor failed.
    set "FAILED=1"
) else (
    echo [PASS] Expo Doctor passed.
)
popd >nul

echo.
echo [9/9] Checking Git diff whitespace/errors...
git diff --check
if errorlevel 1 (
    echo [FAIL] git diff --check failed.
    set "FAILED=1"
) else (
    echo [PASS] git diff --check passed.
)

echo.
echo ============================================================
if "%FAILED%"=="0" (
    echo  ALL CHECKS PASSED
    echo ============================================================
    popd >nul
    exit /b 0
) else (
    echo  ONE OR MORE CHECKS FAILED
    echo ============================================================
    popd >nul
    exit /b 1
)
