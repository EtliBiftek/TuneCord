$ErrorActionPreference = "Stop"
Get-Process TuneCord -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "TuneCord" -ErrorAction SilentlyContinue
$targetDir = Join-Path $env:LOCALAPPDATA "Programs\TuneCord"
if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
Write-Host "TuneCord uygulaması kaldırıldı. Ayarlar %LOCALAPPDATA%\TuneCord içinde bırakıldı."
