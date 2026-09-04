$ErrorActionPreference = "Stop"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "Node.js 22+ bulunamadı. https://nodejs.org üzerinden LTS sürümünü kur."
}
Push-Location $PSScriptRoot
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "Bağımlılıklar kurulamadı." }
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "Electron build başarısız oldu." }
} finally {
    Pop-Location
}
Write-Host "Hazır: $(Join-Path $PSScriptRoot 'dist\TuneCord.exe')"
