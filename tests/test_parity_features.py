"""Parity features: apply_patch, commands, session tree, plan gate, skills paths."""

from __future__ import annotations

from pathlib import Path

from circle.apply_patch import apply_patch_text
from circle.commands import discover_custom_commands, expand_command_template
from circle.mcp_loader import build_mcp_connections, format_mcp_status
from circle.plan_backend import PlanGuardedBackend
from circle.session_tree import SessionTree
from circle.skills import discover_skills, skill_sources
from circle.tui.slash_commands import parse_slash


def test_apply_patch_add_update_delete(tmp_path: Path):
    ws = tmp_path / "ws"
    ws.mkdir()
    patch = """\
*** Begin Patch
*** Add File: hello.txt
+Hello
*** End Patch
"""
    assert "OK" in apply_patch_text(ws, patch)
    assert (ws / "hello.txt").read_text() == "Hello\n"

    (ws / "hello.txt").write_text("Hello\nWorld\n", encoding="utf-8")
    patch2 = """\
*** Begin Patch
*** Update File: hello.txt
@@
-Hello
+Hi
*** End Patch
"""
    assert "OK" in apply_patch_text(ws, patch2)
    assert "Hi" in (ws / "hello.txt").read_text()

    patch3 = """\
*** Begin Patch
*** Delete File: hello.txt
*** End Patch
"""
    assert "deleted" in apply_patch_text(ws, patch3)
    assert not (ws / "hello.txt").exists()


def test_plan_backend_blocks_mutations(tmp_path: Path):
    backend = PlanGuardedBackend(root_dir=tmp_path, virtual_mode=True, plan_mode=True)
    wr = backend.write("src/a.py", "x=1\n")
    assert wr.error and "Plan mode" in wr.error
    ok = backend.write("plan.md", "# Plan\n")
    assert ok.error is None
    er = backend.execute("echo hi")
    assert er.exit_code == 1
    assert "Plan mode" in er.output
    (tmp_path / "bye.txt").write_text("x", encoding="utf-8")
    dr = backend.delete("bye.txt")
    assert dr.error and "Plan mode" in dr.error
    assert (tmp_path / "bye.txt").exists()


def test_custom_commands_discovery_and_expand(tmp_path: Path):
    home = tmp_path / "home"
    cmds = home / "commands"
    cmds.mkdir(parents=True)
    (cmds / "greet.md").write_text(
        "---\ndescription: Say hi\n---\nHello $1 from $ARGUMENTS\n",
        encoding="utf-8",
    )
    found = discover_custom_commands(None, home)
    assert {c.name for c in found} == {"greet"}
    assert "Hello Bob from Bob" in expand_command_template(
        found[0].template, "Bob", cwd=tmp_path
    )


def test_session_tree_fork_clone():
    tree = SessionTree()
    a = tree.add("user", "one")
    tree.add("assistant", "reply1")
    tree.add("user", "two")
    mid = a.id
    # branch from first user by jumping and adding
    assert tree.jump(mid)
    tree.add("user", "alt")
    kids = tree.children_of(mid)
    assert len(kids) >= 1
    forked = tree.fork_from(mid)
    assert forked is not None
    assert len(forked.path_to()) >= 1
    cloned = tree.clone_active()
    assert cloned.active_id is not None


def test_skill_colon_slash_and_opencode_paths(tmp_path: Path):
    parsed = parse_slash("/skill:brave-search query=x")
    assert parsed is not None
    assert parsed.name == "skill"
    assert parsed.args.startswith("brave-search")
    assert "query=x" in parsed.args

    uh = tmp_path / "uhome"
    oc = uh / ".config" / "opencode" / "skills" / "demo"
    oc.mkdir(parents=True)
    (oc / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo skill\n---\n\n# Demo\n",
        encoding="utf-8",
    )
    pi = uh / ".pi" / "agent" / "skills" / "pi-demo"
    pi.mkdir(parents=True)
    (pi / "SKILL.md").write_text(
        "---\nname: pi-demo\ndescription: Pi demo\n---\n\n# Pi\n",
        encoding="utf-8",
    )
    sources = skill_sources(None, tmp_path / "chome", user_home=uh)
    labels = {label for _, label in sources}
    assert "OpenCode" in labels
    assert "Pi" in labels
    skills = discover_skills(None, tmp_path / "chome", user_home=uh)
    assert {s.name for s in skills} >= {"demo", "pi-demo"}


def test_mcp_connection_mapping_and_status():
    conns = build_mcp_connections(
        [
            {"name": "mem", "command": "npx", "args": ["-y", "foo"]},
            {"name": "remote", "url": "http://127.0.0.1:9/sse", "transport": "sse"},
        ]
    )
    assert conns["mem"]["transport"] == "stdio"
    assert conns["remote"]["transport"] == "sse"
    text = format_mcp_status([{"name": "mem", "command": "npx"}], tools=[])
    assert "mem" in text


def test_slash_tree_fork_aliases():
    assert parse_slash("/tree abc").name == "tree"
    assert parse_slash("/fork").name == "fork"
    assert parse_slash("/clone").name == "clone"
