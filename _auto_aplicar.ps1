$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       MODO AUTOMATICO ACTIVADO              ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║ 1. Edita fuentes en la app web              ║" -ForegroundColor Yellow
Write-Host "║ 2. Pulsa el boton 📥 en la app              ║" -ForegroundColor Yellow
Write-Host "║ 3. Las correcciones se aplican solas        ║" -ForegroundColor Yellow
Write-Host "║ 4. Recarga la app (F5) para ver los cambios ║" -ForegroundColor Yellow
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $scriptDir
$watcher.Filter = "correcciones.json"
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents = $true

$action = {
    $path = $Event.SourceEventArgs.FullPath
    $dir = Split-Path -Parent $path
    $lock = Join-Path $dir "_aplicando.json"

    Start-Sleep -Seconds 1.5

    # Rename to prevent race conditions with multiple exports
    try {
        Rename-Item -LiteralPath $path -NewName "_aplicando.json" -Force -ErrorAction Stop
    } catch {
        return # file already being processed or gone
    }

    Write-Host "[$(Get-Date -Format HH:mm:ss)] Correcciones detectadas. Aplicando..." -ForegroundColor Green
    try {
        python "$dir\_apply_edits.py" "$lock"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "[$(Get-Date -Format HH:mm:ss)] CORRECCIONES APLICADAS. Recarga la app (F5)." -ForegroundColor Green
        } else {
            Write-Host "[$(Get-Date -Format HH:mm:ss)] ERROR al aplicar correcciones" -ForegroundColor Red
        }
    } catch {
        Write-Host "[$(Get-Date -Format HH:mm:ss)] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    Remove-Item -LiteralPath $lock -Force -ErrorAction SilentlyContinue
}

Register-ObjectEvent $watcher "Created" -Action $action | Out-Null
Register-ObjectEvent $watcher "Changed" -Action $action | Out-Null

Write-Host "Esperando correcciones..." -ForegroundColor Gray
while ($true) { Start-Sleep -Seconds 3 }
