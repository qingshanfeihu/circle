param(
    [string]$Version = $env:CIRCLE_VERSION,
    [string]$Repository = "qingshanfeihu/circle",
    [string]$Prefix = "$env:LOCALAPPDATA\Programs\Circle",
    [string]$BinDirectory = "$env:LOCALAPPDATA\Programs\Circle\bin"
)
$ErrorActionPreference = "Stop"
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$arch = switch ($architecture) { "X64" { "x86_64" } "Arm64" { "arm64" } default { throw "Unsupported architecture: $architecture" } }
if (-not $Version) {
    $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repository/releases/latest").tag_name
}
$Version = $Version.TrimStart('v')
$asset = "circle-windows-$arch.tar.gz"
$url = "https://github.com/$Repository/releases/download/v$Version/$asset"
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory $temporary | Out-Null
try {
    $download = Join-Path $temporary $asset
    Invoke-WebRequest $url -OutFile $download
    $expected = ((Invoke-WebRequest "$url.sha256").Content -split '\s+')[0]
    if ((Get-FileHash $download -Algorithm SHA256).Hash.ToLower() -ne $expected.ToLower()) {
        throw "Release checksum mismatch"
    }
    $generation = Join-Path $Prefix ("versions\$Version-$arch-" + [System.Guid]::NewGuid())
    New-Item -ItemType Directory -Force $generation | Out-Null
    tar -xzf $download -C $generation
    if ($LASTEXITCODE -ne 0) { throw "Release extraction failed" }
    $launcher = Join-Path $generation "circle\circle.cmd"
    & $launcher --version
    if ($LASTEXITCODE -ne 0) { throw "Release smoke failed; previous install remains active" }
    New-Item -ItemType Directory -Force $BinDirectory | Out-Null
    $target = Join-Path $BinDirectory "circle.cmd"
    $next = "$target.new"
    [System.IO.File]::WriteAllText($next, "@echo off`r`ncall `"$launcher`" %*`r`n")
    if (Test-Path $target) {
        [System.IO.File]::Replace($next, $target, "$target.previous")
    } else {
        [System.IO.File]::Move($next, $target)
    }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (($userPath -split ';') -notcontains $BinDirectory) {
        [Environment]::SetEnvironmentVariable("Path", "$BinDirectory;$userPath", "User")
    }
    Write-Output "Circle installed. Open a new terminal and run circle."
} finally {
    Remove-Item -Recurse -Force $temporary
}
