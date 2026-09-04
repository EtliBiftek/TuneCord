$ErrorActionPreference = "Stop"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "Visual Studio 2022 bulunamadı. 'Desktop development with C++' bileşenini kur veya GitHub Actions build'ini kullan."
}
$msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
if (-not $msbuild) { throw "MSBuild bulunamadı." }
& $msbuild (Join-Path $PSScriptRoot "TuneCord.sln") /m /p:Configuration=Release /p:Platform=x64
if ($LASTEXITCODE -ne 0) { throw "Build başarısız oldu." }
Write-Host "Hazır: $(Join-Path $PSScriptRoot 'dist\TuneCord.exe')"
