param(
    [Parameter(Mandatory = $true)]
    [string]$ClientId
)

$ErrorActionPreference = "Stop"
if ($ClientId -notmatch '^[0-9A-Za-z._-]+\.apps\.googleusercontent\.com$') {
    throw "Geçersiz Client ID. Değer .apps.googleusercontent.com ile bitmeli."
}

$manifest = Join-Path $PSScriptRoot "..\extension\manifest.json"
$json = Get-Content $manifest -Raw | ConvertFrom-Json
$json.oauth2.client_id = $ClientId
$content = $json | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($manifest, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "OAuth Client ID ayarlandı. Şimdi chrome://extensions içinden eklentiyi yeniden yükle."
