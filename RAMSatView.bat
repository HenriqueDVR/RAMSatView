@echo off
rem ---------------------------------------------------------------------------
rem  RAMSatView - run the site on this machine.
rem
rem  Serves the built static site on a local port and opens it in the default
rem  browser. Everything the map needs is in web\out, so this works with no
rem  internet at all once the forecast has been fetched once - which is the
rem  point: there is no signal at the summits.
rem
rem  Usage:
rem    RAMSatView.bat          serve what is there, fetching data only if absent
rem    RAMSatView.bat fresh    fetch the current forecast first, then serve
rem ---------------------------------------------------------------------------
setlocal
set "PORT=8787"
set "ROOT=%~dp0web\out"

where python >nul 2>&1
if errorlevel 1 (
  echo Python is not on PATH. Install it, or run: npm --prefix web run start
  pause
  exit /b 1
)

if not exist "%ROOT%\index.html" (
  echo.
  echo The site has not been built yet. Build it once with:
  echo.
  echo     npm --prefix web install
  echo     npm --prefix web run build
  echo.
  pause
  exit /b 1
)

rem The data is written straight into the served directory rather than into
rem web\public, so refreshing the forecast never means rebuilding the site.
if /i "%~1"=="fresh" goto fetch
if not exist "%ROOT%\conditions.json" goto fetch
goto serve

:fetch
echo Fetching the current forecast...
python -m ingest.build --out "%ROOT%\conditions.json"
if errorlevel 1 (
  echo.
  echo The forecast could not be fetched. Serving whatever is already here.
  echo.
)

:serve
echo.
echo   RAMSatView is running at http://localhost:%PORT%/en/
echo   Close this window to stop it.
echo.
rem Opened from a second process after a short pause: the browser has to arrive
rem *after* the server is listening, and the server below never returns.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%/en/'"
python "%~dp0scripts\serve_site.py" --directory "%ROOT%" --port %PORT%
