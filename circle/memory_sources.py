"""Resolve deepagents ``memory=`` sources (AGENTS.md / MEMORY.md).

Uses LangChain/deepagents MemoryMiddleware — files are injected into the
system prompt and the agent can update them via ``edit_file``.
"""

from __future__ import annotations

from pathlib import Path

from circle.system_prompt import file_identity


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
    seen: set[tuple[int, int]] = set()

    def _add(path: Path) -> None:
        if not path.is_file():
            return
        key = file_identity(path)  # one file, even under two spellings of its name
        if key is None or key in seen:
            return
        seen.add(key)
        out.append(str(path.resolve()))

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
