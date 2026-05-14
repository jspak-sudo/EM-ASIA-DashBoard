@echo off
cd /d "%~dp0"
start "" /min cmd /c "npm run dev >nul 2>&1"
start "" "dashboard.html"
