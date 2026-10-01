"""install.sh end to end, with a fake curl and uname standing in for GitHub and the machine."""

from __future__ import annotations

import hashlib
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="install.sh is a POSIX script")

INSTALL_SH = Path(__file__).resolve().parent.parent / "install.sh"

FAKE_CURL = r"""#!/usr/bin/env bash
url=""; out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "$FAKE_LOG"
if [[ -n "${FAKE_CURL_EXIT:-}" ]]; then
  echo "curl: ($FAKE_CURL_EXIT) fake failure" >&2
  exit "$FAKE_CURL_EXIT"
fi
case "$url" in
  */releases/latest) printf '%s' "${FAKE_LATEST_URL:-https://github.com/o/r/releases/tag/v${FAKE_LATEST}}" ;;
  */releases/download/*)
    f="$FAKE_RELEASE_DIR/${url##*/}"
    [[ -f "$f" ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
    cp "$f" "$out" ;;
  *) echo "curl: (6) unexpected $url" >&2; exit 6 ;;
esac
"""

FAKE_UNAME = """#!/usr/bin/env bash
case "$1" in
  -s) echo "${FAKE_UNAME_S:-Linux}" ;;
  -m) echo "${FAKE_UNAME_M:-x86_64}" ;;
  *) echo "${FAKE_UNAME_S:-Linux}" ;;
esac
"""


class Box:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.bin = root / "fakebin"
        self.release = root / "release"
        self.home = root / "home"
        self.prefix = root / "prefix"
        self.bindir = root / "bindir"
        self.log = root / "curl.log"
        for d in (self.bin, self.release, self.home):
            d.mkdir()
        for name, body in (("curl", FAKE_CURL), ("uname", FAKE_UNAME)):
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def publish(self, version: str, asset: str = "circle-linux-x86_64.tar.gz", *, sha: str | None = None):
        program = f"#!/bin/sh\necho {version}\n".encode()
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            info = tarfile.TarInfo("circle/circle")
            info.size, info.mode = len(program), 0o755
            tf.addfile(info, io.BytesIO(program))
        data = buf.getvalue()
        (self.release / asset).write_bytes(data)
        digest = sha or hashlib.sha256(data).hexdigest()
        (self.release / f"{asset}.sha256").write_text(f"{digest}  {asset}\n")

    def run(self, **env: str) -> subprocess.CompletedProcess:
        full = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(self.home),
            "SHELL": "/bin/bash",
            "CIRCLE_PREFIX": str(self.prefix),
            "CIRCLE_BIN_DIR": str(self.bindir),
            "CIRCLE_HOME": str(self.root / "circle-home"),
            "FAKE_RELEASE_DIR": str(self.release),
            "FAKE_LOG": str(self.log),
            "FAKE_LATEST": "0.2.0",
        }
        full.update(env)
        return subprocess.run(["bash", str(INSTALL_SH)], env=full, capture_output=True,
                              text=True, timeout=60)


@pytest.fixture
def box(tmp_path: Path) -> Box:
    return Box(tmp_path)


def test_installs_the_latest_release(box: Box):
    box.publish("0.2.0")
    done = box.run()
    assert done.returncode == 0, done.stderr
    assert os.readlink(box.prefix / "current") == "versions/0.2.0"
    program = subprocess.run([str(box.bindir / "circle")], capture_output=True, text=True)
    assert program.stdout.strip() == "0.2.0"
    assert "sha256 校验通过" in done.stderr
    assert "unbound" not in done.stderr  # the EXIT trap must not read a function's local
    assert "circle update" in done.stderr
    assert "api.github.com" not in box.log.read_text()  # no API call, so no rate limit


def test_pinned_version_skips_the_lookup(box: Box):
    box.publish("0.3.1")
    done = box.run(CIRCLE_VERSION="v0.3.1")
    assert done.returncode == 0, done.stderr
    assert "releases/latest" not in box.log.read_text()
    assert (box.prefix / "versions" / "0.3.1" / "circle" / "circle").is_file()


@pytest.mark.parametrize("version", ["../outside", "/tmp/outside", "..", "banana", "0.2.0\n"])
def test_invalid_version_is_refused_before_download_or_filesystem_changes(box: Box, version):
    done = box.run(CIRCLE_VERSION=version)
    assert done.returncode != 0
    assert "无效版本" in done.stderr
    assert not box.log.exists()
    assert not box.prefix.exists()
    assert not box.bindir.exists()


def test_keeps_the_newest_three_versions_and_the_previous_one(box: Box):
    for old in ("0.0.7", "0.0.8", "0.0.9", "0.1.0"):
        (box.prefix / "versions" / old).mkdir(parents=True)
    os.symlink("versions/0.0.8", box.prefix / "current")  # the one in use is not among the newest
    box.publish("0.2.0")
    assert box.run().returncode == 0
    assert sorted(p.name for p in (box.prefix / "versions").iterdir()) == [
        "0.0.8", "0.0.9", "0.1.0", "0.2.0"]


def test_installing_a_version_that_is_already_there_leaves_it_alone(box: Box):
    """It may be the copy that is running: nothing is deleted, downloaded or unpacked over it."""
    here = box.prefix / "versions" / "0.2.0" / "circle"
    here.mkdir(parents=True)
    (here / "circle").write_text("#!/bin/sh\necho already here\n")
    (here / "circle").chmod(0o755)
    (here / "marker").write_text("in use")
    done = box.run()  # nothing is published: a download would fail
    assert done.returncode == 0, done.stderr
    assert (here / "marker").read_text() == "in use"
    assert "已在" in done.stderr
    assert os.readlink(box.prefix / "current") == "versions/0.2.0"
    assert not box.log.exists() or "download" not in box.log.read_text()


def test_leftovers_of_an_interrupted_install_are_cleaned_up(box: Box):
    (box.prefix / "versions" / "0.2.0.partial").mkdir(parents=True)
    box.publish("0.2.0")
    assert box.run().returncode == 0
    assert not (box.prefix / "versions" / "0.2.0.partial").exists()


def test_replaces_the_real_folder_of_the_old_layout(box: Box):
    (box.prefix / "current" / "circle").mkdir(parents=True)
    (box.prefix / "current" / "circle" / "circle").write_text("old")
    box.publish("0.2.0")
    done = box.run()
    assert done.returncode == 0, done.stderr
    assert (box.prefix / "current").is_symlink()


def test_a_bad_checksum_installs_nothing(box: Box):
    box.publish("0.2.0", sha="0" * 64)
    done = box.run()
    assert done.returncode != 0
    assert "sha256 不符" in done.stderr
    assert not (box.prefix / "current").exists()
    assert not (box.bindir / "circle").exists()


def test_tls_failure_says_what_to_do(box: Box):
    done = box.run(FAKE_CURL_EXIT="60")
    assert done.returncode != 0
    assert "CURL_CA_BUNDLE" in done.stderr
    assert "证书" in done.stderr


def test_a_missing_file_points_at_the_releases_page(box: Box):
    done = box.run()  # nothing published
    assert done.returncode != 0
    assert "github.com/qingshanfeihu/circle/releases" in done.stderr


def test_no_release_yet(box: Box):
    done = box.run(FAKE_LATEST_URL="https://github.com/o/r/releases")
    assert done.returncode != 0
    assert "还没有发布 Release" in done.stderr


def test_unsupported_machine_is_refused_before_any_download(box: Box):
    done = box.run(FAKE_UNAME_M="mips")
    assert done.returncode != 0
    assert "arch" in done.stderr
    assert not box.log.exists()


def test_windows_shell_hands_over_to_powershell(box: Box):
    powershell = box.bin / "powershell.exe"
    powershell.write_text('#!/usr/bin/env bash\necho "$@" > "$FAKE_LOG"\n')
    powershell.chmod(0o755)
    done = box.run(FAKE_UNAME_S="MINGW64_NT-10.0-22631", FAKE_UNAME_M="x86_64")
    assert done.returncode == 0, done.stderr
    handed = box.log.read_text()
    assert "install.ps1" in handed
    assert "raw.githubusercontent.com/qingshanfeihu/circle/main/" in handed


def test_windows_shell_without_powershell_says_so(box: Box):
    done = box.run(FAKE_UNAME_S="CYGWIN_NT-10.0", FAKE_UNAME_M="x86_64")
    assert done.returncode != 0
    assert "powershell.exe" in done.stderr
    assert "install.ps1" in done.stderr
    assert not box.log.exists()
