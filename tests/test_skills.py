"""Skill discovery and skill tool."""

from __future__ import annotations

from pathlib import Path

from circle.skills import (
    discover_skills,
    load_skill_body,
    skill_source_dirs,
    skill_sources,
)


def _write_skill(root: Path, name: str, description: str) -> Path:
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\nDo it.\n",
        encoding="utf-8",
    )
    return d


def test_skill_sources_cover_agent_skills_layout(tmp_path: Path, monkeypatch):
    user_home = tmp_path / "uhome"
    circle_home = tmp_path / "chome"
    ws = tmp_path / "ws"
    (user_home / ".agents" / "skills").mkdir(parents=True)
    (user_home / ".claude" / "skills").mkdir(parents=True)
    (circle_home / "skills").mkdir(parents=True)
    (ws / ".agent" / "skills").mkdir(parents=True)
    (ws / ".agents" / "skills").mkdir(parents=True)
    (ws / ".circle" / "skills").mkdir(parents=True)
    (ws / ".git").mkdir()

    sources = skill_sources(ws, circle_home, user_home=user_home)
    labels = [label for _, label in sources]
    paths = [Path(p) for p, _ in sources]
    assert "Agents" in labels
    assert "Claude" in labels
    assert "Circle" in labels
    assert "Project" in labels
    assert any(p.name == "skills" and p.parent.name == ".agent" for p in paths)
    # Later project sources still present
    assert skill_source_dirs(ws, circle_home, user_home=user_home)


def test_discover_and_load_skill(tmp_path: Path):
    home = tmp_path / "home"
    ws = tmp_path / "ws"
    uh = tmp_path / "uhome"
    uh.mkdir()
    _write_skill(home / "skills", "pack", "Pack things carefully")
    _write_skill(ws / ".agent" / "skills", "pack", "Project pack overrides user")
    skills = discover_skills(ws, home, user_home=uh)
    assert len(skills) == 1
    assert skills[0].name == "pack"
    assert skills[0].source_label == "Project"
    body = load_skill_body("pack", skills=skills)
    assert '<skill_content name="pack">' in body
    assert "Project pack overrides" in body
    assert not body.startswith("Error:")


def test_nested_agents_grouping_folder(tmp_path: Path):
    home = tmp_path / "home"
    uh = tmp_path / "uhome"
    uh.mkdir()
    group = home / "skills" / "devtools"
    _write_skill(group, "lint-fix", "Format with the project linter")
    skills = discover_skills(None, home, user_home=uh)
    names = {s.name for s in skills}
    assert "lint-fix" in names


def test_folded_description_frontmatter(tmp_path: Path):
    home = tmp_path / "home"
    uh = tmp_path / "uhome"
    uh.mkdir()
    d = home / "skills" / "fold"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\nname: fold\ndescription: >\n  First line of desc\n  second line.\n---\n\n# Fold\n",
        encoding="utf-8",
    )
    skills = discover_skills(None, home, user_home=uh)
    assert len(skills) == 1
    assert "First line of desc" in skills[0].description
    assert skills[0].description.strip() != ">"


def test_discover_from_shared_agents_skills(tmp_path: Path):
    """skills.sh / amp / cursor install into ~/.agents/skills — Circle must see them."""
    uh = tmp_path / "uhome"
    shared = uh / ".agents" / "skills"
    _write_skill(shared, "shared-pack", "Installed via skills CLI")
    skills = discover_skills(None, tmp_path / "chome", user_home=uh)
    assert {s.name for s in skills} == {"shared-pack"}
    assert skills[0].source_label == "Agents"
