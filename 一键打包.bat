@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Family Fund Manager Release Packager

set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"

rem pushd supports UNC shares by assigning a temporary drive letter.
pushd "%~dp0"
if errorlevel 1 (
    echo [ERROR] Could not access the project directory "%~dp0".
    if not defined NO_PAUSE pause
    exit /b 1
)

echo ==================================================
echo       Family Fund Manager Release Packager
echo ==================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git was not found. Please install Git or add it to PATH.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Windows PowerShell was not found.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found. It is required to read and validate the release version.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

if not exist "package.json" (
    echo [ERROR] package.json was not found in "%CD%".
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

for /f "usebackq delims=" %%I in (`node -p "require('./package.json').name"`) do set "PROJECT_NAME=%%I"
for /f "usebackq delims=" %%I in (`node -p "require('./package.json').version"`) do set "VERSION=%%I"

if not defined PROJECT_NAME (
    echo [ERROR] package.json does not contain a valid project name.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

if not defined VERSION (
    echo [ERROR] package.json does not contain a valid version.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

node -e "const v=require('./package.json').version; if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v)) process.exit(1)"
if errorlevel 1 (
    echo [ERROR] Invalid release version "%VERSION%". Expected semantic version format such as 3.12.1.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

echo Validating version references...
node test\test-version.js
if errorlevel 1 (
    echo [ERROR] Version references are inconsistent. Update package files, the page badges, and CHANGELOG.md first.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

git diff --quiet HEAD --
if errorlevel 1 (
    echo [WARNING] Tracked files contain uncommitted changes.
    echo           The package will use the current working copy.
    echo.
)

if not exist "node_modules" (
    echo [ERROR] node_modules was not found. Run npm install before creating the offline release package.
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

set "TAG=v%VERSION%"
set "ARCHIVE_NAME=%PROJECT_NAME%_v%VERSION%.zip"
set "ARCHIVE=%CD%\%ARCHIVE_NAME%"
set "RELEASE_URL=https://github.com/kamen-exaid/family-fund-manager/releases/download/%TAG%/%ARCHIVE_NAME%"
set "FILE_LIST=%TEMP%\fund_account_package_%RANDOM%_%RANDOM%.txt"

echo Collecting tracked project files and node_modules...
git -c core.quotepath=false ls-files -z > "%FILE_LIST%"
if errorlevel 1 (
    echo [ERROR] Failed to collect the file list.
    del /q "%FILE_LIST%" >nul 2>nul
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

for %%I in ("%FILE_LIST%") do if %%~zI==0 (
    echo [ERROR] No files were found to package.
    del /q "%FILE_LIST%" >nul 2>nul
    if not defined NO_PAUSE pause
    popd
    exit /b 1
)

echo Creating "%ARCHIVE%"...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$bytes = [IO.File]::ReadAllBytes($env:FILE_LIST);" ^
    "$files = [Text.Encoding]::UTF8.GetString($bytes).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries);" ^
    "$root = (Resolve-Path -LiteralPath '.').Path.TrimEnd('\') + '\';" ^
    "if (Test-Path -LiteralPath 'node_modules' -PathType Container) { $files += Get-ChildItem -LiteralPath 'node_modules' -File -Recurse | ForEach-Object { $_.FullName.Substring($root.Length) } }" ^
    "Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "if ([IO.File]::Exists($env:ARCHIVE)) { [IO.File]::Delete($env:ARCHIVE) }" ^
    "$zip = [IO.Compression.ZipFile]::Open($env:ARCHIVE, [IO.Compression.ZipArchiveMode]::Create);" ^
    "try { foreach ($file in $files) { if (![string]::IsNullOrWhiteSpace($file) -and (Test-Path -LiteralPath $file -PathType Leaf)) { $source = (Resolve-Path -LiteralPath $file).Path; $entry = $file.Replace('\', '/'); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null } } } finally { $zip.Dispose() }"
set "RESULT=%ERRORLEVEL%"
del /q "%FILE_LIST%" >nul 2>nul

if not "%RESULT%"=="0" (
    del /q "%ARCHIVE%" >nul 2>nul
    echo [ERROR] Packaging failed. A tracked file may be missing.
    if not defined NO_PAUSE pause
    popd
    exit /b %RESULT%
)

echo.
echo Release package created successfully.
echo Tag: %TAG%
echo File: "%ARCHIVE%"
for %%I in ("%ARCHIVE%") do echo Size: %%~zI bytes
echo.
echo GitHub Release Markdown:
echo [**%PROJECT_NAME%\_v%VERSION%.zip**](%RELEASE_URL%)
if not defined NO_PAUSE pause
popd
exit /b 0
