"""Display-only tool result projections shared by live events and transcript replay."""

from __future__ import annotations

import difflib
import json
import re
from ast import literal_eval
from collections.abc import Mapping

PREVIEW_LINES = 6
MAX_CHANGE_CHARS = 256 * 1024
MAX_CHANGE_LINES = 2_000
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


def file_diff_preview(
    path: str, before: str, after: str, *, created: bool, operation: str = "edit_file"
) -> list[dict[str, str]]:
    """Render a verified before/after file snapshot with real file line numbers."""
    old_lines, new_lines = before.splitlines(), after.splitlines()
    if len(old_lines) + len(new_lines) > MAX_CHANGE_LINES * 2:
        return []
    diff = list(difflib.unified_diff(old_lines, new_lines, lineterm=""))[2:]
    if not diff:
        return []
    added = sum(line.startswith("+") and not line.startswith("+++") for line in diff)
    removed = sum(line.startswith("-") and not line.startswith("---") for line in diff)
    verb = "Added" if created else "Wrote" if operation == "write_file" else "Edited"
    lines = [_line(f"{verb} {path} (+{added} -{removed})")]
    old_number = new_number = 0
    for text in diff:
        hunk = _HUNK.match(text)
        if hunk:
            old_number, new_number = int(hunk.group(1)), int(hunk.group(2))
            lines.append(_line(text))
        elif text.startswith("+"):
            lines.append(_line(f"+{new_number:>3}  {text[1:]}", "added"))
            new_number += 1
        elif text.startswith("-"):
            lines.append(_line(f"-{old_number:>3}  {text[1:]}", "removed"))
            old_number += 1
        elif text.startswith(" "):
            lines.append(_line(f" {new_number:>3}  {text[1:]}"))
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
        old_lines, new_lines = old.splitlines(), new.splitlines()
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
            lines.append(_line(text, tone))
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
