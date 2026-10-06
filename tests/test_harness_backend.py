"""The harness uses the framework sandbox backend and adds no file tools."""

from pathlib import Path

import pytest

from circle.sandbox import CircleSandboxBackend, is_host_absolute_path, shell_environment
from circle_harness import sandbox_backend
from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import SandboxBackendProtocol


def test_backend_is_the_framework_local_sandbox(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    assert isinstance(backend, CircleSandboxBackend)
    assert isinstance(backend, LocalShellBackend)
    assert isinstance(backend, SandboxBackendProtocol)
    assert backend.virtual_mode is True
    # 模型跑的命令拿到用户环境去掉机密名后的副本（见 tests/test_shell_environment.py）
    assert backend._env == shell_environment(workspace=tmp_path)
    assert not any("API_KEY" in k or k.endswith("_TOKEN") for k in backend._env)


def test_filesystem_paths_stay_inside_the_root(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    written = backend.write("/note.txt", "circle")
    assert written.error is None
    assert (tmp_path / "note.txt").read_text(encoding="utf-8") == "circle"
    with pytest.raises(ValueError, match="Path traversal not allowed"):
        backend.read("/../note.txt")


def test_host_absolute_path_detector():
    assert is_host_absolute_path("/Users/me/Public/InfoTest_Engine")
    assert is_host_absolute_path("~/Documents/x")
    assert is_host_absolute_path("/tmp/foo")
    assert is_host_absolute_path("/etc/hosts")
    assert not is_host_absolute_path("/note.txt")
    assert not is_host_absolute_path("/src/app.py")
    assert not is_host_absolute_path("relative/path")


def test_host_absolute_paths_are_not_remapped_under_workspace(tmp_path: Path):
    """Host absolute paths must not be remapped under the workspace."""
    backend = sandbox_backend(tmp_path)
    outside = tmp_path.parent / "circle_host_abs_probe"
    outside.mkdir(exist_ok=True)
    target = outside / "hello.txt"
    target.write_text("from-host", encoding="utf-8")

    host_key = str(target)
    assert is_host_absolute_path(host_key)

    # Old virtual_mode bug would look under tmp_path/Users/... and miss.
    ghost = tmp_path / target.as_posix().replace(":", "").lstrip("/")
    assert not ghost.exists()

    result = backend.read(host_key)
    assert result.error is None
    assert result.file_data is not None
    assert "from-host" in result.file_data["content"]


def test_host_absolute_ls_lists_real_directory(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    outside = tmp_path.parent / "circle_host_ls_probe"
    outside.mkdir(exist_ok=True)
    (outside / "a.txt").write_text("a", encoding="utf-8")

    listed = backend.ls(str(outside))
    assert listed.error is None
    paths = [e["path"] for e in (listed.entries or [])]
    assert any(p.endswith("a.txt") or p.endswith("/a.txt") for p in paths)


def test_offloaded_files_are_kept_in_the_data_folder(tmp_path: Path):
    """Summaries' history and very long tool results keep their paths for the model but
    are written to the data folder, so the project gets no conversation_history/ or
    large_tool_results/ of Circle's."""
    from circle.paths import project_data_dir

    ws, home = tmp_path / "ws", tmp_path / "home"
    ws.mkdir()
    backend = sandbox_backend(ws, home=home)
    kept = project_data_dir(ws, home)
    assert backend.write("/conversation_history/s1.md", "older messages").error is None
    assert backend.write("large_tool_results/call_1", "x" * 10).error is None
    assert (kept / "conversation_history" / "s1.md").read_text() == "older messages"
    assert (kept / "large_tool_results" / "call_1").is_file()
    assert list(ws.iterdir()) == []
    assert "older messages" in backend.read("/conversation_history/s1.md").file_data["content"]
    listed = backend.ls("/conversation_history")
    assert [e["path"] for e in listed.entries or []] == ["/conversation_history/s1.md"]
    found = backend.grep("older", path="/conversation_history")
    assert [m["path"] for m in found.matches or []] == ["/conversation_history/s1.md"]
    assert backend.ls("/").entries == []
    with pytest.raises(ValueError, match="Path traversal not allowed"):
        backend.read("/conversation_history/../../escape")
    # A project file of the same name elsewhere in the tree stays in the project
    assert backend.write("/src/conversation_history/a.md", "mine").error is None
    assert (ws / "src" / "conversation_history" / "a.md").is_file()


def test_plan_mode_still_lets_circle_keep_its_own_files(tmp_path: Path):
    backend = sandbox_backend(tmp_path / "ws", plan_mode=True, home=tmp_path / "home")
    (tmp_path / "ws").mkdir()
    assert backend.write("/notes.md", "x").error  # a project file: refused in plan mode
    assert backend.write("/conversation_history/s1.md", "older").error is None


def test_each_project_has_its_own_data_folder(tmp_path: Path):
    from circle.paths import project_data_dir

    one, two = tmp_path / "a" / "app", tmp_path / "b" / "app"
    assert project_data_dir(one, tmp_path) != project_data_dir(two, tmp_path)
    assert project_data_dir(one, tmp_path).name.startswith("app-")
    assert project_data_dir(one, tmp_path).parent == tmp_path / "projects"
