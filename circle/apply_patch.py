"""OpenCode/Codex-style apply_patch tool."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.system_prompt import load_tool_prompt

_BEGIN = "*** Begin Patch"
_END = "*** End Patch"
_ADD = re.compile(r"^\*\*\* Add File:\s*(.+)\s*$")
_DELETE = re.compile(r"^\*\*\* Delete File:\s*(.+)\s*$")
_UPDATE = re.compile(r"^\*\*\* Update File:\s*(.+)\s*$")
_MOVE = re.compile(r"^\*\*\* Move to:\s*(.+)\s*$")


class _ApplyPatchInput(BaseModel):
    patchText: str = Field(description="Full patch envelope including Begin/End markers.")


def _resolve(workspace: Path, rel: str) -> Path:
    raw = (rel or "").strip()
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = (workspace / path).resolve()
    else:
        path = path.resolve()
    return path


def _apply_update(path: Path, hunk_lines: list[str]) -> None:
    original = path.read_text(encoding="utf-8") if path.is_file() else ""
    src_lines = original.splitlines(keepends=True)
    # Normalize to lines without keepends for matching; rebuild with \n
    src = original.splitlines()
    out: list[str] = []
    i = 0
    hi = 0
    while hi < len(hunk_lines):
        line = hunk_lines[hi]
        if line.startswith("@@"):
            hi += 1
            continue
        if line.startswith(" "):
            needle = line[1:]
            # Find needle from i
            found = None
            for j in range(i, len(src)):
                if src[j] == needle:
                    found = j
                    break
            if found is None:
                raise ValueError(f"context not found: {needle!r}")
            out.extend(src[i:found])
            out.append(src[found])
            i = found + 1
            hi += 1
        elif line.startswith("-"):
            needle = line[1:]
            if i >= len(src) or src[i] != needle:
                # search forward a little
                found = None
                for j in range(i, min(len(src), i + 40)):
                    if src[j] == needle:
                        found = j
                        break
                if found is None:
                    raise ValueError(f"delete target not found: {needle!r}")
                out.extend(src[i:found])
                i = found + 1
            else:
                i += 1
            hi += 1
        elif line.startswith("+"):
            out.append(line[1:])
            hi += 1
        elif line.strip() == "":
            hi += 1
        else:
            # treat as context without prefix
            needle = line
            found = None
            for j in range(i, len(src)):
                if src[j] == needle:
                    found = j
                    break
            if found is None:
                raise ValueError(f"context not found: {needle!r}")
            out.extend(src[i:found])
            out.append(src[found])
            i = found + 1
            hi += 1
    out.extend(src[i:])
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "\n".join(out)
    if original.endswith("\n") or not original:
        text = text + ("\n" if out else "")
    elif out:
        text = text + "\n"
    path.write_text(text, encoding="utf-8")


def apply_patch_text(workspace: Path, patch_text: str) -> str:
    text = (patch_text or "").strip()
    if _BEGIN not in text or _END not in text:
        return "Error: patch must include *** Begin Patch / *** End Patch"
    body = text.split(_BEGIN, 1)[1].split(_END, 1)[0]
    lines = body.splitlines()
    i = 0
    actions: list[str] = []
    while i < len(lines):
        line = lines[i]
        m_add = _ADD.match(line)
        m_del = _DELETE.match(line)
        m_upd = _UPDATE.match(line)
        if m_add:
            path = _resolve(workspace, m_add.group(1))
            i += 1
            content: list[str] = []
            while i < len(lines) and not lines[i].startswith("*** "):
                row = lines[i]
                content.append(row[1:] if row.startswith("+") else row)
                i += 1
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(content) + ("\n" if content else ""), encoding="utf-8")
            actions.append(f"added {path}")
            continue
        if m_del:
            path = _resolve(workspace, m_del.group(1))
            if path.is_file():
                path.unlink()
                actions.append(f"deleted {path}")
            else:
                actions.append(f"missing {path} (noop)")
            i += 1
            continue
        if m_upd:
            path = _resolve(workspace, m_upd.group(1))
            i += 1
            move_to: Path | None = None
            if i < len(lines):
                m_move = _MOVE.match(lines[i])
                if m_move:
                    move_to = _resolve(workspace, m_move.group(1))
                    i += 1
            hunk: list[str] = []
            while i < len(lines) and not lines[i].startswith("*** "):
                hunk.append(lines[i])
                i += 1
            if not path.is_file() and not move_to:
                return f"Error: update target missing: {path}"
            _apply_update(path, hunk)
            if move_to is not None:
                move_to.parent.mkdir(parents=True, exist_ok=True)
                path.replace(move_to)
                actions.append(f"updated+moved {path} → {move_to}")
            else:
                actions.append(f"updated {path}")
            continue
        i += 1
    if not actions:
        return "Error: no file operations found in patch"
    return "OK:\n" + "\n".join(f"- {a}" for a in actions)


def build_apply_patch_tool(workspace: Path | None) -> StructuredTool:
    root = Path(workspace).resolve() if workspace else Path.cwd()
    description = load_tool_prompt("apply_patch") or (
        "Apply a Begin/End Patch envelope to create, update, or delete files."
    )

    def _run(patchText: str) -> str:
        try:
            return apply_patch_text(root, patchText)
        except Exception as exc:  # noqa: BLE001
            return f"Error: {exc}"

    return StructuredTool.from_function(
        name="apply_patch",
        description=description,
        func=_run,
        args_schema=_ApplyPatchInput,
    )
