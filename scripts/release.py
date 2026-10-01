#!/usr/bin/env python3
"""Cut a release. The version lives in `pyproject.toml` and `circle/__init__.py`, and the
changelog names it; this script keeps the three in step so a tag can be built from them.

    python scripts/release.py 0.2.0           bump both files and date the Unreleased section
    python scripts/release.py --check 0.2.0   CI: the tag, both files and the changelog agree
    python scripts/release.py --notes 0.2.0   print that version's changelog section

It edits files and prints the commands to run next. It does not commit, tag or push.
"""

from __future__ import annotations

import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = Path("pyproject.toml")
INIT = Path("circle/__init__.py")
CHANGELOG = Path("CHANGELOG.md")

_SEMVER = re.compile(r"^\d+\.\d+\.\d+$")
_PYPROJECT_VERSION = re.compile(r'(?m)^(version\s*=\s*")([^"]+)(")')
_INIT_VERSION = re.compile(r'(?m)^(__version__\s*=\s*")([^"]+)(")')


class ReleaseError(Exception):
    pass


def _version_tuple(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


def read_versions(root: Path = ROOT) -> dict[str, str]:
    found = {}
    for name, path, pattern in (("pyproject.toml", PYPROJECT, _PYPROJECT_VERSION),
                                ("circle/__init__.py", INIT, _INIT_VERSION)):
        match = pattern.search((root / path).read_text(encoding="utf-8"))
        if not match:
            raise ReleaseError(f"no version found in {name}")
        found[name] = match.group(2)
    return found


def changelog_section(text: str, version: str) -> str | None:
    """The body under `## <version> - <date>`, up to the next `## ` heading."""
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines)
                  if re.match(rf"^## {re.escape(version)}(\s+-\s+.*)?$", line)), None)
    if start is None:
        return None
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")), len(lines))
    return "\n".join(lines[start + 1:end]).strip()


def newest_released(text: str) -> str | None:
    """The first dated version heading in the changelog (`Unreleased` does not count)."""
    match = re.search(r"(?m)^## (\d+\.\d+\.\d+)\b", text)
    return match.group(1) if match else None


def check(version: str, root: Path = ROOT) -> None:
    if not _SEMVER.match(version):
        raise ReleaseError(f"{version!r} is not a version like 0.2.0")
    for name, have in read_versions(root).items():
        if have != version:
            raise ReleaseError(f"{name} says {have}, the tag says {version}")
    section = changelog_section((root / CHANGELOG).read_text(encoding="utf-8"), version)
    if section is None:
        raise ReleaseError(f"CHANGELOG.md has no '## {version}' section")
    if not section:
        raise ReleaseError(f"the '## {version}' section of CHANGELOG.md is empty")


def _dirty(root: Path) -> list[str]:
    if not (root / ".git").exists():
        return []
    out = subprocess.run(
        ["git", "status", "--porcelain", "--", str(PYPROJECT), str(INIT), str(CHANGELOG)],
        cwd=root, capture_output=True, text=True, check=False).stdout
    return [line for line in out.splitlines() if line.strip()]


def bump(version: str, root: Path = ROOT, today: str | None = None) -> None:
    if not _SEMVER.match(version):
        raise ReleaseError(f"{version!r} is not a version like 0.2.0")
    versions = read_versions(root)
    if len(set(versions.values())) != 1:
        raise ReleaseError(f"the two version files disagree: {versions}")
    current = next(iter(versions.values()))
    if _version_tuple(version) <= _version_tuple(current):
        raise ReleaseError(f"{version} is not newer than {current}")
    dirty = _dirty(root)
    if dirty:
        raise ReleaseError("these files have uncommitted changes; commit or stash them first:\n  "
                           + "\n  ".join(dirty))
    log = (root / CHANGELOG).read_text(encoding="utf-8")
    heading = re.search(r"(?m)^## Unreleased[ \t]*$", log)
    if not heading:
        raise ReleaseError("CHANGELOG.md has no '## Unreleased' section")
    following = re.search(r"(?m)^## ", log[heading.end():])
    body = log[heading.end():heading.end() + following.start()] if following else log[heading.end():]
    if not body.strip():
        raise ReleaseError("the Unreleased section of CHANGELOG.md is empty; nothing to release")
    date = today or datetime.date.today().isoformat()
    log = log[:heading.start()] + f"## Unreleased\n\n## {version} - {date}" + log[heading.end():]
    (root / CHANGELOG).write_text(log, encoding="utf-8")
    for path, pattern in ((PYPROJECT, _PYPROJECT_VERSION), (INIT, _INIT_VERSION)):
        text = (root / path).read_text(encoding="utf-8")
        (root / path).write_text(pattern.sub(rf"\g<1>{version}\g<3>", text, count=1), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("version", help="the version, for example 0.2.0")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="verify instead of editing")
    mode.add_argument("--notes", action="store_true", help="print the changelog section")
    args = parser.parse_args(argv)
    version = args.version.removeprefix("v")
    try:
        if args.check:
            check(version)
            print(f"ok: {version}")
        elif args.notes:
            section = changelog_section((ROOT / CHANGELOG).read_text(encoding="utf-8"), version)
            if not section:
                raise ReleaseError(f"CHANGELOG.md has no '## {version}' section")
            print(section)
        else:
            bump(version)
            print(f"Set {version} in pyproject.toml, circle/__init__.py and CHANGELOG.md.\n\n"
                  "Read the diff, run the tests, then:\n\n"
                  "  git add pyproject.toml circle/__init__.py CHANGELOG.md\n"
                  f'  git commit -m "Release {version}"\n'
                  f"  git tag v{version}\n"
                  f"  git push origin main v{version}\n\n"
                  "The push of the tag starts the release workflow.")
    except ReleaseError as exc:
        print(f"release: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
