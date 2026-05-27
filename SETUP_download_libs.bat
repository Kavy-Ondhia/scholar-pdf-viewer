@echo off
echo ============================================
echo  Scholar PDF - Library Downloader
echo ============================================
echo.

mkdir lib 2>nul

set URL1=https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
set URL2=https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
set URL3=https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js

echo Trying PowerShell download (most reliable)...
echo.

echo [1/3] pdf.js...
powershell -Command "Invoke-WebRequest '%URL1%' -OutFile 'lib\pdf.min.js'" 2>nul
if exist "lib\pdf.min.js" (echo    OK) else (echo    FAILED)

echo [2/3] pdf.worker.js...
powershell -Command "Invoke-WebRequest '%URL2%' -OutFile 'lib\pdf.worker.min.js'" 2>nul
if exist "lib\pdf.worker.min.js" (echo    OK) else (echo    FAILED)

echo [3/3] pdf-lib.js...
powershell -Command "Invoke-WebRequest '%URL3%' -OutFile 'lib\pdf-lib.min.js'" 2>nul
if exist "lib\pdf-lib.min.js" (echo    OK) else (echo    FAILED)

echo.

:: Check all 3 exist and are not empty
set FAIL=0
if not exist "lib\pdf.min.js" set FAIL=1
if not exist "lib\pdf.worker.min.js" set FAIL=1
if not exist "lib\pdf-lib.min.js" set FAIL=1

if "%FAIL%"=="1" (
  echo SOME FILES FAILED. Trying curl fallback...
  curl -L "%URL1%" -o "lib\pdf.min.js"
  curl -L "%URL2%" -o "lib\pdf.worker.min.js"
  curl -L "%URL3%" -o "lib\pdf-lib.min.js"
)

echo.
echo Files in lib\ folder:
dir lib\ /b
echo.

if exist "lib\pdf.min.js" if exist "lib\pdf.worker.min.js" if exist "lib\pdf-lib.min.js" (
  echo SUCCESS! All 3 library files are ready.
  echo.
  echo NEXT STEPS:
  echo  1. Go to brave://extensions
  echo  2. Enable Developer Mode (top right)
  echo  3. Click Load Unpacked
  echo  4. Select THIS folder: %CD%
  echo  5. Click Details on Scholar, enable Allow access to file URLs
  echo.
) else (
  echo.
  echo DOWNLOAD FAILED. Please download manually:
  echo.
  echo Open each URL in Brave and Save As into the lib\ folder:
  echo  lib\pdf.min.js       ^<-- %URL1%
  echo  lib\pdf.worker.min.js ^<-- %URL2%
  echo  lib\pdf-lib.min.js   ^<-- %URL3%
  echo.
)
pause
