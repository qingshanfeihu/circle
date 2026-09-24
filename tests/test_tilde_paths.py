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
