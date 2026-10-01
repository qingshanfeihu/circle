# Circle installer for Windows (PowerShell 5.1 or newer).
#
#   irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
#
# Downloads the Windows build from GitHub Releases, checks its sha256, unpacks it to
#   %LOCALAPPDATA%\circle\versions\<version>
# points the junction  %LOCALAPPDATA%\circle\current  at it and adds
#   %LOCALAPPDATA%\circle\current\circle
# to your user PATH. `circle update` uses the same layout.
#
# Environment variables:
#   CIRCLE_REPO     default qingshanfeihu/circle
#   CIRCLE_VERSION  pin a version (1.0.0 or v1.0.0); default is the newest release
#   CIRCLE_PREFIX   install root, default %LOCALAPPDATA%\circle
#   CIRCLE_NO_PATH  set to 1 to leave PATH alone (you add the folder yourself)
#   HTTPS_PROXY     a proxy for the downloads (Windows PowerShell 5.1 ignores it otherwise)

# Everything runs in a script block of its own, so the preferences set below do not stay set in
# the PowerShell window that ran `irm | iex`.
& {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # progress bars make Invoke-WebRequest very slow

    function Log($message) { Write-Host "[circle-install] $message" }

    # `throw`, not `exit`: under `irm | iex` an exit would close the user's terminal window.
    function Stop-Install($message) { throw "[circle-install] error: $message" }

    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

    $repo = if ($env:CIRCLE_REPO) { $env:CIRCLE_REPO } else { 'qingshanfeihu/circle' }
    $prefix = if ($env:CIRCLE_PREFIX) { $env:CIRCLE_PREFIX } else { Join-Path $env:LOCALAPPDATA 'circle' }
    $web = @{ UseBasicParsing = $true }
    if ($env:HTTPS_PROXY) { $web.Proxy = $env:HTTPS_PROXY }

    # Circle ships an x86_64 build. Windows on ARM runs it under emulation. A 32-bit PowerShell on a
    # 64-bit Windows reports x86 here and the real architecture in PROCESSOR_ARCHITEW6432.
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64' -and $arch -ne 'ARM64') { Stop-Install "unsupported processor: $arch" }
    $asset = 'circle-windows-x86_64.zip'

    function Show-Failure($url, $err) {
        $status = $null
        try { $status = [int]$err.Exception.Response.StatusCode } catch { }
        Write-Host "[circle-install] request failed: $url" -ForegroundColor Yellow
        if ($status -eq 404) {
            Write-Host "[circle-install] the release has no file for this system. See https://github.com/$repo/releases" -ForegroundColor Yellow
        } else {
            Write-Host "[circle-install] $($err.Exception.Message)" -ForegroundColor Yellow
            Write-Host "[circle-install] behind a proxy: set `$env:HTTPS_PROXY. If HTTPS is inspected, import its root certificate into the Windows certificate store." -ForegroundColor Yellow
        }
    }

    function Get-LatestVersion {
        $url = "https://github.com/$repo/releases/latest"
        try {
            $response = Invoke-WebRequest -Uri $url -Method Head @web
        } catch {
            Show-Failure $url $_
            Stop-Install "cannot find the newest release of $repo"
        }
        # Windows PowerShell 5.1 and PowerShell 7 keep the final address in different places.
        $final = $null
        if ($response.BaseResponse.ResponseUri) { $final = $response.BaseResponse.ResponseUri.AbsoluteUri }
        elseif ($response.BaseResponse.RequestMessage) { $final = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
        $tag = [regex]::Match([string]$final, '/releases/tag/v?([^/?#]+)/?$')
        if (-not $tag.Success) { Stop-Install "$repo has not published a release yet" }
        return $tag.Groups[1].Value
    }

    function Get-File($url, $dest) {
        try { Invoke-WebRequest -Uri $url -OutFile $dest @web }
        catch { Show-Failure $url $_; Stop-Install "download failed" }
    }

    # Add a folder to the user PATH without disturbing what is there. The registry value is read
    # as it is stored, %VARIABLES% unexpanded, and written back as an expandable string; going
    # through [Environment]::GetEnvironmentVariable would replace every %VARIABLE% by its value.
    function Add-ToUserPath($dir) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        try {
            $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if (($raw -split ';') -contains $dir) { return $false }
            $new = if ($raw) { "$raw;$dir" } else { $dir }
            $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        } finally { $key.Close() }
        # Deleting a variable that does not exist still broadcasts "the environment changed", which
        # is what makes new terminals see the new PATH without logging out.
        [Environment]::SetEnvironmentVariable('CIRCLE_PATH_TOUCH', $null, 'User')
        return $true
    }

    $version = if ($env:CIRCLE_VERSION) { $env:CIRCLE_VERSION -replace '^v', '' } else { Get-LatestVersion }
    $base = "https://github.com/$repo/releases/download/v$version"
    $versions = Join-Path $prefix 'versions'
    $dest = Join-Path $versions $version
    $current = Join-Path $prefix 'current'
    New-Item -ItemType Directory -Force -Path $versions | Out-Null
    Get-ChildItem -Path $versions -Directory -Filter '*.partial' | ForEach-Object {
        try { Remove-Item -Recurse -Force $_.FullName } catch { }
    }

    if (Test-Path (Join-Path $dest 'circle\circle.exe')) {
        # Already installed, and possibly the copy that is running: leave it alone.
        Log "version $version is already in $dest; not downloading it again (delete that folder to reinstall)"
    } else {
        $scratch = Join-Path ([IO.Path]::GetTempPath()) ("circle-install-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $scratch | Out-Null
        try {
            Log "downloading $base/$asset"
            Get-File "$base/$asset.sha256" (Join-Path $scratch 'expected.sha256')
            $expected = ((Get-Content (Join-Path $scratch 'expected.sha256') -TotalCount 1) -split '\s+')[0]
            if ($expected -notmatch '^[0-9a-fA-F]{64}$') { Stop-Install "$asset.sha256 does not hold a sha256" }
            $archive = Join-Path $scratch $asset
            Get-File "$base/$asset" $archive
            $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash
            if ($actual -ne $expected) { Stop-Install "sha256 mismatch (expected $expected, got $actual) - nothing was installed" }
            Log 'sha256 ok'

            $partial = "$dest.partial"
            if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }   # what an interrupted install left
            Expand-Archive -Path $archive -DestinationPath $partial
            if (-not (Test-Path (Join-Path $partial 'circle\circle.exe'))) {
                Remove-Item -Recurse -Force $partial
                Stop-Install "$asset does not hold circle\circle.exe"
            }
            Move-Item -Path $partial -Destination $dest
        } finally {
            Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
        }
    }

    # `current` is a junction. Delete it with .NET: Remove-Item -Recurse on a junction can walk
    # into the target and delete the files there.
    $previous = $null
    if (Test-Path $current) {
        $previous = (Get-Item $current).Target
        if ($previous -is [array]) { $previous = $previous[0] }
        [IO.Directory]::Delete($current, $false)
    }
    New-Item -ItemType Junction -Path $current -Target $dest | Out-Null

    # Keep the three newest versions, the new one and the previous one: a session opened a few
    # updates ago still runs from its own folder.
    $keep = @($version)
    if ($previous) { $keep += (Split-Path -Leaf $previous) }
    $newest = Get-ChildItem -Path $versions -Directory |
        Where-Object { $_.Name -as [version] } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 3
    $keep += @($newest | ForEach-Object { $_.Name })
    Get-ChildItem -Path $versions -Directory | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
        try { Remove-Item -Recurse -Force $_.FullName } catch { }
    }

    $bin = Join-Path $current 'circle'
    if ($env:CIRCLE_NO_PATH -eq '1') {
        Log "PATH left alone; add $bin to it yourself"
    } else {
        try {
            if (Add-ToUserPath $bin) { Log "added $bin to your user PATH" }
        } catch {
            Write-Host "[circle-install] could not change your PATH ($($_.Exception.Message)); add $bin to it yourself" -ForegroundColor Yellow
        }
        if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }
    }

    Log "installed circle $version at $bin"
    Log 'run it from Windows Terminal, PowerShell or cmd:  circle'
    Log 'a terminal that is not a Windows console (MobaXterm, mintty) cannot show the interface.'
    Log 'update later with:  circle update'
}
