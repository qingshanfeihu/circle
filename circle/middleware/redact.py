"""Minimal secret redaction for text Circle puts back in front of the model.

Exception messages can carry what the tool was handed: URLs with credentials, bearer
tokens, ``password=…`` pairs. Only well-known shapes are covered; this is a last line,
not a guarantee.
"""

from __future__ import annotations

import re

_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # scheme://user:pass@host
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:]+:[^\s/@]+@"), r"\1***:***@"),
    # Authorization: Bearer <token>
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}"), r"\1 ***"),
    # key=value / key: value for secret-ish keys
    (re.compile(r"(?i)\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)"
                r"[\w-]*)(\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;&]+)"), r"\1\2***"),
    # well-known key prefixes
    (re.compile(r"\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}"
                r"|AKIA[0-9A-Z]{16})\b"), "***"),
)


def redact(text: str) -> str:
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text
