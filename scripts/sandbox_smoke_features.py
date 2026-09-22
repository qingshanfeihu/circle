#!/usr/bin/env python3
"""Live sandbox smoke: harness extras + headless TUI against seeded CIRCLE_HOME.

Uses the sandbox home (API URL+KEY already seeded). Does not print secrets.

  CIRCLE_HOME=…/circle-sandbox/home \\
  CIRCLE_WORKSPACE=…/circle-sandbox/workspace \\
  .venv/bin/python scripts/sandbox_smoke_features.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from circle.harness import create_harness
from circle.model import build_chat_model
from circle.prompt_features import (
    build_extra_tools,
    compact_messages,
    explore_subagent_spec,
    plan_mode_append,
)
from circle.settings import apply_auth_to_environ, load_settings
from circle.system_prompt import build_system_prompt
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import hotkeys_text, parse_slash


def _ok(name: str, detail: str = "") -> None:
    print(f"[OK]   {name}" + (f" — {detail}" if detail else ""), flush=True)


def _fail(name: str, detail: str) -> None:
    print(f"[FAIL] {name} — {detail}", flush=True)


def main() -> int:
    home = Path(os.environ.get("CIRCLE_HOME", Path.home() / ".circle")).resolve()
    ws = Path(
        os.environ.get(
            "CIRCLE_WORKSPACE",
            str(Path(__file__).resolve().parents[2] / "circle-sandbox" / "workspace"),
        )
    ).resolve()
    ws.mkdir(parents=True, exist_ok=True)

    settings = load_settings(home)
    if not settings.is_ready():
        _fail("auth", f"settings not ready under {home}")
        return 2
    apply_auth_to_environ(settings, home)
    _ok(
        "auth",
        f"{settings.auth.protocol}/{settings.auth.model} @ {settings.auth.base_url}",
    )

    failures = 0

    # --- prompt / feature units (no network) ---
    spec = explore_subagent_spec()
    if spec.get("name") != "explore":
        _fail("explore", "missing subagent")
        failures += 1
    else:
        _ok("explore", "subagent spec")

    tools = {t.name: t for t in build_extra_tools()}
    blocked = tools["webfetch"].invoke({"url": "http://127.0.0.1/"})
    if "refusing" not in blocked.lower():
        _fail("webfetch-ssrf", blocked[:120])
        failures += 1
    else:
        _ok("webfetch-ssrf", "localhost blocked")

    q = tools["question"].invoke(
        {"questions": [{"question": "Ship?", "options": ["yes", "no"]}]}
    )
    if "USER_QUESTIONS" not in q or "Ship?" not in q:
        _fail("question", q[:120])
        failures += 1
    else:
        _ok("question", "formats options")

    if "Plan mode" not in plan_mode_append():
        _fail("plan-append", "missing plan-mode.md")
        failures += 1
    else:
        _ok("plan-append")

    prompt = build_system_prompt(
        cwd=ws, model_id=settings.auth.model, protocol=settings.auth.protocol
    )
    for needle in ("Circle", "read_file", "webfetch", "question", "task"):
        if needle not in prompt:
            _fail("system-prompt", f"missing {needle}")
            failures += 1
            break
    else:
        _ok("system-prompt", f"{len(prompt)} chars")

    # --- live model ---
    try:
        model = build_chat_model(settings, home=home)
        ping = model.invoke([{"role": "user", "content": "Reply with exactly: pong"}])
        text = getattr(ping, "content", ping)
        if isinstance(text, list):
            text = " ".join(
                str(b.get("text") if isinstance(b, dict) else b) for b in text
            )
        text = str(text)
        if "pong" not in text.lower():
            _fail("llm-ping", repr(text)[:200])
            failures += 1
        else:
            _ok("llm-ping", "pong")
    except Exception as exc:  # noqa: BLE001
        _fail("llm-ping", repr(exc))
        failures += 1
        return 1

    # compact helper with live model
    try:
        msgs = compact_messages(
            transcript="user: add /plan\nassistant: done",
            hint="one line",
        )
        out = model.invoke(msgs)
        body = getattr(out, "content", out)
        if isinstance(body, list):
            body = " ".join(
                str(b.get("text") if isinstance(b, dict) else b) for b in body
            )
        if not str(body).strip():
            _fail("compact-live", "empty")
            failures += 1
        else:
            _ok("compact-live", str(body).splitlines()[0][:80])
    except Exception as exc:  # noqa: BLE001
        _fail("compact-live", repr(exc))
        failures += 1

    # harness build + one-shot tool-less turn
    try:
        agent = create_harness(
            model,
            root_dir=ws,
            home=home,
            model_id=settings.auth.model,
            protocol=settings.auth.protocol,
        )
        result = agent.invoke(
            {
                "messages": [
                    {
                        "role": "user",
                        "content": "What is 17+25? Reply with only the number.",
                    }
                ]
            },
            config={"configurable": {"thread_id": "circle-smoke"}},
        )
        messages = (result or {}).get("messages") or []
        last = messages[-1] if messages else None
        content = getattr(last, "content", None) if last is not None else None
        content = _message_plain(content)
        if "42" not in content:
            _fail("harness-invoke", repr(content)[:240])
            failures += 1
        else:
            _ok("harness-invoke", "42")
    except Exception as exc:  # noqa: BLE001
        _fail("harness-invoke", repr(exc))
        failures += 1

    # headless TUI: slash surface + short live turn
    try:
        app = CircleSessionApp(settings, ws, home=home)
        app._on_submit("/help")  # noqa: SLF001
        app._on_submit("/hotkeys")  # noqa: SLF001
        app._on_submit("/plan on")  # noqa: SLF001
        snap = "\n".join(app._transcript.snapshot())  # noqa: SLF001
        if "plan mode" not in snap.lower() and "Plan" not in snap:
            _fail("tui-plan", snap[-400:])
            failures += 1
        else:
            _ok("tui-plan", "toggled on")
        if "ctrl+t" not in hotkeys_text() or "ctrl+o" not in hotkeys_text():
            _fail("hotkeys", "missing ctrl bindings")
            failures += 1
        else:
            _ok("hotkeys", "ctrl+t/ctrl+o present")
        if parse_slash("/summarize") is None:
            _fail("slash-alias", "summarize")
            failures += 1
        else:
            _ok("slash-alias", "summarize→compact")

        app._on_submit("/plan off")  # noqa: SLF001
        before = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit("What is 9*9? Reply with only the number.")  # noqa: SLF001
        deadline = time.time() + 90
        saw = False
        snap = ""
        while time.time() < deadline:
            lines = app._transcript.snapshot()  # noqa: SLF001
            tail_lines = lines[before:]
            for ln in tail_lines:
                plain = _strip(ln).strip()
                if plain.startswith(">") or "9*9" in plain or "What is" in plain:
                    continue
                # assistant glyph / bare answer
                if re.search(r"\b81\b", plain):
                    saw = True
                    break
            if saw:
                snap = "\n".join(tail_lines)
                break
            joined = "\n".join(tail_lines)
            if "✖" in joined:
                snap = joined
                break
            time.sleep(0.2)
        if not saw:
            _fail("tui-chat", (snap or "\n".join(app._transcript.snapshot()))[-500:])  # noqa: SLF001
            failures += 1
        else:
            _ok("tui-chat", "81")
        lines = [
            _strip(l) for l in app._transcript.snapshot()[-18:]  # noqa: SLF001
        ]
        print("--- TUI transcript tail ---", flush=True)
        for line in lines:
            print(line[:120], flush=True)
        print("--- end ---", flush=True)
        try:
            app._bridge.cancel()  # noqa: SLF001
        except Exception:  # noqa: BLE001
            pass
    except Exception as exc:  # noqa: BLE001
        _fail("tui", repr(exc))
        failures += 1

    return 1 if failures else 0


def _message_plain(content) -> str:
    if content is None:
        return ""
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text") or ""))
                elif "text" in block:
                    parts.append(str(block.get("text") or ""))
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(content)


def _strip(s: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", s)


if __name__ == "__main__":
    raise SystemExit(main())
