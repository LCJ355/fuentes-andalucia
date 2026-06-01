@echo off
cd /d "%~dp0"
echo Aplicando correcciones a la base de datos...
python _apply_edits.py
if %errorlevel%==0 (
    echo.
    echo CORRECCIONES APLICADAS. Los datos estan actualizados.
    echo Puedes recargar la app (F5) para ver los cambios.
) else (
    echo.
    echo ERROR: Revisa que tengas Python y pyodbc instalados.
    echo   pip install pyodbc
)
pause
