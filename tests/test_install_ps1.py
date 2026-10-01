"""install.ps1 end to end where PowerShell exists (every CI runner has it).

`Invoke-WebRequest` is replaced by a function that serves a local folder. On Windows the script
runs unchanged, junction included. Elsewhere the one `-ItemType Junction` line becomes a symlink,
because a junction cannot exist there; everything else is the real script.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

PWSH = shutil.which("pwsh") or shutil.which("powershell")
pytestmark = pytest.mark.skipif(PWSH is None, reason="PowerShell is not installed")

INSTALL_PS1 = Path(__file__).resolve().parent.parent / "install.ps1"

HARNESS = r"""
param($Root, $Script)
$env:PROCESSOR_ARCHITECTURE = if ($env:FAKE_ARCH) { $env:FAKE_ARCH } else { 'AMD64' }
$env:PROCESSOR_ARCHITEW6432 = $null
$env:CIRCLE_PREFIX = Join-Path $Root 'prefix'
$env:CIRCLE_NO_PATH = '1'
$env:CIRCLE_VERSION = 'v0.2.0'
Add-Type -TypeDefinition @"
public class FakeResponse { public int StatusCode { get { return 404; } } }
public class Http404 : System.Exception {
    public FakeResponse Response { get { return new FakeResponse(); } }
    public Http404() : base("(404) Not Found") { }
}
"@
function Invoke-WebRequest {
    param($Uri, $OutFile, $Method, $Proxy, [switch]$UseBasicParsing)
    if ($env:FAKE_REQUIRE_PROXY -and $Proxy -ne $env:FAKE_REQUIRE_PROXY) { throw "no proxy on $Uri" }
    $name = ($Uri -split '/')[-1]
    $src = Join-Path (Join-Path $Root 'release') $name
    if (-not (Test-Path $src)) { throw (New-Object Http404) }
    Copy-Item $src $OutFile
}
& $Script
if ($env:FAKE_PRINT_PREFERENCES) { Write-Output "EAP=$ErrorActionPreference" }
"""


def _release(root: Path, *, sha: str | None = None, with_program: bool = True) -> None:
    release = root / "release"
    release.mkdir()
    archive = release / "circle-windows-x86_64.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        if with_program:
            zf.writestr("circle/circle.exe", b"MZ")
        zf.writestr("circle/_internal/readme.txt", b"x")
    digest = sha or hashlib.sha256(archive.read_bytes()).hexdigest().upper()
    (release / "circle-windows-x86_64.zip.sha256").write_text(f"{digest}  {archive.name}\n")


def _run(root: Path, **env: str) -> subprocess.CompletedProcess:
    script = INSTALL_PS1
    if sys.platform != "win32":
        script = root / "install-here.ps1"
        script.write_text(INSTALL_PS1.read_text().replace("-ItemType Junction", "-ItemType SymbolicLink"))
    harness = root / "harness.ps1"
    harness.write_text(HARNESS)
    full = {**os.environ, **env}
    return subprocess.run(
        [PWSH, "-NoProfile", "-File", str(harness), "-Root", str(root), "-Script", str(script)],
        capture_output=True, text=True, timeout=120, env=full)


def test_installs_and_switches_current(tmp_path: Path):
    _release(tmp_path)
    for old in ("0.0.7", "0.0.8", "0.0.9", "0.1.0"):
        (tmp_path / "prefix" / "versions" / old).mkdir(parents=True)
    if sys.platform == "win32":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(tmp_path / "prefix" / "current"),
                        str(tmp_path / "prefix" / "versions" / "0.1.0")], check=True,
                       capture_output=True)
    else:
        (tmp_path / "prefix" / "current").symlink_to(tmp_path / "prefix" / "versions" / "0.1.0")
    done = _run(tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert (tmp_path / "prefix" / "current" / "circle" / "circle.exe").is_file()
    kept = sorted(p.name for p in (tmp_path / "prefix" / "versions").iterdir())
    assert kept == ["0.0.9", "0.1.0", "0.2.0"]  # the newest three; 0.0.7 and 0.0.8 are pruned
    assert "sha256 ok" in done.stdout


def test_an_installed_version_is_left_alone(tmp_path: Path):
    """It may be the copy that is running; the release folder is empty, so a download would fail."""
    (tmp_path / "release").mkdir()
    here = tmp_path / "prefix" / "versions" / "0.2.0" / "circle"
    here.mkdir(parents=True)
    (here / "circle.exe").write_bytes(b"MZ")
    (here / "marker").write_text("in use")
    done = _run(tmp_path)
    assert done.returncode == 0, done.stdout + done.stderr
    assert (here / "marker").read_text() == "in use"
    assert "already in" in done.stdout
    assert (tmp_path / "prefix" / "current" / "circle" / "circle.exe").is_file()


def test_the_proxy_reaches_every_request(tmp_path: Path):
    _release(tmp_path)
    done = _run(tmp_path, HTTPS_PROXY="http://proxy.invalid:3128", FAKE_REQUIRE_PROXY="http://proxy.invalid:3128")
    assert done.returncode == 0, done.stdout + done.stderr


def test_the_callers_preferences_are_left_as_they_were(tmp_path: Path):
    _release(tmp_path)
    done = _run(tmp_path, FAKE_PRINT_PREFERENCES="1")
    assert done.returncode == 0, done.stdout + done.stderr
    assert "EAP=Continue" in done.stdout


def test_a_bad_checksum_installs_nothing(tmp_path: Path):
    _release(tmp_path, sha="0" * 64)
    done = _run(tmp_path)
    assert done.returncode != 0
    assert "sha256 mismatch" in done.stdout + done.stderr
    assert not (tmp_path / "prefix" / "current").exists()


def test_an_archive_without_the_program_is_refused(tmp_path: Path):
    _release(tmp_path, with_program=False)
    done = _run(tmp_path)
    assert done.returncode != 0
    assert "circle.exe" in done.stdout + done.stderr
    assert not (tmp_path / "prefix" / "current").exists()


def test_an_unsupported_processor_is_refused(tmp_path: Path):
    _release(tmp_path)
    done = _run(tmp_path, FAKE_ARCH="x86")
    assert done.returncode != 0
    assert "unsupported processor" in done.stdout + done.stderr


def test_a_release_without_a_windows_file_says_so(tmp_path: Path):
    (tmp_path / "release").mkdir()  # the release exists but holds nothing for Windows
    done = _run(tmp_path)
    out = done.stdout + done.stderr
    assert done.returncode != 0
    assert "no file for this system" in out
    assert "HTTPS_PROXY" not in out  # a 404 is not a proxy problem
    assert not (tmp_path / "prefix" / "current").exists()
