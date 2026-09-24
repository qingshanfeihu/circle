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
# html.duckduckgo.com uses class="result__a" and https hrefs.
# lite.duckduckgo.com uses class='result-link' and protocol-relative //duckduckgo.com/l/?uddg=
_LINK_RE = re.compile(
    r"""<a\b[^>]*\bhref=(["'])([^"']+)\1[^>]*>(.*?)</a>""",
    re.I | re.S,
)
_SNIPPET_RE = re.compile(
    r"""class=(["'])[^"']*result(?:__snippet|-snippet)[^"']*\1[^>]*>(.*?)</(?:a|td|div|tr)>""",
    re.I | re.S,
)


class _WebSearchInput(BaseModel):
    query: str = Field(description="Search query. Include the current year for recent events.")
    num_results: int = Field(default=5, description="Max results (1-10).")


def _strip_tags(text: str) -> str:
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _normalize_href(href: str) -> str:
    href = html_lib.unescape(href.strip())
    if href.startswith("//"):
        href = "https:" + href
    if "uddg=" in href:
        parsed = urllib.parse.urlparse(href)
        qs = urllib.parse.parse_qs(parsed.query)
        href = urllib.parse.unquote(qs.get("uddg", [href])[0])
    return href


def _parse_search_html(raw: str, *, query: str, num_results: int, year: int) -> str:
    """Turn a DuckDuckGo HTML or lite page into a short result list."""
    links: list[tuple[str, str]] = []
    for _quote, href, title in _LINK_RE.findall(raw):
        if "uddg=" not in href and "result" not in href and not href.startswith("http"):
            continue
        if "uddg=" not in href and "duckduckgo.com" in href:
            continue
        url = _normalize_href(href)
        if not url.startswith("http"):
            continue
        title_plain = _strip_tags(title) or url
        links.append((url, title_plain))
    snippets = [_strip_tags(s) for _q, s in _SNIPPET_RE.findall(raw)]
    if not links:
        return f"No results for {query!r} (year hint: {year})."
    lines = [f"Web search results for {query!r} (as of {year}):", ""]
    for i, (href, title_plain) in enumerate(links[:num_results], 1):
        lines.append(f"{i}. {title_plain}")
        lines.append(f"   {href}")
        if i - 1 < len(snippets) and snippets[i - 1]:
            lines.append(f"   {snippets[i - 1]}")
        lines.append("")
    return "\n".join(lines).rstrip()


def web_search(query: str, *, num_results: int = 5) -> str:
    q = (query or "").strip()
    if not q:
        return "Error: query is required"
    n = max(1, min(int(num_results or 5), 10))
    year = datetime.now(timezone.utc).year
    # html.duckduckgo.com often returns empty to non-browser UAs; try lite + html.
    urls = [
        "https://lite.duckduckgo.com/lite/?" + urllib.parse.urlencode({"q": q}),
        "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": q}),
    ]
    raw = ""
    last_err = ""
    for url in urls:
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": _USER_AGENT,
                "Accept": "text/html",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read(500_000).decode("utf-8", errors="replace")
            if raw and ("result" in raw.lower() or "http" in raw.lower() or "<a " in raw):
                break
        except urllib.error.HTTPError as exc:
            last_err = f"HTTP {exc.code}"
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
    if not raw:
        return f"Error: search failed: {last_err or 'empty body'}"

    return _parse_search_html(raw, query=q, num_results=n, year=year)


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
