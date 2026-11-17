@echo off
cd /d "%~dp0"
if not exist "Solstice-LAN.exe" (
    echo Solstice-LAN.exe is missing. Keep it in the game folder next to Start-LAN.bat.
    pause
    exit /b 1
)
"%~dp0Solstice-LAN.exe" --open %*
if errorlevel 1 pause
