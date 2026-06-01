@echo off
cd /d "%~dp0"
:: Abre la app en el navegador
start "" "index.html"
:: Inicia el watcher automatico en una ventana separada
start "Watcher" cmd /c "powershell -ExecutionPolicy Bypass -File "%~dp0_auto_aplicar.ps1""
exit
