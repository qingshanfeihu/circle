"""`circle update` and the start-up reminder, without a network."""

from __future__ import annotations

import hashlib
import io
import json
import os
import ssl
import tarfile
import time
import urllib.error
import zipfile
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage

from circle import update
from circle.cli import main
from circle.oauth import start_oauth_login
from circle.settings import CircleSettings, load_settings, save_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp

REPO = "owner/circle"


# ── versions and asset names ───────────────────────────────────────────────


def test_version_order():
    assert update.is_newer("0.2.0", "0.1.0")
    assert update.is_newer("v0.10.0", "0.9.9")
    assert not update.is_newer("0.1.0", "0.1.0")
    assert not update.is_newer("0.1.0", "0.2.0")
    assert update.is_newer("0.2.0", "0.2.0rc1")  # a release is newer than its candidate
    assert not update.is_newer("nightly", "0.1.0")  # not a version: never "newer"
    assert update.parse_version("1.2") is None


@pytest.mark.parametrize(
    ("platform", "machine", "expected"),
    [
        ("darwin", "arm64", "circle-darwin-arm64.tar.gz"),
        ("darwin", "x86_64", "circle-darwin-x86_64.tar.gz"),
        ("linux", "aarch64", "circle-linux-arm64.tar.gz"),
        ("linux", "x86_64", "circle-linux-x86_64.tar.gz"),
        ("win32", "AMD64", "circle-windows-x86_64.zip"),
        ("win32", "ARM64", "circle-windows-x86_64.zip"),  # runs the x86_64 build, emulated
    ],
)
def test_asset_names(platform, machine, expected):
    assert update.asset_name(platform, machine) == expected


@pytest.mark.parametrize(("platform", "machine"), [("cygwin", "x86_64"), ("linux", "riscv64")])
def test_unsupported_platform_is_an_error(platform, machine):
    with pytest.raises(update.UpdateError):
        update.asset_name(platform, machine)


def test_installer_command_matches_platform():
    assert "install.sh | bash" in update.installer_command(REPO, "linux")
    assert "install.ps1 | iex" in update.installer_command(REPO, "win32")


# ── asking GitHub ──────────────────────────────────────────────────────────


class _Response(io.BytesIO):
    def __init__(self, body: bytes = b"", url: str = "", headers: dict | None = None):
        super().__init__(body)
        self._url = url
        self.headers = headers or {"Content-Length": str(len(body))}

    def geturl(self) -> str:
        return self._url


def _serve(monkeypatch, routes: dict[str, bytes | str], *, seen: list | None = None):
    """Answer `update._open` from a table: bytes are a body, a str is a redirect target."""

    def fake_open(url, *, method="GET", timeout=15.0):
        if seen is not None:
            seen.append((method, url))
        if url not in routes:
            raise update.UpdateError(f"{url} answered 404")
        hit = routes[url]
        if isinstance(hit, str):
            return _Response(url=hit)
        return _Response(hit, url)

    monkeypatch.setattr(update, "_open", fake_open)


def test_latest_version_follows_the_redirect(monkeypatch):
    seen: list = []
    _serve(monkeypatch, {f"https://github.com/{REPO}/releases/latest":
                         f"https://github.com/{REPO}/releases/tag/v0.2.0"}, seen=seen)
    assert update.latest_version(REPO) == "0.2.0"
    assert seen == [("HEAD", f"https://github.com/{REPO}/releases/latest")]


def test_no_release_yet(monkeypatch):
    _serve(monkeypatch, {})
    with pytest.raises(update.UpdateError, match="has not published a release"):
        update.latest_version(REPO)
    _serve(monkeypatch, {f"https://github.com/{REPO}/releases/latest":
                         f"https://github.com/{REPO}/releases"})
    with pytest.raises(update.UpdateError, match="has not published a release"):
        update.latest_version(REPO)


def test_tls_failure_says_how_to_fix_it(monkeypatch):
    def refuse(*_a, **_k):
        raise urllib.error.URLError(ssl.SSLCertVerificationError("unable to get local issuer"))

    monkeypatch.setattr(update.urllib.request, "urlopen", refuse)
    with pytest.raises(update.UpdateError, match="SSL_CERT_FILE"):
        update._open("https://github.com/x")


# ── trust store ────────────────────────────────────────────────────────────


class _Context:
    def __init__(self):
        self.loaded: list[str] = []

    def load_verify_locations(self, path):
        self.loaded.append(path)


def _paths(cafile, capath):
    return ssl.DefaultVerifyPaths(cafile=cafile, capath=capath, openssl_cafile_env="SSL_CERT_FILE",
                                  openssl_cafile=cafile or "", openssl_capath_env="SSL_CERT_DIR",
                                  openssl_capath=capath or "")


def test_a_frozen_program_without_a_system_trust_store_falls_back_to_certifi(monkeypatch, tmp_path):
    fake = _Context()
    monkeypatch.setattr(update.sys, "platform", "linux")
    monkeypatch.setattr(update.ssl, "create_default_context", lambda: fake)
    monkeypatch.setattr(update.ssl, "get_default_verify_paths",
                        lambda: _paths(str(tmp_path / "nope.pem"), str(tmp_path / "nodir")))
    assert update._ssl_context() is fake  # noqa: SLF001
    import certifi

    assert fake.loaded == [certifi.where()]


def test_the_system_trust_store_is_used_when_it_exists(monkeypatch, tmp_path):
    bundle = tmp_path / "ca.pem"
    bundle.write_text("x")
    fake = _Context()
    monkeypatch.setattr(update.sys, "platform", "linux")
    monkeypatch.setattr(update.ssl, "create_default_context", lambda: fake)
    monkeypatch.setattr(update.ssl, "get_default_verify_paths", lambda: _paths(str(bundle), None))
    update._ssl_context()  # noqa: SLF001
    assert fake.loaded == []


def test_windows_keeps_its_own_certificate_store(monkeypatch):
    fake = _Context()
    monkeypatch.setattr(update.sys, "platform", "win32")
    monkeypatch.setattr(update.ssl, "create_default_context", lambda: fake)
    update._ssl_context()  # noqa: SLF001
    assert fake.loaded == []


# ── the reminder ───────────────────────────────────────────────────────────


def test_reminder_asks_once_a_day(tmp_path: Path):
    calls: list[int] = []

    def fetch() -> str:
        calls.append(1)
        return "0.2.0"

    assert update.available_update(tmp_path, "0.1.0", fetch=fetch, now=1000.0) == "0.2.0"
    assert update.available_update(tmp_path, "0.1.0", fetch=fetch, now=1000.0 + 3600) == "0.2.0"
    assert calls == [1]  # the second answer came from update-check.json
    assert update.available_update(
        tmp_path, "0.1.0", fetch=fetch, now=1000.0 + update.CHECK_INTERVAL_S + 1) == "0.2.0"
    assert calls == [1, 1]


def test_reminder_is_silent_when_current_or_ahead(tmp_path: Path):
    assert update.available_update(tmp_path, "0.2.0", fetch=lambda: "0.2.0", now=5.0) is None
    assert update.available_update(tmp_path, "0.3.0", fetch=lambda: "0.2.0", now=5.0 + 9) is None


def test_reminder_survives_a_dead_network(tmp_path: Path):
    def down() -> str:
        raise update.UpdateError("cannot reach github.com")

    assert update.available_update(tmp_path, "0.1.0", fetch=down, now=10.0) is None
    calls: list[int] = []
    assert update.available_update(tmp_path, "0.1.0", fetch=lambda: calls.append(1) or "0.2.0",
                                   now=20.0) is None
    assert calls == []  # a failed check is not retried until the day is over


def test_reminder_keeps_the_last_answer_when_the_network_fails(tmp_path: Path):
    update.available_update(tmp_path, "0.1.0", fetch=lambda: "0.2.0", now=0.0)

    def down() -> str:
        raise update.UpdateError("offline")

    later = update.CHECK_INTERVAL_S + 5.0
    assert update.available_update(tmp_path, "0.1.0", fetch=down, now=later) == "0.2.0"


def test_reminder_ignores_a_broken_cache(tmp_path: Path):
    (tmp_path / update.CACHE_FILE).write_text("{not json", encoding="utf-8")
    assert update.available_update(tmp_path, "0.1.0", fetch=lambda: "0.2.0", now=1.0) == "0.2.0"
    (tmp_path / update.CACHE_FILE).write_text(json.dumps([1, 2]), encoding="utf-8")
    assert update.available_update(tmp_path, "0.1.0", fetch=lambda: "0.3.0", now=2.0) == "0.3.0"


def test_check_can_be_switched_off(monkeypatch):
    monkeypatch.delenv("CIRCLE_NO_UPDATE_CHECK", raising=False)
    assert update.check_enabled(CircleSettings())
    assert not update.check_enabled(CircleSettings(update_check=False))
    monkeypatch.setenv("CIRCLE_NO_UPDATE_CHECK", "1")
    assert not update.check_enabled(CircleSettings())


def test_update_check_setting_round_trips(tmp_path: Path):
    assert load_settings(tmp_path).update_check is True
    save_settings(CircleSettings(update_check=False), tmp_path)
    assert load_settings(tmp_path).update_check is False


def _session(tmp_path: Path, monkeypatch) -> CircleSessionApp:
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    monkeypatch.delenv("CIRCLE_NO_UPDATE_CHECK", raising=False)
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    assert init.settings is not None
    TrustController(init.settings, ws, home=home).confirm()
    model = ScriptedModel(responses=[AIMessage(content=f"r{i}") for i in range(4)])
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def _wait_for(check, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return False


def test_session_shows_one_line_when_a_release_is_newer(tmp_path: Path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    monkeypatch.setattr(update, "available_update", lambda home: "9.9.9")
    app._start_update_check()  # noqa: SLF001
    snap = lambda: "\n".join(app._transcript.snapshot())  # noqa: E731, SLF001
    assert _wait_for(lambda: "9.9.9" in snap())
    assert "circle update" in snap()


def test_session_stays_quiet_when_the_check_is_off(tmp_path: Path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    app.settings.update_check = False
    asked: list[int] = []
    monkeypatch.setattr(update, "available_update", lambda home: asked.append(1) or "9.9.9")
    app._start_update_check()  # noqa: SLF001
    time.sleep(0.2)
    assert asked == []
    assert "9.9.9" not in "\n".join(app._transcript.snapshot())  # noqa: SLF001


# ── installing ─────────────────────────────────────────────────────────────


def _archive(version: str, *, evil: bool = False) -> bytes:
    """A release archive for this machine's platform, holding circle/circle."""
    name = update.asset_name()
    program = b"#!/bin/sh\necho %s\n" % version.encode()
    buf = io.BytesIO()
    exe = "circle.exe" if os.name == "nt" else "circle"
    if name.endswith(".zip"):
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"circle/{exe}", program)
    else:
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            info = tarfile.TarInfo(f"circle/{exe}")
            info.size, info.mode = len(program), 0o755
            tf.addfile(info, io.BytesIO(program))
            if evil:
                bad = tarfile.TarInfo("../escaped")
                bad.size = 1
                tf.addfile(bad, io.BytesIO(b"x"))
    return buf.getvalue()


def _release(monkeypatch, version: str, *, archive: bytes | None = None, digest: str | None = None):
    body = archive if archive is not None else _archive(version)
    asset = update.asset_name()
    base = f"https://github.com/{REPO}/releases/download/v{version}"
    sha = digest or hashlib.sha256(body).hexdigest()
    _serve(monkeypatch, {f"{base}/{asset}": body, f"{base}/{asset}.sha256": f"{sha}  {asset}\n".encode()})


def _installed(tmp_path: Path, *versions: str, current: str) -> update.Install:
    prefix = tmp_path / "prefix"
    exe = "circle.exe" if os.name == "nt" else "circle"
    for v in versions:
        (prefix / "versions" / v / "circle").mkdir(parents=True)
        (prefix / "versions" / v / "circle" / exe).write_bytes(b"old")
    install = update.Install(prefix=prefix, running=current)
    update._point_current(install, current)  # noqa: SLF001
    return install


def test_install_moves_current_and_prunes_all_but_the_newest_three(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.0.7", "0.0.8", "0.0.9", "0.1.0", current="0.1.0")
    _release(monkeypatch, "0.2.0")
    update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.2.0"
    kept = sorted(p.name for p in install.versions.iterdir())
    assert kept == ["0.0.9", "0.1.0", "0.2.0"]
    exe = "circle.exe" if os.name == "nt" else "circle"
    assert (install.current / "circle" / exe).is_file()
    assert not list(install.prefix.glob(".update-*"))  # scratch space is gone


def test_the_running_copy_is_never_pruned_however_old(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.0.1", "0.0.8", "0.0.9", "0.1.0", current="0.0.1")
    _release(monkeypatch, "0.2.0")
    update.install_version("0.2.0", install, repo=REPO)
    assert sorted(p.name for p in install.versions.iterdir()) == ["0.0.1", "0.0.9", "0.1.0", "0.2.0"]


def test_install_can_go_back_without_downloading(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", "0.2.0", current="0.2.0")
    _serve(monkeypatch, {})  # any request would fail
    update.install_version("0.1.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"


def test_an_incomplete_installed_version_does_not_replace_current(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    target = install.versions / "0.2.0"
    target.mkdir()
    marker = target / "marker"
    marker.write_text("unfinished")
    _serve(monkeypatch, {})
    with pytest.raises(update.UpdateError, match="does not hold the circle program"):
        update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"
    assert marker.read_text() == "unfinished"
    assert (install.versions / "0.1.0").is_dir()


@pytest.mark.parametrize("version", ["../outside", "/tmp/outside", r"..\outside", "", "v0.2.0"])
def test_install_refuses_invalid_version_paths(tmp_path: Path, monkeypatch, version):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    _serve(monkeypatch, {})
    with pytest.raises(update.UpdateError, match="is not a version"):
        update.install_version(version, install, repo=REPO)
    assert install.linked_version() == "0.1.0"
    assert sorted(p.name for p in install.versions.iterdir()) == ["0.1.0"]


def test_a_bad_checksum_installs_nothing(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    _release(monkeypatch, "0.2.0", digest="0" * 64)
    with pytest.raises(update.UpdateError, match="sha256"):
        update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"
    assert not (install.versions / "0.2.0").exists()


def test_a_download_that_dies_half_way_is_a_message(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    asset = update.asset_name()
    base = f"https://github.com/{REPO}/releases/download/v0.2.0"

    class Dies(_Response):
        def read(self, n=-1):
            raise ConnectionResetError("peer reset")

    def fake_open(url, *, method="GET", timeout=15.0):
        if url.endswith(".sha256"):
            return _Response(f"{'a' * 64}  {asset}\n".encode(), url)
        assert url == f"{base}/{asset}"
        return Dies(b"", url, {"Content-Length": "10"})

    monkeypatch.setattr(update, "_open", fake_open)
    with pytest.raises(update.UpdateError, match="interrupted"):
        update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"
    assert not list(install.prefix.glob(".update-*"))


def test_a_filesystem_error_reaches_the_user_as_a_message(scratch_home, tmp_path, monkeypatch, capsys):
    install = _installed(tmp_path, update.__version__, current=update.__version__)
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    monkeypatch.setattr(update, "is_frozen", lambda: True)
    monkeypatch.setattr(update, "find_install", lambda *_a: install)

    def refuse(*_a, **_k):
        raise PermissionError("[Errno 13] Permission denied")

    monkeypatch.setattr(update, "install_version", refuse)
    assert main(["update"]) == 1
    err = capsys.readouterr().err
    assert "Permission denied" in err and "Traceback" not in err


def test_output_is_safe_on_a_console_that_cannot_show_every_character(scratch_home, monkeypatch):
    raw = io.BytesIO()
    narrow = io.TextIOWrapper(raw, encoding="ascii", write_through=True)
    monkeypatch.setattr(update.sys, "stdout", narrow)
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    assert main(["update", "--check"]) == 0  # would raise UnicodeEncodeError with strict ascii
    assert b"9.0.0" in raw.getvalue()


def test_a_missing_asset_names_the_release(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    _serve(monkeypatch, {})
    with pytest.raises(update.UpdateError, match=r"release v0\.2\.0 has no circle-"):
        update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"


@pytest.mark.skipif(update.asset_name().endswith(".zip"), reason="zip extraction cannot escape")
def test_an_archive_that_escapes_is_refused(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    _release(monkeypatch, "0.2.0", archive=_archive("0.2.0", evil=True))
    with pytest.raises(update.UpdateError):
        update.install_version("0.2.0", install, repo=REPO)
    assert install.linked_version() == "0.1.0"
    assert not (install.prefix / "escaped").exists()
    assert not (install.prefix.parent / "escaped").exists()


def test_an_archive_without_the_program_is_refused(tmp_path: Path, monkeypatch):
    install = _installed(tmp_path, "0.1.0", current="0.1.0")
    buf = io.BytesIO()
    if update.asset_name().endswith(".zip"):
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("circle/readme.txt", b"hi")
    else:
        with tarfile.open(fileobj=buf, mode="w:gz") as tf:
            info = tarfile.TarInfo("circle/readme.txt")
            info.size = 2
            tf.addfile(info, io.BytesIO(b"hi"))
    _release(monkeypatch, "0.2.0", archive=buf.getvalue())
    with pytest.raises(update.UpdateError, match="does not hold the circle program"):
        update.install_version("0.2.0", install, repo=REPO)


def test_find_install_reads_the_layout(tmp_path: Path):
    exe = tmp_path / "p" / "versions" / "0.1.0" / "circle" / "circle"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    found = update.find_install(exe)
    assert found == update.Install(prefix=(tmp_path / "p").resolve(), running="0.1.0")
    other = tmp_path / "elsewhere" / "circle"
    other.parent.mkdir()
    other.write_bytes(b"")
    assert update.find_install(other) is None


# ── the command ────────────────────────────────────────────────────────────


@pytest.fixture
def scratch_home(tmp_path: Path, monkeypatch) -> Path:
    home = tmp_path / "home"
    monkeypatch.setenv("CIRCLE_HOME", str(home))
    monkeypatch.setenv("CIRCLE_REPO", REPO)
    return home


def test_cli_hands_update_to_the_command(monkeypatch):
    got: list[list[str]] = []
    monkeypatch.setattr(update, "update_main", lambda argv: got.append(argv) or 0)
    assert main(["update", "--check"]) == 0
    assert got == [["--check"]]


def test_check_reports_a_newer_release(scratch_home, monkeypatch, capsys):
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    assert main(["update", "--check"]) == 0
    assert "circle 9.0.0 is available" in capsys.readouterr().out
    assert json.loads((scratch_home / update.CACHE_FILE).read_text())["latest"] == "9.0.0"


def test_check_reports_up_to_date(scratch_home, monkeypatch, capsys):
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: update.__version__)
    assert main(["update", "--check"]) == 0
    assert "up to date" in capsys.readouterr().out


def test_update_says_when_it_cannot_reach_github(scratch_home, monkeypatch, capsys):
    def down(repo=None, **_k):
        raise update.UpdateError("cannot reach https://github.com/x: timed out")

    monkeypatch.setattr(update, "latest_version", down)
    assert main(["update"]) == 1
    assert "cannot reach" in capsys.readouterr().err


def test_update_from_source_explains_instead_of_acting(scratch_home, monkeypatch, capsys):
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    monkeypatch.setattr(update, "is_frozen", lambda: False)
    assert main(["update"]) == 1
    err = capsys.readouterr().err
    assert "git" in err or "pip" in err


def test_update_outside_the_installer_layout(scratch_home, monkeypatch, capsys):
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    monkeypatch.setattr(update, "is_frozen", lambda: True)
    monkeypatch.setattr(update, "find_install", lambda *_a: None)
    assert main(["update"]) == 1
    assert "installer" in capsys.readouterr().err


def test_update_installs_the_newest(scratch_home, tmp_path, monkeypatch, capsys):
    install = _installed(tmp_path, update.__version__, current=update.__version__)
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: "9.0.0")
    monkeypatch.setattr(update, "is_frozen", lambda: True)
    monkeypatch.setattr(update, "find_install", lambda *_a: install)
    _release(monkeypatch, "9.0.0")
    assert main(["update"]) == 0
    assert install.linked_version() == "9.0.0"
    assert "installed circle 9.0.0" in capsys.readouterr().out
    assert update.available_update(scratch_home, update.__version__,
                                   fetch=lambda: pytest.fail("cached")) == "9.0.0"


def test_update_does_nothing_when_current(scratch_home, tmp_path, monkeypatch, capsys):
    install = _installed(tmp_path, update.__version__, current=update.__version__)
    monkeypatch.setattr(update, "latest_version", lambda repo=None, **_k: update.__version__)
    monkeypatch.setattr(update, "is_frozen", lambda: True)
    monkeypatch.setattr(update, "find_install", lambda *_a: install)
    _serve(monkeypatch, {})
    assert main(["update"]) == 0
    assert "up to date" in capsys.readouterr().out


def test_update_can_pin_a_version(scratch_home, tmp_path, monkeypatch, capsys):
    install = _installed(tmp_path, update.__version__, current=update.__version__)
    monkeypatch.setattr(update, "is_frozen", lambda: True)
    monkeypatch.setattr(update, "find_install", lambda *_a: install)
    monkeypatch.setattr(update, "latest_version", lambda *a, **k: pytest.fail("pinned"))
    _release(monkeypatch, "0.0.1")
    assert main(["update", "--version", "v0.0.1"]) == 0
    assert install.linked_version() == "0.0.1"
    assert main(["update", "--version", "banana"]) == 2
