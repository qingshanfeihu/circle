"""How finished background jobs look in the transcript: the row a notice opens with (not a
user bubble), the faint line under a call that went to the background, and the words for
a job's state. Colours come from the palette each time a row is drawn."""

from __future__ import annotations

import re
import time
from collections.abc import Iterable, Mapping
from typing import Any

from circle.ink.string_width import string_width
from circle.ink.theme import GLYPH_MILESTONE, palette, sgr_join, status_light
from circle.jobs import Job, format_elapsed, read_tail

# Job rows the strip shows at most; a tail line counts the rest
JOB_ROWS = 4
_NAME_W = 32

_TITLE_MAX = 60
# What a program writes for a terminal (colours, cursor moves, titles) and other control
# characters: a job's output is shown as plain text
_CONTROL = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]"
                      r"|[\x00-\x08\x0b-\x1f\x7f]")


def plain_output(text: str) -> str:
    """Output as plain text: escape sequences and control characters removed, tabs as
    spaces, a carriage-return redraw reduced to what it ended with."""
    lines = []
    for line in str(text or "").split("\n"):
        line = line.rsplit("\r", 1)[-1] if "\r" in line.rstrip("\r") else line.rstrip("\r")
        lines.append(_CONTROL.sub("", line).replace("\t", "    "))
    return "\n".join(lines)


def _clip(text: str, room: int) -> str:
    text = " ".join(str(text or "").split())
    if string_width(text) <= room:
        return text
    out, used = [], 0
    for ch in text:
        width = string_width(ch)
        if used + width > room - 1:
            break
        out.append(ch)
        used += width
    return "".join(out) + "…"


def outcome_words(status: str, exit_code: int | None, reason: str = "") -> str:
    """``done``, ``failed · exit 1``, ``failed · timeout``, ``stopped``."""
    if status == "done":
        return "done"
    if status == "failed":
        if reason and reason != "exit":
            return f"failed · {reason}"
        return f"failed · exit {exit_code}" if exit_code is not None else "failed"
    return status or "ended"


def notice_rows(items: Iterable[Mapping[str, Any]]) -> list[str]:
    """One row per finished job: `` ◆ j3 done · npm test · 12s``; the glyph is green when it
    is done, red when it failed and dim when it was stopped."""
    pal = palette()
    rows = []
    for item in items:
        status = str(item.get("status") or "")
        colour = pal.green if status == "done" else pal.red if status == "failed" else pal.dim
        words = " · ".join(part for part in (
            f"{item.get('id', '')} {outcome_words(status, item.get('exit_code'), str(item.get('reason') or ''))}",
            _clip(str(item.get("title") or ""), _TITLE_MAX),
            format_elapsed(float(item.get("elapsed_s") or 0)),
        ) if part)
        rows.append(f" {colour}{GLYPH_MILESTONE}{pal.reset} {pal.dim}{words}{pal.reset}")
    return rows


def background_line(job: Mapping[str, Any]) -> str:
    """Under a call that became a job: ``in background · j3`` (started there),
    ``moved to background · j4`` or ``left running · j5`` (processes it started)."""
    how = str(job.get("how") or "")
    word = {"moved": "moved to background", "adopted": "left running"}.get(how, "in background")
    return f"{word} · {job.get('id', '')}"


# ── the strip and the job page ──────────────────────────────────────────────


def _fit(text: str, width: int) -> str:
    """Cut to ``width`` columns (spaces kept), marking a cut with ``…``."""
    text = str(text or "").replace("\n", " ")
    if width <= 0:
        return ""
    if string_width(text) <= width:
        return text
    while text and string_width(text) > width - 1:
        text = text[:-1]
    return text + "…"


def _pad(text: str, width: int) -> str:
    shown = _fit(text, width)
    return shown + " " * max(0, width - string_width(shown))


def _rjust(text: str, width: int) -> str:
    shown = _fit(text, width)
    return " " * max(0, width - string_width(shown)) + shown


def job_light(job: Job, now: float | None = None) -> tuple[str, str]:
    """``(sgr, glyph)`` of a live job's lamp: waiting on you (cyan) or running (yellow,
    blinking); split so the row's background can go into the same SGR."""
    raw = status_light("wait" if job.status == "waiting" else "running", now=now, reset=False)
    code, glyph = raw.rsplit("m", 1)
    return code + "m", glyph


def job_activity(job: Job) -> str:
    """What a job is doing: ``waiting for you``, an agent's step, a command's last line."""
    if job.status == "waiting":
        return "waiting for you"
    if job.detail and job.kind in ("agent", "watch"):
        return job.detail
    if job.output_path and job.kind in ("shell", "adopted"):
        tail, _count = read_tail(job.output_path, lines=1, limit=512, count_lines=False)
        return plain_output(tail).strip() or "—"
    return "—"


def job_label(job: Job) -> str:
    return f"{job.id} {job.title}"


def render_job_rows(jobs: list[Job], *, width: int, now: float | None = None,
                    activity: dict[str, str] | None = None, hidden: int = 0) -> list[str]:
    """One row per live job under the strip's header: lamp, ``j1 npm run dev``, what it is
    doing (the column that gives way first), how long it has run. Commands carry the write
    tint, agents the agent tint."""
    if not jobs:
        return []
    now = time.time() if now is None else now
    pal = palette()
    w = max(20, int(width or 0) or 80)
    activity = activity or {}
    names = [job_label(job) for job in jobs]
    doings = [activity.get(job.id) or job_activity(job) for job in jobs]
    metas = [format_elapsed(job.elapsed()) for job in jobs]
    name_w = min(_NAME_W, max(string_width(n) for n in names))
    meta_w = max(string_width(m) for m in metas)
    doing_w = w - 3 - name_w - 2 - meta_w - 2 - 1
    if doing_w < 8:
        name_w = max(8, min(name_w, w - 3 - 2 - meta_w - 2 - 1 - 8))
        doing_w = max(0, w - 3 - name_w - 2 - meta_w - 2 - 1)
    out = []
    for job, name, doing, meta in zip(jobs, names, doings, metas):
        bg = pal.agent_bg if job.kind == "agent" else pal.write_bg
        lamp_sgr, lamp_glyph = job_light(job, now)
        body = f"{_pad(name, name_w)}  {_pad(doing, doing_w)}  "
        out.append(f"{sgr_join(bg, '')} {sgr_join(bg, lamp_sgr)}{lamp_glyph}{sgr_join(bg, pal.text)}"
                   f" {body}{sgr_join(bg, pal.dim)}{_rjust(meta, meta_w)} {pal.reset}")
    if hidden > 0:
        out.append(f"{sgr_join(pal.panel_bg, pal.faint)}{_pad(f'  … +{int(hidden)} more jobs', w)}"
                   f"{pal.reset}")
    return out


def strip_header(agents: int, jobs: int, width: int) -> str:
    """`` Agents · 2 · Jobs · 3``, naming only what is there."""
    pal = palette()
    parts = []
    if agents:
        parts.append(f"Agents · {agents}")
    if jobs:
        parts.append(f"Jobs · {jobs}")
    return f"{sgr_join(pal.panel_bg, pal.faint)}{_pad(' ' + ' · '.join(parts), max(20, width))}{pal.reset}"


def render_job_band(job: Job, *, width: int) -> list[str]:
    """The job page's band: its lamp, id and title, state and time, and the output file."""
    pal = palette()
    w = max(20, width)
    if job.running:
        lamp_sgr, glyph = job_light(job)
        lamp = f"{sgr_join(pal.panel_bg, lamp_sgr)}{glyph}"
    else:
        state = "ok" if job.status == "done" else "error" if job.status == "failed" else "none"
        raw = status_light(state, reset=False)
        code, glyph = raw.rsplit("m", 1) if "m" in raw else ("", raw)
        lamp = f"{sgr_join(pal.panel_bg, code + 'm' if code else '')}{glyph}"
    state = job.status if job.running else outcome_words(job.status, job.exit_code, job.reason)
    meta = f"{state} · {format_elapsed(job.elapsed())}"
    where = job.virtual_path or job.output_path or ""
    head_w = w - 3 - string_width(meta) - 2 - 1
    first = (f"{sgr_join(pal.panel_bg, '')} {lamp}{sgr_join(pal.panel_bg, pal.em)} "
             f"{_pad(job_label(job), head_w)}  {sgr_join(pal.panel_bg, pal.dim)}{meta} {pal.reset}")
    second = f"{sgr_join(pal.panel_bg, pal.faint)}{_pad('   ' + where, w)}{pal.reset}"
    return [first, second] if where else [first]


def job_log_rows(job: Job, lines: int = 200) -> list[str]:
    """The end of a job's output, faint, for the job page."""
    pal = palette()
    if not job.output_path:
        return [f" {pal.faint}{job.summary or 'No output kept for this job.'}{pal.reset}"]
    tail, _count = read_tail(job.output_path, lines=lines, limit=256 * 1024, count_lines=False)
    tail = plain_output(tail)
    if not tail.strip():
        return [f" {pal.faint}No output yet.{pal.reset}"]
    return [f" {pal.faint}{line}{pal.reset}" if line else "" for line in tail.split("\n")]
