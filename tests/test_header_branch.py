"""The header names the git branch, and the terminal's title names the session, as pi's do."""

from __future__ import annotations

from circle.git_info import current_branch
from tests.test_plan_and_turns import _fake_session
from tests.test_tui_contract import plain


def test_the_branch_is_read_from_git_head(tmp_path):
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / "src").mkdir()
    (repo / ".git" / "HEAD").write_text("ref: refs/heads/feature/x\n", encoding="utf-8")
    assert current_branch(repo / "src") == "feature/x"
    (repo / ".git" / "HEAD").write_text("0123456789abcdef\n", encoding="utf-8")
    assert current_branch(repo) == "0123456"
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (tmp_path / "gitdir").mkdir()
    (tmp_path / "gitdir" / "HEAD").write_text("ref: refs/heads/side\n", encoding="utf-8")
    (worktree / ".git").write_text(f"gitdir: {tmp_path / 'gitdir'}\n", encoding="utf-8")
    assert current_branch(worktree) == "side"
    assert current_branch(tmp_path / "gitdir") == ""


def test_header_and_title(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    (app.workspace / ".git").mkdir()
    (app.workspace / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    titles: list[str] = []
    app._app.set_title = titles.append  # noqa: SLF001
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    app._branch_cache = None  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert plain(app._header_text.value).split("  ")[0].endswith("ws (main)")  # noqa: SLF001
    assert titles[-1] == "circle - ws"
    app._dispatch_slash("name", "fix login")  # noqa: SLF001
    app._sync_dialog_frame()  # noqa: SLF001
    assert titles[-1] == "circle - fix login - ws"
    count = len(titles)
    app._sync_dialog_frame()  # noqa: SLF001
    assert len(titles) == count, "written only when it changes"


def test_the_resume_command_is_printed_for_a_saved_session(tmp_path, monkeypatch):
    from circle import session_index
    from circle.run_options import RunOptions

    app = _fake_session(tmp_path, monkeypatch)
    assert app._resume_hint() == "", "nothing was said yet"  # noqa: SLF001
    session_index.record(app.home, app._thread_id, app.workspace, title="x")  # noqa: SLF001
    monkeypatch.chdir(app.workspace)
    assert app._resume_hint() == f"To resume this session: circle --session {app._thread_id}"  # noqa: SLF001
    monkeypatch.chdir(tmp_path)
    assert app._resume_hint().endswith(f"--session {app._thread_id} {app.workspace}")  # noqa: SLF001
    app._run_options = RunOptions(no_session=True)  # noqa: SLF001
    assert app._resume_hint() == ""  # noqa: SLF001


def test_the_title_comes_back_after_the_shell_or_an_editor(tmp_path):
    from circle.ink.app import InkApp

    app = InkApp(alt_screen=False)
    written: list[str] = []
    app._terminal = type("T", (), {  # noqa: SLF001
        "write": lambda self, data: written.append(data),
        "set_raw_mode": lambda self, on: None, "columns": 80, "rows": 24})()
    app._running = True  # noqa: SLF001
    app.set_title("circle - ws")
    app.suspend_for_external()
    assert written[-1].endswith("\x1b[23;0t"), "the shell gets its own title back"
    app.resume_from_external()
    assert any("\x1b[22;0t\x1b]0;circle - ws\x07" in w for w in written)
