@echo off
setlocal EnableExtensions
title Family Fund Manager Launcher
chcp 65001 >nul

:: Switch to script directory
:: 1. If already on a mapped or local drive letter, use it directly
if not "%~d0"=="\\" (
    cd /d "%~dp0"
    goto DIR_READY
)

:: 2. If run via UNC network share (e.g. \\SynologyNAS\code\...), resolve to permanent mapped drive
for %%D in (X W Y Z V U T S R Q P O N M L K J I H G F E D C) do (
    if exist "%%D:\family-fund-manager\package.json" (
        cd /d "%%D:\family-fund-manager"
        goto DIR_READY
    )
)

:: 3. Fallback: allocate temporary virtual drive only if no mapped drive exists
pushd "%~dp0"

:DIR_READY

echo ==================================================
echo         Family Fund Manager Launcher
echo ==================================================
echo.

:: 1. Check Node.js environment
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

:: 2. Check project files & dependencies
if not exist "package.json" goto NO_PACKAGE
if not exist "node_modules" goto INSTALL_DEPS

:RUN
:: 3. Tie the server lifetime to this console; open browser after listening.
echo [System] Starting server. Close this window or press Ctrl+C to stop.
echo.
node scripts\launch.js --open-browser
if errorlevel 1 goto EXIT_WITH_PAUSE
goto CLEANUP

:INSTALL_DEPS
echo ⏳ [System] Dependencies not found. Installing, please wait...
echo.
call npm install
if errorlevel 1 goto INSTALL_FAIL
echo.
echo ✅ [System] Dependencies installed successfully.
echo.
goto RUN

:NO_NODE
echo ==================================================
echo ❌ [ERROR] Node.js is not installed!
echo Please download and install Node.js from https://nodejs.org/
echo ==================================================
goto EXIT_WITH_PAUSE

:NO_PACKAGE
echo ==================================================
echo ❌ [ERROR] package.json not found!
echo Please make sure start.bat is in the project root directory.
echo ==================================================
goto EXIT_WITH_PAUSE

:INSTALL_FAIL
echo.
echo ==================================================
echo ❌ [ERROR] Failed to install dependencies. Please check network.
echo ==================================================
goto EXIT_WITH_PAUSE

:EXIT_WITH_PAUSE
echo.
pause

:CLEANUP
if "%~d0"=="\\" popd 2>nul
exit /b
