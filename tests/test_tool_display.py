"""Diff previews preserve real line endings and count all changed source lines."""

from circle.tui.tool_display import change_preview, file_diff_preview


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
