"""Resolve deepagents ``memory=`` sources (AGENTS.md / MEMORY.md).

Uses LangChain/deepagents MemoryMiddleware — files are injected into the
system prompt and the agent can update them via ``edit_file``.
"""

from __future__ import annotations

from pathlib import Path


_MEMORY_NAMES = (
    "AGENTS.md",
    "CLAUDE.md",
    "MEMORY.md",
    "agents.md",
)


def memory_source_paths(
    workspace: Path | None,
    home: Path | None,
) -> list[str]:
    """Ordered memory file paths for ``create_deep_agent(memory=...)``.

    Later files override earlier content in MemoryMiddleware's combine order
    (sources are listed lowest → highest priority for discovery; deepagents
    loads in list order and combines).
    """
    out: list[str] = []
    seen: set[str] = set()

    def _add(path: Path) -> None:
        if not path.is_file():
            return
        key = str(path.resolve())
        if key in seen:
            return
        seen.add(key)
        out.append(key)

    if home is not None:
        h = Path(home).expanduser().resolve()
        for name in _MEMORY_NAMES:
            _add(h / name)
        _add(h / "memory" / "AGENTS.md")

    uh = Path.home()
    for name in _MEMORY_NAMES:
        _add(uh / ".agents" / name)
    _add(uh / ".deepagents" / "AGENTS.md")

    if workspace is not None:
        ws = Path(workspace).expanduser().resolve()
        for name in _MEMORY_NAMES:
            _add(ws / name)
        _add(ws / ".agent" / "AGENTS.md")
        _add(ws / ".circle" / "AGENTS.md")
        _add(ws / ".deepagents" / "AGENTS.md")

    return out
