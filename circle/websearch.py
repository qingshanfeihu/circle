"""Web search tool (DuckDuckGo HTML, no API key)."""

from __future__ import annotations

import html as html_lib
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.system_prompt import load_tool_prompt

_USER_AGENT = "Circle/0.1 (+local coding agent)"
_RESULT_RE = re.compile(
    r'<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
    re.I | re.S,
)
_SNIPPET_RE = re.compile(
    r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|td|div)>',
    re.I | re.S,
)


class _WebSearchInput(BaseModel):
    query: str = Field(description="Search query. Include the current year for recent events.")
    num_results: int = Field(default=5, description="Max results (1-10).")


def _strip_tags(text: str) -> str:
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def web_search(query: str, *, num_results: int = 5) -> str:
    q = (query or "").strip()
    if not q:
        return "Error: query is required"
    n = max(1, min(int(num_results or 5), 10))
    year = datetime.now(timezone.utc).year
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": q})
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read(500_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        return f"Error: search HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return f"Error: search failed: {exc}"

    links = _RESULT_RE.findall(raw)
    snippets = [_strip_tags(s) for s in _SNIPPET_RE.findall(raw)]
    if not links:
        return f"No results for {q!r} (year hint: {year})."
    lines = [f"Web search results for {q!r} (as of {year}):", ""]
    for i, (href, title) in enumerate(links[:n], 1):
        title_plain = _strip_tags(title) or href
        # DuckDuckGo sometimes wraps redirects
        if "uddg=" in href:
            parsed = urllib.parse.urlparse(href)
            qs = urllib.parse.parse_qs(parsed.query)
            href = qs.get("uddg", [href])[0]
        snip = snippets[i - 1] if i - 1 < len(snippets) else ""
        lines.append(f"{i}. {title_plain}")
        lines.append(f"   {href}")
        if snip:
            lines.append(f"   {snip}")
        lines.append("")
    return "\n".join(lines).rstrip()


def build_websearch_tool() -> StructuredTool:
    description = load_tool_prompt("websearch") or (
        "Search the web for up-to-date information. Include the current year in queries."
    )
    # Expand {{year}} if present in prompt file
    year = str(datetime.now(timezone.utc).year)
    description = description.replace("{{year}}", year)

    def _run(query: str, num_results: int = 5) -> str:
        return web_search(query, num_results=num_results)

    return StructuredTool.from_function(
        name="websearch",
        description=description,
        func=_run,
        args_schema=_WebSearchInput,
    )
