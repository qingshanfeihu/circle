"""read_file-style checks must accept ~/.circle/... and still reject traversal."""

from pathlib import Path

import pytest

from circle.host_paths import install_tilde_expansion
from circle_harness import sandbox_backend


def test_tilde_skill_path_passes_the_tool_check_and_reads(tmp_path, monkeypatch):
    home = tmp_path / "home"
    skill = home / ".circle" / "skills" / "compile-excel"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: compile-excel\n", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))

    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem

    validated = filesystem.validate_path("~/.circle/skills/compile-excel/SKILL.md")
    assert validated == (skill / "SKILL.md").as_posix()

    backend = sandbox_backend(tmp_path / "ws")
    result = backend.read(validated, limit=1)
    assert result.error is None
    assert result.file_data is not None
    assert result.file_data["content"].startswith("---")


def test_tilde_parent_is_still_traversal(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem

    with pytest.raises(ValueError, match="traversal"):
        filesystem.validate_path("~/../secret")


def test_plain_parent_is_still_traversal():
    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem

    with pytest.raises(ValueError, match="traversal"):
        filesystem.validate_path("../etc/passwd")


@pytest.mark.parametrize("path", [r"C:\Users\me\file.txt", "D:/work/file.txt"])
def test_windows_drive_paths_keep_their_drive(path, monkeypatch):
    import circle.host_paths as host_paths
    monkeypatch.setattr(host_paths.sys, "platform", "win32")
    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem
    assert filesystem.validate_path(path) == path.replace("\\", "/")


@pytest.mark.parametrize("path", [r"C:\work\..\secret", "D:/work/../secret"])
def test_windows_drive_paths_still_reject_traversal(path, monkeypatch):
    import circle.host_paths as host_paths
    monkeypatch.setattr(host_paths.sys, "platform", "win32")
    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem
    with pytest.raises(ValueError, match="traversal"):
        filesystem.validate_path(path)


def test_windows_drive_paths_enforce_allowed_prefixes(monkeypatch):
    import circle.host_paths as host_paths
    monkeypatch.setattr(host_paths.sys, "platform", "win32")
    install_tilde_expansion()
    import deepagents.middleware.filesystem as filesystem
    assert filesystem.validate_path("C:/work/file.txt", allowed_prefixes=["C:/work/"]) == "C:/work/file.txt"
    with pytest.raises(ValueError, match="start with"):
        filesystem.validate_path("C:/other/file.txt", allowed_prefixes=["C:/work/"])
