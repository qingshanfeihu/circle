"""Display-only tool result projections shared by live events and transcript replay."""

from __future__ import annotations

import difflib
import json
import re
from ast import literal_eval
from collections.abc import Callable, Mapping
from pathlib import Path

PREVIEW_LINES = 6
MAX_CHANGE_CHARS = 256 * 1024
MAX_CHANGE_LINES = 2_000
# rows of change an approval card shows before "… +N more lines"
APPROVAL_PREVIEW_LINES = 40
_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def result_content(raw: str) -> list[str]:
    """Show useful JSON fields first without dropping unknown fields on expansion."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        if len(raw) > MAX_CHANGE_CHARS or not raw.lstrip().startswith(("{", "[")):
            return raw.rstrip("\n").splitlines() or ["(no output)"]
        try:
            value = literal_eval(raw)
        except (MemoryError, RecursionError, SyntaxError, ValueError):
            return raw.rstrip("\n").splitlines() or ["(no output)"]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value) or ["(empty)"]  # a list of paths or names: one per line
    if not isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, indent=2, default=str).splitlines()
    priority = (
        "status", "verdict", "ok", "autoid", "error", "message", "result",
        "stdout", "stderr", "output", "content", "violations", "advisories",
    )
    rank = {key: index for index, key in enumerate(priority)}
    lines: list[str] = []
    for key in sorted(value, key=lambda item: rank.get(item, len(priority))):
        item = value[key]
        if key in ("violations", "advisories") and isinstance(item, list) and item:
            label = "violation" if key == "violations" else "advisory"
            for entry in item:
                if isinstance(entry, dict):
                    fields = " · ".join(
                        f"{field}={json.dumps(part, ensure_ascii=False, default=str)}"
                        for field, part in entry.items()
                    )
                    lines.append(f"{label}: {fields}")
                else:
                    lines.append(f"{label}: {json.dumps(entry, ensure_ascii=False, default=str)}")
        elif isinstance(item, str) and "\n" in item:
            lines.append(f"{key}:")
            lines.extend(f"  {part}" for part in item.splitlines())
        elif isinstance(item, (dict, list)):
            lines.append(f"{key}:")
            lines.extend(
                f"  {part}"
                for part in json.dumps(item, ensure_ascii=False, indent=2, default=str).splitlines()
            )
        else:
            shown = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False, default=str)
            lines.append(f"{key}: {shown}")
    return lines or ["{}"]


def _line(text: str, tone: str = "") -> dict[str, str]:
    return {"text": text, "tone": tone}


def _limit_change(lines: list[dict[str, str]]) -> list[dict[str, str]]:
    if len(lines) <= MAX_CHANGE_LINES:
        return lines
    hidden = len(lines) - MAX_CHANGE_LINES
    return [*lines[:MAX_CHANGE_LINES], _line(f"… +{hidden} change lines not captured for display")]


def _diff_body(text: str, *, boundary: str = "EOF") -> str:
    """Keep line-ending-only changes visible without embedding newlines in a row."""
    if text.endswith("\r\n"):
        return text[:-2] + " [CRLF]"
    if text.endswith("\n"):
        return text[:-1]
    if text.endswith("\r"):
        return text[:-1] + " [CR]"
    return f"{text} [no newline at {boundary}]"


def file_diff_preview(
    path: str, before: str, after: str, *, created: bool, operation: str = "edit_file"
) -> list[dict[str, str]]:
    """Render a verified before/after file snapshot with real file line numbers."""
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    if len(old_lines) + len(new_lines) > MAX_CHANGE_LINES * 2:
        return []
    diff = list(difflib.unified_diff(old_lines, new_lines, lineterm=""))[2:]
    if not diff:
        return []
    # The file headers were removed above. A changed source line may itself
    # start with "++" or "--", so its diff line starts with "+++"/"---".
    added = sum(line.startswith("+") for line in diff)
    removed = sum(line.startswith("-") for line in diff)
    verb = "Added" if created else "Wrote" if operation == "write_file" else "Edited"
    lines = [_line(f"{verb} {path} (+{added} -{removed})")]
    old_number = new_number = 0
    for text in diff:
        hunk = _HUNK.match(text)
        if hunk:
            old_number, new_number = int(hunk.group(1)), int(hunk.group(2))
            lines.append(_line(text))
        elif text.startswith("+"):
            lines.append(_line(f"+{new_number:>3}  {_diff_body(text[1:])}", "added"))
            new_number += 1
        elif text.startswith("-"):
            lines.append(_line(f"-{old_number:>3}  {_diff_body(text[1:])}", "removed"))
            old_number += 1
        elif text.startswith(" "):
            lines.append(_line(f" {new_number:>3}  {_diff_body(text[1:])}"))
            old_number += 1
            new_number += 1
        else:
            lines.append(_line(text))
    return _limit_change(lines)


def change_preview(name: str, inputs: object) -> list[dict[str, str]] | None:
    """Represent attempted file changes; attach only after a successful tool result.

    Write shows the content sent to the tool. It never claims the file was newly
    created or that these are the differences from its previous version.
    """
    if not isinstance(inputs, Mapping):
        return None
    if name == "write_file":
        content = inputs.get("content")
        if not isinstance(content, str):
            return None
        if len(content) > MAX_CHANGE_CHARS:
            return [_line(f"Written content exceeds {MAX_CHANGE_CHARS} characters; preview omitted")]
        body = content.splitlines()
        return _limit_change([
            _line(f"Written content ({len(body)} {'line' if len(body) == 1 else 'lines'})"),
            *(_line(f"+{number:>3}  {text}", "added") for number, text in enumerate(body, 1)),
        ])
    if name == "edit_file":
        old, new = inputs.get("old_string"), inputs.get("new_string")
        if not isinstance(old, str) or not isinstance(new, str):
            return None
        if len(old) + len(new) > MAX_CHANGE_CHARS:
            return [_line(f"Replacement exceeds {MAX_CHANGE_CHARS} characters; preview omitted")]
        old_lines, new_lines = old.splitlines(keepends=True), new.splitlines(keepends=True)
        if len(old_lines) + len(new_lines) > MAX_CHANGE_LINES * 2:
            return [_line("Replacement has too many lines; preview omitted")]
        diff = list(difflib.unified_diff(old_lines, new_lines, lineterm=""))[2:]
        if not diff:
            return None
        lines = [_line("@@ replacement @@")]
        for text in diff:
            if text.startswith("@@"):
                continue  # snippet-relative line numbers are not file positions
            tone = "added" if text.startswith("+") else "removed" if text.startswith("-") else ""
            lines.append(_line(text[0] + _diff_body(text[1:], boundary="end of replacement"), tone))
        return _limit_change(lines)
    if name == "apply_patch":
        patch = inputs.get("patchText")
        if not isinstance(patch, str):
            return None
        if len(patch) > MAX_CHANGE_CHARS:
            return [_line(f"Patch exceeds {MAX_CHANGE_CHARS} characters; preview omitted")]
        body = patch.split("*** Begin Patch", 1)[-1].split("*** End Patch", 1)[0]
        lines = []
        for text in body.splitlines():
            if not text:
                continue
            tone = "added" if text.startswith("+") else "removed" if text.startswith("-") else ""
            lines.append(_line(text, tone))
        return _limit_change(lines) or None
    return None


def _file_text(resolve: Callable[[str], Path], path: str) -> str | None:
    """The file as it is now; "" when there is none yet; None when it cannot be shown."""
    try:
        target = Path(resolve(path))
        if not target.exists():
            return ""
        if not target.is_file() or target.stat().st_size > MAX_CHANGE_CHARS:
            return None
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError, RuntimeError):
        return None


def approval_preview(name: str, args: object,
                     resolve: Callable[[str], Path] | None = None) -> list[dict[str, str]]:
    """What a file tool asks to change, for its approval card: a count of the lines it
    adds and removes, then the diff. Against the file as it is now when it can be read
    (real line numbers and context), else the change as the call states it."""
    if not isinstance(args, Mapping) or name not in {"edit_file", "write_file", "apply_patch"}:
        return []
    path = str(args.get("file_path") or args.get("path") or "")
    before = _file_text(resolve, path) if resolve is not None and path else None
    after: str | None = None
    if before is not None and name == "write_file" and isinstance(args.get("content"), str):
        after = str(args["content"])
    elif before and name == "edit_file":
        old, new = args.get("old_string"), args.get("new_string")
        if isinstance(old, str) and old and isinstance(new, str) and old in before:
            after = before.replace(old, new, -1 if args.get("replace_all") is True else 1)
    if after is not None:
        rows = file_diff_preview(path, before or "", after, created=not before,
                                 operation=name)[1:]
        if not before:
            count = len(after.splitlines())
            summary = f"new file, {count} {'line' if count == 1 else 'lines'}"
        else:
            summary = ""
    else:
        rows = change_preview(name, args) or []
        if name == "write_file":
            rows = rows[1:]  # "Written content (N lines)": said by the summary instead
        summary = ""
    if not rows:
        return []
    if not summary:
        added = sum(row.get("tone") == "added" for row in rows)
        removed = sum(row.get("tone") == "removed" for row in rows)
        summary = f"+{added} -{removed}"
    if len(rows) > APPROVAL_PREVIEW_LINES:
        hidden = len(rows) - APPROVAL_PREVIEW_LINES
        rows = [*rows[:APPROVAL_PREVIEW_LINES], _line(f"… +{hidden} more lines")]
    return [_line(summary), *rows]


def display_lines(raw: str, payload: Mapping[str, object], *, is_error: bool) -> list[dict[str, str]]:
    if not is_error:
        preview = payload.get("display_lines")
        if isinstance(preview, list) and all(
            isinstance(item, dict)
            and isinstance(item.get("text"), str)
            and item.get("tone") in ("", "added", "removed")
            for item in preview
        ):
            return [_line(item["text"], item["tone"]) for item in preview]
    return [_line(text) for text in result_content(raw)]


__all__ = ["MAX_CHANGE_CHARS", "PREVIEW_LINES", "change_preview", "display_lines",
           "file_diff_preview", "result_content"]
