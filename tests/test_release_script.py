"""scripts/release.py, and the rule it enforces on the repository itself."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("release_script", ROOT / "scripts" / "release.py")
release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(release)

CHANGELOG = """# Changelog

Intro.

## Unreleased

### Added

- A thing.

## 0.1.0 - 2026-09-22

First release.
"""


def _repo(tmp_path: Path, *, changelog: str = CHANGELOG, init: str = "0.1.0") -> Path:
    (tmp_path / "circle").mkdir()
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "circle"\nversion = "0.1.0"\n')
    (tmp_path / "circle" / "__init__.py").write_text(f'"""Circle."""\n\n__version__ = "{init}"\n')
    (tmp_path / "CHANGELOG.md").write_text(changelog)
    return tmp_path


def test_the_repository_keeps_its_version_in_step():
    """AGENTS.md: the version is in two places. The newest dated changelog heading is the same."""
    versions = release.read_versions(ROOT)
    assert len(set(versions.values())) == 1, versions
    log = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert release.newest_released(log) == next(iter(versions.values()))


def test_bump_edits_the_three_files(tmp_path: Path):
    root = _repo(tmp_path)
    release.bump("0.2.0", root, today="2026-10-01")
    assert release.read_versions(root) == {"pyproject.toml": "0.2.0", "circle/__init__.py": "0.2.0"}
    log = (root / "CHANGELOG.md").read_text()
    assert "## Unreleased\n\n## 0.2.0 - 2026-10-01\n\n### Added" in log
    assert release.changelog_section(log, "0.2.0").startswith("### Added")
    assert release.changelog_section(log, "0.1.0") == "First release."
    release.check("0.2.0", root)  # what CI runs on the tag


def test_bump_refuses_what_is_not_a_release(tmp_path: Path):
    root = _repo(tmp_path)
    for bad in ("0.1.0", "0.0.9", "1.0", "v1"):
        with pytest.raises(release.ReleaseError):
            release.bump(bad, root)
    assert release.read_versions(root)["pyproject.toml"] == "0.1.0"  # nothing was written


def test_bump_refuses_an_empty_unreleased_section(tmp_path: Path):
    root = _repo(tmp_path, changelog="# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-09-22\n\nx\n")
    with pytest.raises(release.ReleaseError, match="empty"):
        release.bump("0.2.0", root)


def test_bump_refuses_when_the_two_files_disagree(tmp_path: Path):
    root = _repo(tmp_path, init="0.0.5")
    with pytest.raises(release.ReleaseError, match="disagree"):
        release.bump("0.2.0", root)


def test_check_names_the_mismatch(tmp_path: Path):
    root = _repo(tmp_path)
    with pytest.raises(release.ReleaseError, match=r"pyproject.toml says 0.1.0, the tag says 0.3.0"):
        release.check("0.3.0", root)
    (root / "circle" / "__init__.py").write_text('__version__ = "0.2.0"\n')
    with pytest.raises(release.ReleaseError, match=r"__init__.py says 0.2.0"):
        release.check("0.1.0", root)


def test_check_needs_a_changelog_section(tmp_path: Path):
    root = _repo(tmp_path)
    (root / "pyproject.toml").write_text('version = "0.2.0"\n')
    (root / "circle" / "__init__.py").write_text('__version__ = "0.2.0"\n')
    with pytest.raises(release.ReleaseError, match="no '## 0.2.0' section"):
        release.check("0.2.0", root)
