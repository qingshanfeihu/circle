"""Send Circle's logs to a file under the Circle home.

Without a handler, Python writes WARNING and above to stderr through its last-resort
handler — straight onto the full-screen TUI (retry notices, tool tracebacks, library
warnings). The TUI therefore installs one rotating file handler at start:
``$CIRCLE_HOME/logs/circle.log`` (5 MB × 3).
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

_MARK = "_circle_file_handler"


def configure_file_logging(home: Path, *, level: int = logging.INFO) -> Path:
    """Idempotent; returns the log file path."""
    path = Path(home) / "logs" / "circle.log"
    root = logging.getLogger()
    for handler in root.handlers:
        if getattr(handler, _MARK, False):
            return Path(handler.baseFilename)  # type: ignore[attr-defined]
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    setattr(handler, _MARK, True)
    root.addHandler(handler)
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)
    return path
