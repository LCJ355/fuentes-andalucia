$accdb = Join-Path $PSScriptRoot "FUENTES_Andalucia.accdb"
$jsonPath = Join-Path $PSScriptRoot "fuentes_complete.json"
$json = Get-Content $jsonPath -Encoding UTF8 | ConvertFrom-Json

$acc = New-Object -ComObject Access.Application
$acc.OpenCurrentDatabase($accdb)

$updated = 0
foreach ($d in $json) {
    if ($null -eq $d.pedania -and $d.pedania -eq $null) {
        continue
    }
    if ([string]::IsNullOrEmpty($d.pedania)) {
        continue
    }
    if ([string]::IsNullOrEmpty($d.municipio)) {
        continue
    }
    if ($d.pedania.Trim().ToLower() -eq $d.municipio.Trim().ToLower()) {
        $sql = "UPDATE Fuentes SET pedania = NULL WHERE id_fuente = $($d.id_fuente)"
        $acc.CurrentDb().Execute($sql)
        $updated++
    }
}

$acc.CloseCurrentDatabase()
$acc.Quit()

Write-Host "Updated $updated records in Access DB"
