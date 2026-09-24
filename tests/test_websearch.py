"""DuckDuckGo result parsing. Live HTTP stays out of the unit test."""

from circle.websearch import _parse_search_html

_LITE = """
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdownloads%2Frelease%2Fpython-3110%2F&amp;rut=abc" class='result-link'>Python Release Python 3.11.0 | Python.org</a>
<td class='result-snippet'><b>Release</b> date: Oct. 24, 2022</td>
<a rel="nofollow" href="//duckduckgo.com/favicon.ico">icon</a>
"""


def test_lite_page_keeps_uddg_targets_and_snippets():
    text = _parse_search_html(
        _LITE, query="Python 3.11 release date", num_results=3, year=2026,
    )
    assert "python.org/downloads/release/python-3110" in text
    assert "Oct. 24, 2022" in text
    assert "favicon" not in text
    assert "No results" not in text
