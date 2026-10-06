"""/tree goes back to an earlier point of the same session; the next message branches
from there and both branches stay. /fork copies the history before a message into a new
session. Both read the session's checkpoints, so they work after a restart too."""

from __future__ import annotations

import time

from langchain_core.messages import AIMessage

from circle import session_index
from circle.harness import create_harness
from circle.ink.parse_keypress import KeyPress
from circle.testing import ScriptedModel
from circle.tui.conversation_tree import build_tree, row_text
from tests.test_tui_contract import _fake_session, plain


def _app(tmp_path, monkeypatch, answers=8):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 40  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        ScriptedModel(responses=[AIMessage(content=f"a{i}") for i in range(1, answers + 1)]),
        root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer)  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    return app


def _say(app, text: str) -> None:
    """A real turn through the bridge, as typing and enter would do."""
    app._on_submit(text)  # noqa: SLF001
    _wait_idle(app)


def _wait_idle(app) -> None:
    """Until the turn and everything queued after it have finished. Read under the app's
    lock, as the session changes this state: a queued message is taken from the queue and
    its turn marked busy while the lock is held, and a read without it can fall in between
    (on a slow machine it did) and see nothing left to do."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with app._app.lock:  # noqa: SLF001
            if not (app._bridge.is_running or app._is_loading or app._msg_queue):  # noqa: SLF001
                break
        time.sleep(0.02)
    assert not app._is_loading  # noqa: SLF001


def _history(app) -> list[str]:
    state = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
    return [str(m.content) for m in state.values.get("messages", [])]


def _keys(app, *keys):
    for key in keys:
        app._handle_key(KeyPress(key=key, char=key if len(key) == 1 else ""))  # noqa: SLF001


def _pick(app, text: str) -> None:
    for ch in text:
        _keys(app, ch)
    _keys(app, "enter")


def test_going_back_and_sending_again_keeps_both_branches(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2", "q3"):
        _say(app, q)
    assert _history(app) == ["q1", "a1", "q2", "a2", "q3", "a3"]
    app._dispatch_slash("tree", "")  # noqa: SLF001
    rows = plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    assert "› q2" in rows and "⏺ a3" in rows and "here" in rows
    _pick(app, "q2")
    shown = [plain(r) for r in app._transcript.snapshot()]  # noqa: SLF001
    assert " › q1" in shown and " ⏺ a1" in shown and not any("q3" in r for r in shown)
    assert app._prompt.value == "q2", "your message is back in the box"  # noqa: SLF001
    app._prompt.clear()  # noqa: SLF001
    _say(app, "q2 again, differently")
    assert _history(app) == ["q1", "a1", "q2 again, differently", "a4"]
    tree = build_tree(app._agent, app._thread_id)  # noqa: SLF001
    a1 = next(e for e in tree.entries.values() if e.text == "a1")
    assert sorted(tree.entries[k].text for k in a1.children) == ["q2", "q2 again, differently"]
    assert tree.entries[tree.leaf].text == "a4"


def test_esc_twice_on_an_empty_box_opens_the_tree(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    _keys(app, "escape", "escape")
    assert app._picker is not None and app._picker.title == "Session tree"  # noqa: SLF001


def test_the_point_gone_back_to_survives_reopening(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _pick(app, "a1")
    thread = app._thread_id  # noqa: SLF001
    assert session_index.find(app.home, thread).leaf
    app._dispatch_slash("new", "")  # noqa: SLF001
    assert app._open_saved(thread)  # noqa: SLF001
    shown = [plain(r) for r in app._transcript.snapshot()]  # noqa: SLF001
    assert " ⏺ a1" in shown and not any("q2" in r for r in shown)
    _say(app, "q2 instead")
    assert _history(app) == ["q1", "a1", "q2 instead", "a3"]
    assert not session_index.find(app.home, thread).leaf, "back at the latest again"


def test_the_first_message_starts_a_fresh_branch(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    first = app._thread_id  # noqa: SLF001
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _pick(app, "q1")
    assert app._thread_id != first and _history(app) == []  # noqa: SLF001
    assert app._prompt.value == "q1"  # noqa: SLF001


def test_labels_mark_entries_in_the_tree(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _keys(app, "L")
    for ch in "good":
        _keys(app, ch)
    _keys(app, "enter")
    assert "[good]" in plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001


def test_fork_picker_copies_what_came_before_a_message(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    first = app._thread_id  # noqa: SLF001
    app._dispatch_slash("fork", "")  # noqa: SLF001
    assert app._picker.title == "Fork from a message"  # noqa: SLF001
    _pick(app, "q2")
    assert app._thread_id != first and _history(app) == ["q1", "a1"]  # noqa: SLF001
    assert app._prompt.value == "q2"  # noqa: SLF001


def test_a_forked_session_has_a_tree_before_its_first_turn(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    app._dispatch_slash("clone", "")  # noqa: SLF001
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _pick(app, "a1")
    _say(app, "q2b")
    assert _history(app) == ["q1", "a1", "q2b", "a3"]


def test_going_back_past_a_shared_command_leaves_it_out(tmp_path, monkeypatch):
    from types import SimpleNamespace

    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    app._share_shell_output("echo hi", SimpleNamespace(output="hi", exit_code=0))  # noqa: SLF001
    assert _history(app)[-1].startswith("I ran this command myself")
    app._dispatch_slash("tree", "")  # noqa: SLF001
    assert "!echo hi" in plain("\n".join(app._picker.render_lines(100)))  # noqa: SLF001
    _pick(app, "a1")
    _say(app, "q2")
    assert _history(app) == ["q1", "a1", "q2", "a2"]


def test_words_after_tree_and_fork_search_the_list(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("first question", "second question"):
        _say(app, q)
    app._dispatch_slash("tree", "first")  # noqa: SLF001
    assert app._picker.query == "first"  # noqa: SLF001
    assert app._picker.focused().label.endswith("first question")  # noqa: SLF001
    _keys(app, "escape", "escape")
    app._dispatch_slash("fork", "second")  # noqa: SLF001
    _keys(app, "enter")
    assert _history(app) == ["first question", "a1"]
    assert app._prompt.value == "second question"  # noqa: SLF001


def test_messages_added_without_a_turn_go_after_the_point_gone_back_to(tmp_path, monkeypatch):
    from langchain_core.messages import HumanMessage

    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _pick(app, "a1")
    app._inject(HumanMessage(content="a skill's text"))  # noqa: SLF001 - /skill, /plan, !cmd
    assert _history(app) == ["q1", "a1", "a skill's text"]
    assert app._leaf_checkpoint is None  # noqa: SLF001


def test_forking_a_saved_session_takes_it_at_its_point(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    app._dispatch_slash("tree", "")  # noqa: SLF001
    _pick(app, "a1")
    saved = session_index.find(app.home, app._thread_id)  # noqa: SLF001
    app._fork_from_elsewhere(saved, into="copy-1")  # noqa: SLF001
    assert app._thread_id == "copy-1" and _history(app) == ["q1", "a1"]  # noqa: SLF001


def test_a_long_conversation_walks_without_recursion():
    from circle.tui.conversation_tree import ROOT, ConversationTree, TreeEntry

    entries = {}
    parent = ROOT
    for i in range(3000):
        key = f"m{i}"
        entries[key] = TreeEntry(key=key, role="user" if i % 2 == 0 else "assistant",
                                 text=key, parent=parent, order=i)
        if parent != ROOT:
            entries[parent].children.append(key)
        parent = key
    tree = ConversationTree(entries=entries, roots=["m0"], leaf="m2999")
    walked = tree.walk()
    assert len(walked) == 3000 and walked[-1] == ("m2999", 0)


def test_the_kept_tree_reads_only_what_is_new_and_matches_a_fresh_read(tmp_path, monkeypatch):
    from circle.tui.conversation_tree import TreeBuilder

    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    builder = TreeBuilder()
    builder.update(app._agent, app._thread_id)  # noqa: SLF001
    _say(app, "q2")
    reads: list = []
    real = app._agent.get_state  # noqa: SLF001
    monkeypatch.setattr(app._agent, "get_state", lambda config: reads.append(config) or real(config))  # noqa: SLF001
    builder.update(app._agent, app._thread_id)  # noqa: SLF001
    assert len(reads) <= 2, "only the turn added since"
    kept = builder.tree(app._agent, app._thread_id)  # noqa: SLF001
    fresh = build_tree(app._agent, app._thread_id)  # noqa: SLF001
    assert {k: (e.text, e.parent, e.resume_from) for k, e in kept.entries.items()} == \
        {k: (e.text, e.parent, e.resume_from) for k, e in fresh.entries.items()}


def test_esc_that_clears_text_does_not_count_toward_esc_esc(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    _say(app, "q1")
    for ch in "draft":
        _keys(app, ch)
    _keys(app, "escape", "escape")
    assert app._prompt.value == "" and app._picker is None  # noqa: SLF001
    _keys(app, "escape")
    assert app._picker is not None, "the box was empty for this pair"  # noqa: SLF001


def test_rows_show_the_words_without_markdown():
    text = ("## Fixed\n- **`remove`** now checks [the index](https://x.example/a) and returns\n"
            "> quoted\n```python\ncode_here()\n```")
    assert row_text(text) == "Fixed remove now checks the index and returns quoted code_here()"
    assert row_text("keep snake_case and __init__.py and 2*3") == \
        "keep snake_case and __init__.py and 2*3"


def test_a_long_answer_leaves_the_here_column_on_screen(tmp_path, monkeypatch):
    long = "**Done.** The `remove` command now " + "checks the index and explains the error " * 6
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 40  # noqa: SLF001
    app._agent = create_harness(  # noqa: SLF001
        ScriptedModel(responses=[AIMessage(content=long)]),
        root_dir=app.workspace, home=app.home, checkpointer=app._checkpointer)  # noqa: SLF001
    app._bridge = app._make_bridge()  # noqa: SLF001
    _say(app, "fix remove")
    app._dispatch_slash("tree", "")  # noqa: SLF001
    rows = [plain(r) for r in app._picker.render_lines(80)]  # noqa: SLF001
    answer = next(r for r in rows if "⏺" in r)
    assert answer.rstrip().endswith("here · current") and "…" in answer
    assert "**" not in answer and "`" not in answer
