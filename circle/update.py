"""Find the newest release and replace the installed copy with it.

Two entry points use this module: ``circle update`` (``update_main``) and the reminder the
session shows at start (``available_update``). Both ask GitHub for the newest release of the
repository, by following the ``/releases/latest`` redirect. That needs no API token and has no
rate limit.

The installer (``install.sh``, ``install.ps1``) and ``circle update`` share one layout::

    <prefix>/versions/<version>/circle/circle     one folder per installed version
    <prefix>/current                              a link to the version in use

An update unpacks the new version next to the running one, checks its sha256 against the
``.sha256`` file published with it, and only then moves ``current``. The running copy is never
touched, so a session that is open keeps working until it is restarted.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import ssl
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from circle import __version__
from circle.paths import circle_home, is_frozen

DEFAULT_REPO = "qingshanfeihu/circle"
CHECK_INTERVAL_S = 24 * 3600
CACHE_FILE = "update-check.json"
_CHUNK = 1 << 20
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-.+]?([0-9A-Za-z][0-9A-Za-z.+-]*))?$")
_TAG_RE = re.compile(r"/releases/tag/([^/?#]+)/?$")
_OFF = {"1", "true", "yes"}


class UpdateError(Exception):
    """Something stopped the update. The message says what and, where there is one, the way out."""


# ── versions ───────────────────────────────────────────────────────────────


def parse_version(text: str) -> tuple[int, int, int, int, str] | None:
    """``0.2.0`` or ``v0.2.0`` as a sortable tuple. A suffix such as ``rc1`` sorts before the
    release it belongs to. Anything that is not a version gives None."""
    match = _VERSION_RE.match((text or "").strip())
    if not match:
        return None
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), 0 if pre else 1, pre or ""


def is_newer(candidate: str, current: str) -> bool:
    a, b = parse_version(candidate), parse_version(current)
    return a is not None and b is not None and a > b


def bare_version(text: str) -> str:
    return (text or "").strip().removeprefix("v")


# ── what to download ───────────────────────────────────────────────────────


def platform_tags(platform: str | None = None, machine: str | None = None) -> tuple[str, str]:
    """(os, arch) as they appear in an asset name: ``darwin|linux|windows`` and ``x86_64|arm64``."""
    import platform as _platform

    plat = sys.platform if platform is None else platform
    mach = (_platform.machine() if machine is None else machine).lower()
    if plat == "darwin":
        os_tag = "darwin"
    elif plat.startswith("linux"):
        os_tag = "linux"
    elif plat == "win32":
        os_tag = "windows"
    else:
        raise UpdateError(f"there is no build for {plat}; Circle runs on macOS, Linux and Windows")
    if mach in ("x86_64", "amd64", "x64"):
        arch = "x86_64"
    elif mach in ("arm64", "aarch64"):
        # Windows on ARM runs the x86_64 build under emulation; there is no native one.
        arch = "x86_64" if os_tag == "windows" else "arm64"
    else:
        raise UpdateError(f"there is no build for the {mach} processor")
    return os_tag, arch


def asset_name(platform: str | None = None, machine: str | None = None) -> str:
    os_tag, arch = platform_tags(platform, machine)
    return f"circle-{os_tag}-{arch}." + ("zip" if os_tag == "windows" else "tar.gz")


def installer_command(repo: str, platform: str | None = None) -> str:
    plat = sys.platform if platform is None else platform
    base = f"https://raw.githubusercontent.com/{repo}/main"
    if plat == "win32":
        return f"irm {base}/install.ps1 | iex"
    return f"curl -fsSL {base}/install.sh | bash"


# ── network ────────────────────────────────────────────────────────────────

_TLS_HINT = (
    "the TLS certificate could not be verified. If your network inspects HTTPS traffic, set "
    "SSL_CERT_FILE to a CA bundle (PEM) that includes its certificate"
)


def _ssl_context() -> ssl.SSLContext:
    """The system's trust store. A frozen program can be left without one: Python builds point
    OpenSSL at a certificate file that only exists on the machine that built them. In that case
    fall back to the bundle that ships with certifi (httpx, which the model clients use, needs it
    anyway). Windows reads its own certificate store, so nothing is added there."""
    context = ssl.create_default_context()
    if sys.platform == "win32":
        return context
    paths = ssl.get_default_verify_paths()
    if any(p and os.path.exists(p) for p in (paths.cafile, paths.capath)):
        return context
    try:
        import certifi

        context.load_verify_locations(certifi.where())
    except (ImportError, OSError):
        pass
    return context


def _open(url: str, *, method: str = "GET", timeout: float = 15.0):
    request = urllib.request.Request(url, method=method,
                                     headers={"User-Agent": f"circle/{__version__}"})
    try:
        return urllib.request.urlopen(  # noqa: S310 — https only
            request, timeout=timeout, context=_ssl_context())
    except urllib.error.HTTPError as exc:
        raise UpdateError(f"{url} answered {exc.code}") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, ssl.SSLError):
            raise UpdateError(_TLS_HINT) from exc
        raise UpdateError(f"cannot reach {url}: {exc.reason}") from exc
    except (TimeoutError, OSError, http.client.HTTPException) as exc:
        raise UpdateError(f"cannot reach {url}: {exc}") from exc


def latest_version(repo: str | None = None, *, timeout: float = 5.0) -> str:
    """The newest published release, without the ``v``. Drafts and prereleases do not count."""
    repo = repo or os.environ.get("CIRCLE_REPO") or DEFAULT_REPO
    try:
        with _open(f"https://github.com/{repo}/releases/latest", method="HEAD",
                   timeout=timeout) as response:
            final = response.geturl()
    except UpdateError as exc:
        if "answered 404" in str(exc):
            raise UpdateError(f"{repo} has not published a release yet") from exc
        raise
    match = _TAG_RE.search(final)
    if not match or parse_version(match.group(1)) is None:
        raise UpdateError(f"{repo} has not published a release yet")
    return bare_version(match.group(1))


def _fetch_checksum(url: str) -> str:
    try:
        with _open(url) as response:
            text = response.read(4096).decode("utf-8", errors="replace")
    except (OSError, http.client.HTTPException) as exc:
        raise UpdateError(f"cannot read {url}: {exc}") from exc
    words = text.split()
    if not words or not _SHA256_RE.match(words[0]):
        raise UpdateError(f"{url} does not hold a sha256")
    return words[0].lower()


def _download(url: str, path: Path, progress: Callable[[int, int], None] | None = None) -> str:
    """Stream ``url`` to ``path`` and return the sha256 of what arrived."""
    digest = hashlib.sha256()
    try:
        with _open(url, timeout=30.0) as response, path.open("wb") as out:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = response.read(_CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if progress is not None:
                    progress(done, total)
    except (OSError, http.client.HTTPException) as exc:
        raise UpdateError(f"the download was interrupted: {exc}") from exc
    return digest.hexdigest()


# ── the reminder ───────────────────────────────────────────────────────────


def check_enabled(settings: object | None = None) -> bool:
    """False when the user turned the start-up check off, in settings or in the environment."""
    if os.environ.get("CIRCLE_NO_UPDATE_CHECK", "").strip().lower() in _OFF:
        return False
    return bool(getattr(settings, "update_check", True))


def _read_cache(home: Path) -> dict:
    try:
        data = json.loads((home / CACHE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(home: Path, latest: str, now: float) -> None:
    try:
        home.mkdir(parents=True, exist_ok=True)
        (home / CACHE_FILE).write_text(
            json.dumps({"checked_at": now, "latest": latest}) + "\n", encoding="utf-8")
    except OSError:
        pass


def available_update(
    home: Path | None = None,
    current: str = __version__,
    *,
    fetch: Callable[[], str] | None = None,
    now: float | None = None,
) -> str | None:
    """The newest version if it is newer than ``current``, else None. Asks the network at most
    once a day and remembers the answer in ``update-check.json``; a failed check is not retried
    until the day is over. Never raises."""
    home = home or circle_home()
    now = time.time() if now is None else now
    cache = _read_cache(home)
    latest = str(cache.get("latest") or "")
    try:
        checked: float | None = float(cache["checked_at"])
    except (KeyError, TypeError, ValueError):
        checked = None
    if checked is None or now - checked >= CHECK_INTERVAL_S or checked > now:
        try:
            latest = (fetch or latest_version)()
        except (UpdateError, OSError, ValueError, http.client.HTTPException):
            pass
        _write_cache(home, latest, now)
    return latest if latest and is_newer(latest, current) else None


def notice_text(latest: str, current: str = __version__) -> str:
    return f"Circle {latest} is available (you have {current}) · run `circle update`"


# ── the installed copy ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Install:
    prefix: Path
    running: str  # name of the version folder this process runs from

    @property
    def versions(self) -> Path:
        return self.prefix / "versions"

    @property
    def current(self) -> Path:
        return self.prefix / "current"

    def linked_version(self) -> str | None:
        """The version ``current`` points at, or None if there is no such link."""
        try:
            return Path(os.path.realpath(self.current)).name if self.current.exists() else None
        except OSError:
            return None


def find_install(executable: str | Path | None = None) -> Install | None:
    """The installer's layout around the running program, or None if it runs from somewhere
    else (a source checkout, a copy unpacked by hand, the layout of version 0.1.0)."""
    exe = Path(executable or sys.executable).resolve()
    for folder in exe.parents:
        if folder.parent.name == "versions":
            return Install(prefix=folder.parent.parent, running=folder.name)
    return None


def _point_current(install: Install, version: str) -> None:
    link = install.current
    if os.name == "nt":
        import _winapi  # type: ignore[import-not-found]

        try:
            if link.exists() or link.is_symlink():
                os.rmdir(link)  # removes a junction; refuses a real folder that has files in it
            _winapi.CreateJunction(str(install.versions / version), str(link))
        except OSError as exc:
            raise UpdateError(f"cannot move {link} to {version}: {exc}") from exc
        return
    staged = install.prefix / ".current.new"
    try:
        if staged.is_symlink() or staged.exists():
            staged.unlink()
        os.symlink(Path("versions") / version, staged)
        os.replace(staged, link)  # atomic; fails if `current` is a real folder
    except OSError as exc:
        raise UpdateError(f"cannot move {link} to {version}: {exc}") from exc


def _extract(archive: Path, dest: Path) -> None:
    try:
        if archive.suffix == ".zip":
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(dest)
            return
        with tarfile.open(archive, "r:gz") as tf:
            if hasattr(tarfile, "data_filter"):
                tf.extractall(dest, filter="data")
                return
            root = dest.resolve()
            for member in tf.getmembers():
                target = (dest / member.name).resolve()
                if root != target and root not in target.parents:
                    raise UpdateError(f"the archive holds a path outside itself: {member.name}")
                if member.issym() or member.islnk():
                    raise UpdateError(f"the archive holds a link: {member.name}")
            tf.extractall(dest)
    except (tarfile.TarError, zipfile.BadZipFile, OSError) as exc:
        raise UpdateError(f"cannot unpack {archive.name}: {exc}") from exc


def _has_program(tree: Path) -> bool:
    name = "circle.exe" if os.name == "nt" else "circle"
    return (tree / "circle" / name).is_file() or (tree / name).is_file()


KEEP_VERSIONS = 3


def _prune(install: Install, keep: set[str]) -> None:
    """Remove every installed version except ``keep`` and the newest few. A session that was
    opened some updates ago still runs from its own folder; the newest few are what it is most
    likely to be."""
    try:
        entries = [e for e in install.versions.iterdir() if e.is_dir()]
    except OSError:
        return
    ordered = sorted((e for e in entries if parse_version(e.name)),
                     key=lambda e: parse_version(e.name), reverse=True)
    keep = keep | {e.name for e in ordered[:KEEP_VERSIONS]}
    for entry in entries:
        if entry.name not in keep:
            shutil.rmtree(entry, ignore_errors=True)


def install_version(
    version: str,
    install: Install,
    *,
    repo: str,
    progress: Callable[[int, int], None] | None = None,
    say: Callable[[str], None] = lambda _msg: None,
) -> None:
    """Unpack ``version`` under ``versions/`` (unless it is already there), then point
    ``current`` at it and drop the versions that are no longer needed."""
    if version != bare_version(version) or parse_version(version) is None:
        raise UpdateError(f"{version!r} is not a version like 0.2.0")
    target = install.versions / version
    if target.exists() and not _has_program(target):
        raise UpdateError(f"{target} does not hold the circle program; nothing was changed")
    if not target.is_dir():
        asset = asset_name()
        base = f"https://github.com/{repo}/releases/download/v{version}"
        install.versions.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=install.prefix, prefix=".update-") as scratch:
            archive = Path(scratch) / asset
            try:
                expected = _fetch_checksum(f"{base}/{asset}.sha256")
                say(f"downloading {asset}")
                actual = _download(f"{base}/{asset}", archive, progress)
            except UpdateError as exc:
                if "answered 404" in str(exc):
                    raise UpdateError(
                        f"release v{version} has no {asset}; see "
                        f"https://github.com/{repo}/releases/tag/v{version}") from exc
                raise
            if actual != expected:
                raise UpdateError(f"{asset} does not match its sha256 - nothing was installed")
            say("checksum ok")
            tree = Path(scratch) / "tree"
            _extract(archive, tree)
            if not _has_program(tree):
                raise UpdateError(f"{asset} does not hold the circle program")
            os.replace(tree, target)
    previous = install.linked_version()
    _point_current(install, version)
    _prune(install, {version, install.running} | ({previous} if previous else set()))


# ── circle update ──────────────────────────────────────────────────────────


def _source_message(repo: str) -> str:
    root = Path(__file__).resolve().parent.parent
    if (root / ".git").exists():
        return (f"this copy runs from a git checkout ({root}). Update it with:\n"
                f"  git -C {root} pull\n  pip install -e {root}")
    return (f"this copy was installed with pip, not by the installer. Reinstall from "
            f"https://github.com/{repo}, or install the prebuilt program with:\n"
            f"  {installer_command(repo)}")


def _progress_printer() -> Callable[[int, int], None]:
    state = {"last": -1}

    def show(done: int, total: int) -> None:
        if not total or not sys.stdout.isatty():
            return
        pct = done * 100 // total
        if pct != state["last"]:
            state["last"] = pct
            print(f"\r  {pct}% of {total / 1e6:.1f} MB", end="", flush=True)
            if done >= total:
                print()

    return show


def update_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="circle update", description="Install the newest Circle release.")
    parser.add_argument("--check", action="store_true",
                        help="only say whether a newer release exists")
    parser.add_argument("--version", metavar="X.Y.Z",
                        help="install this release instead of the newest (also to go back)")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # a Windows code page must not stop an update
        try:
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass

    repo = os.environ.get("CIRCLE_REPO") or DEFAULT_REPO
    current = __version__
    pinned = bare_version(args.version) if args.version else ""
    if pinned and parse_version(pinned) is None:
        print(f"circle update: {args.version!r} is not a version like 0.2.0", file=sys.stderr)
        return 2
    try:
        target = pinned or latest_version(repo)
    except UpdateError as exc:
        print(f"circle update: {exc}", file=sys.stderr)
        return 1
    if not pinned:
        _write_cache(circle_home(), target, time.time())

    if args.check:
        if is_newer(target, current):
            print(f"circle {target} is available (you have {current}) - run `circle update`")
        else:
            print(f"circle {current} is up to date")
        return 0

    if not is_frozen():
        print(f"circle update: {_source_message(repo)}", file=sys.stderr)
        return 1
    install = find_install()
    if install is None:
        print(f"circle update: this copy was not put in place by the installer "
              f"({Path(sys.executable).resolve()}). Run the installer again:\n"
              f"  {installer_command(repo)}", file=sys.stderr)
        return 1

    if not pinned and not is_newer(target, current):
        print(f"circle {current} is up to date")
        return 0
    if target == install.linked_version():
        print(f"circle {target} is already installed - restart circle to use it"
              if target != current else f"circle {current} is up to date")
        return 0

    verb = "updating" if is_newer(target, current) else "installing"
    print(f"{verb} circle {current} to {target}")
    try:
        install_version(target, install, repo=repo, progress=_progress_printer(),
                        say=lambda msg: print(msg))
    except (UpdateError, OSError, http.client.HTTPException) as exc:
        print(f"circle update: {exc}", file=sys.stderr)
        return 1
    if not pinned:
        _write_cache(circle_home(), target, time.time())
    print(f"installed circle {target} - restart circle to use it")
    return 0
