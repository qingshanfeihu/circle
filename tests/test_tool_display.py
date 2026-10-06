"""Diff previews preserve real line endings and count all changed source lines."""

from pathlib import Path

from circle.tui.tool_display import (
    APPROVAL_PREVIEW_LINES,
    approval_preview,
    change_preview,
    file_diff_preview,
)


def test_diff_counts_source_lines_that_start_with_diff_header_markers():
    added = file_diff_preview("demo.py", "", "++counter\n", created=True)
    assert added[0]["text"] == "Added demo.py (+1 -0)"
    assert added[2] == {"text": "+  1  ++counter", "tone": "added"}

    removed = file_diff_preview("demo.py", "--counter\n", "", created=False)
    assert removed[0]["text"] == "Edited demo.py (+0 -1)"
    assert removed[2] == {"text": "-  1  --counter", "tone": "removed"}


def test_eof_newline_change_is_visible_in_verified_and_snippet_previews():
    verified = file_diff_preview("demo.py", "x", "x\n", created=False)
    assert verified[0]["text"] == "Edited demo.py (+1 -1)"
    assert {"text": "-  1  x [no newline at EOF]", "tone": "removed"} in verified
    assert {"text": "+  1  x", "tone": "added"} in verified

    snippet = change_preview("edit_file", {"old_string": "x", "new_string": "x\n"})
    assert snippet is not None
    assert {"text": "-x [no newline at end of replacement]", "tone": "removed"} in snippet
    assert {"text": "+x", "tone": "added"} in snippet


def test_crlf_change_is_labeled():
    preview = file_diff_preview("demo.py", "x\n", "x\r\n", created=False)
    assert preview[0]["text"] == "Edited demo.py (+1 -1)"
    assert {"text": "+  1  x [CRLF]", "tone": "added"} in preview


# ── what an approval card shows for a file change ─────────────────────────


def _in(root: Path):
    return lambda path: root / path.lstrip("/")


def test_an_edit_is_shown_against_the_file_with_real_line_numbers(tmp_path: Path):
    (tmp_path / "todo.py").write_text("def remove(items, i):\n    del items[i]\n    save(items)\n")
    rows = approval_preview("edit_file", {
        "file_path": "/todo.py", "old_string": "    del items[i]\n",
        "new_string": "    if i < len(items):\n        del items[i]\n"}, _in(tmp_path))
    assert rows[0] == {"text": "+2 -1", "tone": ""}
    assert {"text": "-  2      del items[i]", "tone": "removed"} in rows
    assert {"text": "+  2      if i < len(items):", "tone": "added"} in rows
    assert {"text": "+  3          del items[i]", "tone": "added"} in rows
    assert {"text": "   1  def remove(items, i):", "tone": ""} in rows  # context
    assert (tmp_path / "todo.py").read_text().count("del") == 1  # nothing was changed


def test_a_new_file_and_a_rewrite_say_what_they_are(tmp_path: Path):
    rows = approval_preview("write_file", {"file_path": "/new.txt", "content": "a\nb\n"},
                            _in(tmp_path))
    assert rows[0]["text"] == "new file, 2 lines"
    assert [r["text"] for r in rows if r["tone"] == "added"] == ["+  1  a", "+  2  b"]
    (tmp_path / "old.txt").write_text("x\ny\n")
    rows = approval_preview("write_file", {"file_path": "/old.txt", "content": "x\n"}, _in(tmp_path))
    assert rows[0]["text"] == "+0 -1"


def test_without_the_file_the_change_is_shown_as_the_call_states_it(tmp_path: Path):
    rows = approval_preview("edit_file", {"file_path": "/gone.py", "old_string": "a\n",
                                          "new_string": "b\n"}, _in(tmp_path))
    assert rows[0]["text"] == "+1 -1"
    assert {"text": "-a", "tone": "removed"} in rows and {"text": "+b", "tone": "added"} in rows
    patch = "*** Begin Patch\n*** Update File: a.py\n@@\n-x\n+y\n*** End Patch"
    rows = approval_preview("apply_patch", {"patchText": patch})
    assert rows[0]["text"] == "+1 -1" and {"text": "*** Update File: a.py", "tone": ""} in rows


def test_a_long_change_is_cut_and_says_how_much(tmp_path: Path):
    content = "".join(f"line {i}\n" for i in range(100))
    rows = approval_preview("write_file", {"file_path": "/big.txt", "content": content},
                            _in(tmp_path))
    assert len(rows) == 1 + APPROVAL_PREVIEW_LINES + 1
    assert rows[-1]["text"].startswith("… +") and rows[-1]["text"].endswith("more lines")


def test_other_tools_have_no_preview():
    assert approval_preview("execute", {"command": "ls"}) == []
    assert approval_preview("edit_file", "not a mapping") == []
