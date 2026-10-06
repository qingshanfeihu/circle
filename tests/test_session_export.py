"""/export html and jsonl, /import of a JSONL export, and ``circle --export``."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle import cli
from circle.session_export import SessionMeta, export_kind, from_jsonl, to_html, to_jsonl
from tests.test_cli_options import _ready, _recording
from tests.test_conversation_tree import _app, _history, _say
from tests.test_tui_contract import plain

CONVERSATION = [
    HumanMessage(content="look at <main.py>", id="h1"),
    AIMessage(content="", id="a1", tool_calls=[
        {"name": "read_file", "args": {"file_path": "/main.py"}, "id": "c1"}]),
    ToolMessage(content="print('hi')", tool_call_id="c1", id="t1"),
    AIMessage(content="It prints **hi**:\n\n```python\nprint('hi')\n```", id="a2"),
]


def test_jsonl_keeps_every_message_and_html_is_readable():
    meta = SessionMeta(thread_id="circle-1", title="demo", workspace="/w", model="m")
    header, back = from_jsonl(to_jsonl(CONVERSATION, meta))
    assert header["title"] == "demo" and header["id"] == "circle-1"
    assert [type(m).__name__ for m in back] == ["HumanMessage", "AIMessage", "ToolMessage",
                                                "AIMessage"]
    assert back[1].tool_calls[0]["args"] == {"file_path": "/main.py"}
    page = to_html(CONVERSATION, meta)
    assert "look at &lt;main.py&gt;" in page and "<strong>hi</strong>" in page
    assert "<summary>● read_file(/main.py)</summary>" in page and "print(&#x27;hi&#x27;)" in page
    assert export_kind("notes.HTML") == "html" and export_kind("x.jsonl") == "jsonl"
    assert export_kind("out.md") == "md" and export_kind("html") == "html"


def test_export_jsonl_then_import_it_as_a_new_session(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    for q in ("q1", "q2"):
        _say(app, q)
    first = app._thread_id  # noqa: SLF001
    out = tmp_path / "saved.jsonl"
    app._dispatch_slash("export", str(out))  # noqa: SLF001
    page = tmp_path / "saved.html"
    app._dispatch_slash("export", str(page))  # noqa: SLF001
    assert "q2" in page.read_text(encoding="utf-8")
    app._dispatch_slash("new", "")  # noqa: SLF001
    app._dispatch_slash("import", str(out))  # noqa: SLF001
    assert app._thread_id != first  # noqa: SLF001
    assert _history(app) == ["q1", "a1", "q2", "a2"]
    shown = [plain(r) for r in app._transcript.snapshot()]  # noqa: SLF001
    assert " › q2" in shown and " ⏺ a2" in shown
    app._dispatch_slash("import", str(page))  # noqa: SLF001
    assert _history(app) != [], "an HTML file is read as text, as before"


def test_a_file_that_is_not_an_export_is_refused(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    bad = tmp_path / "bad.jsonl"
    bad.write_text('{"hello": 1}\n', encoding="utf-8")
    thread = app._thread_id  # noqa: SLF001
    app._dispatch_slash("import", str(bad))  # noqa: SLF001
    assert app._thread_id == thread  # noqa: SLF001
    assert any("not a Circle JSONL export" in plain(r) for r in app._transcript.snapshot())  # noqa: SLF001


def test_circle_export_writes_a_saved_session(tmp_path, monkeypatch, capsys):
    home, ws = _ready(tmp_path, monkeypatch, _recording(("the answer",)))
    assert cli.main(["-p", "the question", str(ws), "--session-id", "job"]) == 0
    capsys.readouterr()
    out = tmp_path / "job.html"
    assert cli.main(["--export", "job", str(out)]) == 0
    page = out.read_text(encoding="utf-8")
    assert "the question" in page and "the answer" in page
    assert cli.main(["--export", "nope"]) == 2


def test_files_that_cannot_be_read_or_written_are_errors_not_crashes(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)
    blob = tmp_path / "blob.bin"
    blob.write_bytes(b"\xff\xfe\x00bad")
    odd = tmp_path / "odd.jsonl"
    odd.write_text('{"type": "ai", "data": [1]}\n', encoding="utf-8")
    app._dispatch_slash("import", str(blob))  # noqa: SLF001
    app._dispatch_slash("import", str(odd))  # noqa: SLF001
    app._dispatch_slash("export", "/no_such_root_here/x.md")  # noqa: SLF001
    shown = "\n".join(plain(r) for r in app._transcript.snapshot())  # noqa: SLF001
    assert "blob.bin is not a text file" in shown
    assert "odd.jsonl is not a Circle JSONL export" in shown
    assert "Could not write /no_such_root_here/x.md" in shown


def test_a_command_that_raises_is_reported_and_the_session_goes_on(tmp_path, monkeypatch):
    app = _app(tmp_path, monkeypatch)

    def boom(_args):
        raise RuntimeError("kaput")

    monkeypatch.setattr(app, "_cmd_copy", boom)
    app._dispatch_slash("copy", "")  # noqa: SLF001
    assert any("/copy failed: RuntimeError: kaput" in plain(r) for r in app._transcript.snapshot())  # noqa: SLF001
