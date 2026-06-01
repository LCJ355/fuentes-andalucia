$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "Aplicando correcciones a la base de datos..." -ForegroundColor Cyan
try {
    python _apply_edits.py
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`nCORRECCIONES APLICADAS. Los datos estan actualizados." -ForegroundColor Green
        Write-Host "Puedes recargar la app (F5) para ver los cambios." -ForegroundColor Green
    } else {
        throw "Error en _apply_edits.py"
    }
} catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Revisa que tengas Python y pyodbc instalados:" -ForegroundColor Yellow
    Write-Host "  pip install pyodbc" -ForegroundColor Yellow
}
Read-Host "`nPresiona Enter para salir"
