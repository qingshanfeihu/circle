"""Extra tools and prompt-backed agent specs for the Circle harness."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.skills import build_skill_tool
from circle.system_prompt import load_agent_prompt, load_tool_prompt

# deepagents built-in tool names that have matching prompt files
_BUILTIN_TOOL_PROMPT_NAMES = (
    "ls",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "execute",
    "write_todos",
    "task",
)

_MAX_FETCH_BYTES = 500_000
_USER_AGENT = "Circle/0.1 (+local coding agent)"


def collect_tool_description_overrides() -> dict[str, str]:
    """Map tool name → description text from ``prompts/tools/*.md``."""
    out: dict[str, str] = {}
    for name in _BUILTIN_TOOL_PROMPT_NAMES:
        body = load_tool_prompt(name)
        if body:
            out[name] = body
    shell = load_tool_prompt("execute")
    if shell:
        out["execute"] = shell
    skill = load_tool_prompt("skill")
    if skill:
        out["skill"] = skill
    return out


def explore_subagent_spec() -> dict[str, Any]:
    """Declarative explore subagent for the ``task`` tool."""
    prompt = load_agent_prompt("explore") or (
        "You are a file search specialist. Explore the codebase with read-only tools."
    )
    return {
        "name": "explore",
        "description": (
            "File-search specialist for exploring codebases. Use for broad "
            "searches, locating definitions, and mapping structure. Read-only: "
            "does not create or edit files."
        ),
        "system_prompt": prompt,
    }


class _WebFetchInput(BaseModel):
    url: str = Field(description="Fully-formed URL to fetch (http upgraded to https).")
    format: str = Field(
        default="markdown",
        description='Output format: "markdown" (default), "text", or "html".',
    )


def _html_to_text(html: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _host_blocked(host: str | None) -> str | None:
    h = (host or "").lower()
    if not h:
        return "missing host"
    if h in {"localhost", "127.0.0.1", "::1", "0.0.0.0"} or h.endswith(".local"):
        return h
    if h.startswith("169.254.") or h.startswith("10.") or h.startswith("192.168."):
        return h
    if h.startswith("172."):
        try:
            second = int(h.split(".")[1])
            if 16 <= second <= 31:
                return h
        except (IndexError, ValueError):
            pass
    return None


class _NoPrivateRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects only when the next hop is not a private/local host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        parsed = urlparse(newurl)
        blocked = _host_blocked(parsed.hostname)
        if blocked:
            raise urllib.error.URLError(
                f"refusing redirect to local/private host {blocked!r}"
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_FETCH_OPENER = urllib.request.build_opener(_NoPrivateRedirect)


def _fetch_url(url: str, fmt: str = "markdown") -> str:
    raw_url = (url or "").strip()
    if not raw_url:
        return "Error: url is required"
    parsed = urlparse(raw_url)
    if parsed.scheme == "http":
        raw_url = "https://" + raw_url[len("http://") :]
        parsed = urlparse(raw_url)
    if parsed.scheme not in {"https", "http"} or not parsed.netloc:
        return f"Error: invalid URL {url!r}"

    blocked = _host_blocked(parsed.hostname)
    if blocked:
        return f"Error: refusing to fetch local/private host {blocked!r}"

    req = urllib.request.Request(
        raw_url,
        headers={"User-Agent": _USER_AGENT, "Accept": "text/*,application/json"},
        method="GET",
    )
    try:
        with _FETCH_OPENER.open(req, timeout=30) as resp:  # noqa: S310
            data = resp.read(_MAX_FETCH_BYTES + 1)
            content_type = (resp.headers.get("Content-Type") or "").lower()
            final_url = resp.geturl()
    except urllib.error.HTTPError as exc:
        return f"Error: HTTP {exc.code} fetching {raw_url}"
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        return f"Error: could not fetch {raw_url}: {reason}"
    except TimeoutError:
        return f"Error: timeout fetching {raw_url}"

    final_host = urlparse(final_url).hostname
    blocked_final = _host_blocked(final_host)
    if blocked_final:
        return f"Error: refusing final URL host {blocked_final!r}"

    truncated = len(data) > _MAX_FETCH_BYTES
    data = data[:_MAX_FETCH_BYTES]
    try:
        body = data.decode("utf-8")
    except UnicodeDecodeError:
        body = data.decode("utf-8", errors="replace")

    fmt_n = (fmt or "markdown").lower().strip()
    if "json" in content_type:
        try:
            rendered = json.dumps(json.loads(body), indent=2, ensure_ascii=False)
        except json.JSONDecodeError:
            rendered = body
    elif fmt_n == "html":
        rendered = body
    elif fmt_n == "text":
        rendered = _html_to_text(body) if "html" in content_type or "<html" in body[:200].lower() else body
    else:
        # markdown-ish: strip tags for HTML, else keep as code fence
        if "html" in content_type or "<html" in body[:200].lower():
            rendered = _html_to_text(body)
        else:
            rendered = body

    header = f"URL: {final_url}\nContent-Type: {content_type or 'unknown'}\n"
    if truncated:
        header += f"(truncated to {_MAX_FETCH_BYTES} bytes)\n"
    return header + "\n" + rendered


def build_webfetch_tool() -> StructuredTool:
    description = load_tool_prompt("webfetch") or (
        "Fetch a URL and return its content as text/markdown."
    )

    def _run(url: str, format: str = "markdown") -> str:  # noqa: A002
        return _fetch_url(url, format)

    return StructuredTool.from_function(
        name="webfetch",
        description=description,
        func=_run,
        args_schema=_WebFetchInput,
    )


class _QuestionInput(BaseModel):
    questions: list[dict[str, Any]] = Field(
        description=(
            "List of question objects. Each should include `question` (str) and "
            "optional `options` (list of label strings) and `multiple` (bool)."
        )
    )


def build_question_tool() -> StructuredTool:
    """Surface clarifying questions in the tool result for the TUI/user."""
    description = load_tool_prompt("question") or (
        "Ask the user clarifying questions during execution."
    )

    def _run(questions: list[dict[str, Any]]) -> str:
        if not questions:
            return "Error: questions list is empty"
        lines = [
            "USER_QUESTIONS — present these to the user and wait for answers "
            "before continuing irreversible work:",
            "",
        ]
        for i, q in enumerate(questions, 1):
            text = str(q.get("question") or q.get("prompt") or "").strip()
            lines.append(f"{i}. {text or '(empty question)'}")
            opts = q.get("options") or q.get("choices") or []
            if isinstance(opts, list) and opts:
                for opt in opts:
                    if isinstance(opt, dict):
                        label = opt.get("label") or opt.get("text") or str(opt)
                    else:
                        label = str(opt)
                    lines.append(f"   - {label}")
            if q.get("multiple"):
                lines.append("   (multiple selections allowed)")
            lines.append("")
        lines.append(
            "After the user answers in chat, continue with their choices. "
            "Do not invent answers."
        )
        return "\n".join(lines)

    return StructuredTool.from_function(
        name="question",
        description=description,
        func=_run,
        args_schema=_QuestionInput,
    )


def build_extra_tools(
    workspace: Path | None = None,
    home: Path | None = None,
    *,
    user_home: Path | None = None,
) -> list[StructuredTool]:
    tools: list[StructuredTool] = [build_webfetch_tool(), build_question_tool()]
    tools.append(build_skill_tool(workspace, home, user_home=user_home))
    return tools


_COMPACT_FORMAT = """\
Produce a structured summary with these exact headings (keep empty sections if needed):

## Goal
## Decisions
## Files & paths
## Open tasks
## Notes

Use terse bullets. Preserve exact file paths and identifiers. Reply with the summary only.
"""


def compact_messages(*, transcript: str, hint: str = "") -> list[dict[str, str]]:
    """Chat messages for /compact using the compaction agent prompt."""
    system = load_agent_prompt("compaction") or (
        "You summarize conversations so another coding agent can continue."
    )
    user = (
        f"{hint.strip()}\n\n" if hint.strip() else ""
    ) + f"{_COMPACT_FORMAT}\n---\n\nTranscript:\n{transcript}"
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def title_messages(*, user_text: str) -> list[dict[str, str]]:
    """Chat messages for auto thread title using the title agent prompt."""
    system = load_agent_prompt("title") or (
        "Output ONLY a brief thread title on one line, ≤50 characters."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user_text[:2000]},
    ]


def summary_messages(*, transcript: str) -> list[dict[str, str]]:
    """Chat messages for a PR-style session summary."""
    system = load_agent_prompt("summary") or (
        "Summarize what was done. 2-3 sentences. First person. No questions."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": transcript[-12000:]},
    ]


def plan_mode_append() -> str:
    """System-prompt append when plan mode is active."""
    from circle.system_prompt import _prompts_root

    path = _prompts_root() / "session" / "plan-mode.md"
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    return (
        "Plan mode is active. Do not edit files or run mutating commands; "
        "research and write a plan to /plan.md only."
    )
