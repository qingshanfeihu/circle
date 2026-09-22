#!/usr/bin/env python3
"""Drive Circle harness (same settings as sandbox TUI) to write pelican-bike.svg.

Auto-approves write/execute interrupts so the end-to-end model+tools path
can finish without a human at the ink panel.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from langgraph.types import Command

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from circle.harness import create_harness
from circle.model import build_chat_model
from circle.settings import apply_auth_to_environ, load_settings

PROMPT = """Create a single self-contained SVG file at pelican-bike.svg in the
workspace root.

Subject: a pelican riding a bicycle (鹈鹕骑自行车). Make it whimsical and
clearly readable as that scene: pelican body/beak/wings, bicycle frame/wheels/
pedals, pelican on the seat pedaling. Use simple shapes, pleasant colors, viewBox
roughly 800x600. No external fonts or images. Write the file with the write tool
and stop when done. Do not ask questions."""


def main() -> int:
    home = Path(os.environ.get("CIRCLE_HOME", "")).expanduser()
    ws = Path(os.environ.get("CIRCLE_WORKSPACE", ".")).expanduser().resolve()
    if not home.is_dir():
        print("CIRCLE_HOME missing", file=sys.stderr)
        return 2
    settings = load_settings(home)
    apply_auth_to_environ(settings, home)
    print(f"model={settings.auth.model} protocol={settings.auth.protocol}")
    print(f"workspace={ws}")

    agent = create_harness(build_chat_model(settings, home=home), root_dir=ws)
    config = {"configurable": {"thread_id": f"pelican-{int(time.time())}"}}
    payload: object = {"messages": [{"role": "user", "content": PROMPT}]}

    target = ws / "pelican-bike.svg"
    if target.exists():
        target.unlink()

    for step in range(12):
        print(f"— step {step + 1}")
        result = agent.invoke(payload, config=config)
        interrupts = []
        if isinstance(result, dict):
            interrupts = result.get("__interrupt__") or []
        # langgraph may stash interrupts on graph result differently
        state = agent.get_state(config)
        tasks = getattr(state, "tasks", None) or ()
        pending = []
        for t in tasks:
            ints = getattr(t, "interrupts", None) or ()
            pending.extend(ints)
        if not pending and not interrupts:
            break
        print(f"  approval needed ({len(pending) or len(interrupts)}); approving")
        payload = Command(resume={"decisions": [{"type": "approve"}]})
    else:
        print("exhausted steps", file=sys.stderr)

    if not target.is_file():
        # search workspace
        svgs = list(ws.rglob("*.svg"))
        print("no pelican-bike.svg; found:", [str(p) for p in svgs])
        return 1
    text = target.read_text(encoding="utf-8")
    print(f"wrote {target} ({len(text)} bytes)")
    print(text[:240].replace("\n", " "))
    ok = "<svg" in text.lower() and (
        "pelican" in text.lower() or "bicycle" in text.lower() or "bike" in text.lower()
        or "circle" in text.lower()  # shapes often present
    )
    return 0 if "<svg" in text.lower() else 1


if __name__ == "__main__":
    raise SystemExit(main())
