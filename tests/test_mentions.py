"""``@path``: tab completes it in the input box, and sending attaches the file for the
model while the screen keeps the message as typed."""

from __future__ import annotations

from circle.ink.parse_keypress import KeyPress
from circle.mentions import MAX_ATTACH_BYTES, attach_files, complete
from tests.test_tui_contract import _fake_session, plain


def _tree(root):
    (root / "src" / "util").mkdir(parents=True)
    (root / "src" / "stats.py").write_text("def mean(xs):\n    return sum(xs) / len(xs)\n")
    (root / "src" / "util" / "strings.py").write_text("X = 1\n")
    (root / "README.md").write_text("# demo\n")
    (root / ".git").mkdir()
    (root / ".git" / "stats_cache").write_text("no")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "stats.js").write_text("no")


def test_attach_adds_each_mentioned_file_once(tmp_path):
    _tree(tmp_path)
    text = attach_files("explain @src/stats.py, then @src/stats.py again", tmp_path)
    assert text.startswith("explain @src/stats.py, then @src/stats.py again\n\n")
    assert text.count('<file path="src/stats.py">') == 1 and "return sum(xs)" in text


def test_attach_leaves_out_what_it_should_not_read(tmp_path):
    _tree(tmp_path)
    (tmp_path / "big.txt").write_text("x" * (MAX_ATTACH_BYTES + 1))
    (tmp_path / "image.bin").write_bytes(b"\xff\xfe\x00\x81")
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("secret")
    for text in ("see @big.txt", "see @image.bin", f"see @../{outside.name}", "see @missing.py",
                 "mail me@example.com", "@decorator in python"):
        assert attach_files(text, tmp_path) == text


def test_complete_by_folder_then_by_name_anywhere(tmp_path):
    _tree(tmp_path)
    assert complete("src/st", tmp_path) == ["src/stats.py"]
    assert complete("src/", tmp_path) == ["src/stats.py", "src/util/"]
    assert complete("RE", tmp_path) == ["README.md"]
    assert complete("strings", tmp_path) == ["src/util/strings.py"]
    assert complete("stats", tmp_path) == ["src/stats.py"], ".git and node_modules are skipped"
    assert complete("../", tmp_path) == []


def test_tab_completes_a_mention_and_sending_attaches_it(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    _tree(app.workspace)
    sent: list[str] = []
    app._bridge.start = lambda text, **_shown: sent.append(text)  # noqa: SLF001
    for ch in "explain @stats":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="tab", char="\t"))  # noqa: SLF001
    assert app._prompt.value == "explain @src/stats.py "  # noqa: SLF001
    for ch in "briefly":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    app._handle_key(KeyPress(key="enter"))  # noqa: SLF001
    assert sent and sent[0].startswith("explain @src/stats.py briefly\n\n<file path=\"src/stats.py\">")
    shown = [plain(row) for row in app._transcript.snapshot()]  # noqa: SLF001
    assert " › explain @src/stats.py briefly" in shown
    assert not any("return sum" in row for row in shown)


def test_tab_never_drops_what_was_typed(tmp_path, monkeypatch):
    app = _fake_session(tmp_path, monkeypatch)
    app._app._width, app._app._height = 100, 30  # noqa: SLF001
    (app.workspace / "src" / "app" / "lib").mkdir(parents=True)
    (app.workspace / "src" / "app" / "config.py").write_text("")
    (app.workspace / "src" / "app" / "lib" / "conf.yaml").write_text("")
    for ch in "see @conf":
        app._handle_key(KeyPress(key=ch, char=ch))  # noqa: SLF001
    # The matches are listed above the box; with the list closed, tab only lists them
    # again and keeps what was typed (their shared start does not contain it)
    assert [v for v, _l, _m in app._completion["items"]] == [  # noqa: SLF001
        "@src/app/config.py", "@src/app/lib/conf.yaml"]
    app._handle_key(KeyPress(key="escape"))  # noqa: SLF001
    app._handle_key(KeyPress(key="tab", char="\t"))  # noqa: SLF001
    assert app._prompt.value == "see @conf"  # noqa: SLF001
    assert "src/app/config.py" in app._footer._toast_text  # noqa: SLF001
