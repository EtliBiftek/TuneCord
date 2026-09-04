$ErrorActionPreference = "Stop"
$source = Join-Path $PSScriptRoot "app\TuneCord.exe"
if (-not (Test-Path $source)) {
    $source = Join-Path $PSScriptRoot "dist\TuneCord.exe"
}
if (-not (Test-Path $source)) {
    throw "TuneCord.exe bulunamadı. Önce Release build al veya GitHub Actions paketini indir."
}

$targetDir = Join-Path $env:LOCALAPPDATA "Programs\TuneCord"
$target = Join-Path $targetDir "TuneCord.exe"
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Get-Process TuneCord -ErrorAction SilentlyContinue | Stop-Process -Force
Copy-Item $source $target -Force
Start-Process $target

Write-Host "TuneCord kuruldu ve açıldı."
Write-Host "Eklenti klasörü: $(Join-Path $PSScriptRoot 'extension')"
Write-Host "Chromium'da chrome://extensions açıp Paketlenmemiş öğe yükle ile bu klasörü seç."
