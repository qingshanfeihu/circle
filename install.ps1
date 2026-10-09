# PowerShell 5.1+. All preferences stay inside this script block.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    $repo = if ($env:CIRCLE_REPO) { $env:CIRCLE_REPO } else { 'qingshanfeihu/circle' }
    if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($architecture) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw "Unsupported architecture: $architecture" } }
    $web = @{ UseBasicParsing = $true }
    if ($env:HTTPS_PROXY) { $web.Proxy = $env:HTTPS_PROXY }
    $version = $env:CIRCLE_VERSION
    if (-not $version) {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" @web
        $version = $release.tag_name
    }
    $version = $version -replace '^v', ''
    if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') { throw 'Invalid semantic version' }
    $asset = "circle-$version-windows-$arch.zip"
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        $archive = Join-Path $temporary $asset
        if ($env:CIRCLE_ASSET_DIR) {
            Copy-Item -LiteralPath (Join-Path $env:CIRCLE_ASSET_DIR $asset) -Destination $archive
            Copy-Item -LiteralPath (Join-Path $env:CIRCLE_ASSET_DIR "$asset.sha256") -Destination "$archive.sha256"
        } else {
            $base = "https://github.com/$repo/releases/download/v$version"
            Write-Host "[circle-install] downloading $asset"
            Invoke-WebRequest -Uri "$base/$asset" -OutFile $archive @web
            Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile "$archive.sha256" @web
        }
        Write-Host '[circle-install] verifying the download'
        $receipt = (Get-Content -LiteralPath "$archive.sha256" -Raw).Trim()
        if ($receipt -notmatch ('^([0-9a-fA-F]{64})\s+' + [regex]::Escape($asset) + '$')) { throw 'Invalid checksum receipt' }
        $expected = $Matches[1]
        $stream = [IO.File]::OpenRead($archive)
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
        finally { $stream.Dispose(); $hasher.Dispose() }
        if ($actual -ne $expected) { throw 'Archive checksum mismatch' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            foreach ($entry in $zip.Entries) {
                $name = $entry.FullName.Replace('\', '/')
                if ($name -notmatch '^circle(?:/|$)' -or $name -match '(^|/)\.\.(/|$)' -or $name.Contains(':')) { throw 'Unsafe archive entry' }
                $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
                if ($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) { throw 'Archive links and special files are not allowed' }
            }
        } finally { $zip.Dispose() }
        Write-Host '[circle-install] unpacking'
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $temporary)
        $root = Join-Path $temporary 'circle'
        $node = Join-Path $root 'runtime\node.exe'
        $manager = Join-Path $root 'app\dist\install_manager.js'
        if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $manager -PathType Leaf)) { throw 'Incomplete release' }
        $manifest = Get-Content -LiteralPath (Join-Path $root 'release.json') -Raw | ConvertFrom-Json
        if ($manifest.version -ne $version) { throw 'Release version mismatch' }
        # Installs into CIRCLE_PREFIX and CIRCLE_BIN_DIR when they are set, otherwise where the
        # Python circle was installed, otherwise %LOCALAPPDATA%\circle. Removes the Python circle.
        $resultFile = Join-Path $temporary 'result.json'
        $savedRepo = $env:CIRCLE_REPO
        $env:CIRCLE_REPO = $repo
        $env:CIRCLE_INSTALL_RESULT = $resultFile
        try { & $node $manager $root }
        finally {
            $env:CIRCLE_REPO = $savedRepo
            Remove-Item Env:CIRCLE_INSTALL_RESULT -ErrorAction SilentlyContinue
        }
        if ($LASTEXITCODE -ne 0) { throw 'Release installation failed' }
        $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        $binDir = $result.binDir
        # The Python installer put <prefix>\current\circle on the user PATH.
        $stale = @($result.removedPrefixes | ForEach-Object { (Join-Path $_ 'current\circle').TrimEnd('\') })
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            $entries = @($raw -split ';' | Where-Object { $_ -and ($stale -notcontains [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\')) })
            if ($env:CIRCLE_NO_PATH -ne '1' -and $entries -notcontains $binDir) { $entries += $binDir }
            $value = $entries -join ';'
            $changed = $value -ne $raw
            if ($changed) { $key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
        } finally { $key.Close() }
        # Setting a user variable tells running programs that the environment changed, so new
        # terminals see the new PATH.
        if ($changed) { [Environment]::SetEnvironmentVariable('CIRCLE_PATH_TOUCH', $null, 'User') }
        $env:Path = (@($env:Path -split ';' | Where-Object { $_ -and ($stale -notcontains $_.TrimEnd('\')) }) -join ';')
        if ($env:CIRCLE_NO_PATH -ne '1') { $env:Path = "$binDir;$env:Path" }
        Write-Host "[circle-install] Run circle, or $binDir\circle.cmd."
    } finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}
