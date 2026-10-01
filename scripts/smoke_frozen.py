#!/usr/bin/env python3
"""Run the PyInstaller output the way a user would, before it is packed and published.

    python scripts/smoke_frozen.py dist/circle

Checks that the program starts and reports the source's version, that the prompt files are inside
the bundle, and that a session builds the agent: line mode with a scratch data folder, `/help`,
then `/exit`. Needs `pip install -e .` for the initial settings; nothing touches the network.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def run(exe: Path, args: list[str], env: dict[str, str], stdin: str = "") -> subprocess.CompletedProcess:
    return subprocess.run([str(exe), *args], input=stdin, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env, timeout=120)


def main(argv: list[str]) -> int:
    folder = Path(argv[0] if argv else "dist/circle").resolve()
    exe = folder / ("circle.exe" if os.name == "nt" else "circle")
    if not exe.is_file():
        print(f"smoke: {exe} is missing", file=sys.stderr)
        return 1

    from circle import __version__
    from circle.init_flow import complete_api_key_init
    from circle.probe import ProbeResult
    from circle.trust import accept_trust

    with tempfile.TemporaryDirectory() as scratch:
        home, workspace = Path(scratch) / "home", Path(scratch) / "ws"
        workspace.mkdir()
        settings = complete_api_key_init(
            base_url="http://127.0.0.1:9", api_key="sk-smoke", model="smoke-model", home=home,
            probe=lambda *_a, **_k: ProbeResult(protocol="openai", models=["smoke-model"]))
        accept_trust(settings, workspace, home=home)
        env = {**os.environ, "CIRCLE_HOME": str(home), "CIRCLE_NO_TUI": "1",
               "CIRCLE_NO_UPDATE_CHECK": "1", "PYTHONUTF8": "1"}

        version = run(exe, ["--version"], env)
        if version.stdout.strip() != __version__:
            print(f"smoke: --version printed {version.stdout!r}, the source says {__version__}",
                  file=sys.stderr)
            return 1

        prompts = sorted((folder / "_internal" / "circle" / "prompts").rglob("*.md"))
        if not prompts:
            print("smoke: no prompt files inside the bundle", file=sys.stderr)
            return 1

        session = run(exe, ["--line", str(workspace)], env, stdin="/help\n/exit\n")
        if session.returncode != 0 or "Available commands" not in session.stdout:
            print(f"smoke: the session did not start (exit {session.returncode})\n"
                  f"{session.stdout[-1500:]}\n{session.stderr[-1500:]}", file=sys.stderr)
            return 1

    print(f"smoke ok: circle {__version__}, {len(prompts)} prompt files, session starts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
