#!/usr/bin/env python3
"""Headless selftest for stream + thinking path (no TTY / no user).

Exercises:
1. content_blocks parse (thinking vs text)
2. HarnessBridge + ScriptedModel stream/invoke → StreamUpdate sequence
3. CircleSessionApp._on_stream_update transcript/footer without starting InkApp
4. Optional live gateway probe (best-effort; failures are reported, not fatal)
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

# Ensure repo root on path when run as script
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from langchain_core.messages import AIMessage, AIMessageChunk

from circle.oauth import start_oauth_login
from circle.testing import ScriptedModel
from circle.tui.content_blocks import (
    assistant_block,
    message_text,
    parse_content,
    thinking_preview,
)
from circle.tui.controllers import InitController, TrustController
from circle.tui.harness_bridge import HarnessBridge, StreamUpdate
from circle.tui.session_app import CircleSessionApp


def check(name: str, ok: bool, detail: str = "") -> None:
    mark = "OK" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise SystemExit(1)


def test_content_blocks() -> None:
    content = [
        {"type": "thinking", "thinking": "step A\nstep B"},
        {"type": "text", "text": "Hello"},
    ]
    p = parse_content(content)
    check("split thinking/text", p.text == "Hello" and "step B" in p.thinking)
    check("message_text strips thinking", message_text(content) == "Hello")
    check("thinking_preview last line", thinking_preview(content) == "step B")
    block = assistant_block("hi\nthere")
    check("assistant_block glyph", "hi" in block and "there" in block)


def test_bridge_scripted() -> None:
    updates: list[StreamUpdate] = []
    done: list[str] = []
    errors: list[BaseException] = []

    # ScriptedModel returns full AIMessages via invoke; stream may not yield.
    # Use responses that include thinking+text content blocks.
    mixed = AIMessage(
        content=[
            {"type": "thinking", "thinking": "planning reply"},
            {"type": "text", "text": "hi from scripted"},
        ]
    )
    model = ScriptedModel(responses=[mixed])
    from circle.harness import create_harness

    with tempfile.TemporaryDirectory() as tmp:
        agent = create_harness(model, root_dir=tmp)
        bridge = HarnessBridge(
            agent=agent,
            thread_id="selftest-bridge",
            on_update=updates.append,
            on_interrupt=lambda _i: None,
            on_done=done.append,
            on_error=errors.append,
        )
        bridge.start("hello")
        deadline = time.time() + 10
        while bridge.is_running and time.time() < deadline:
            time.sleep(0.05)
        check("bridge finished", not bridge.is_running, f"errors={errors}")
        check("no bridge error", not errors, str(errors))
        check("on_done fired", bool(done), repr(done))
        check(
            "done text visible only",
            done and "hi from scripted" in done[0] and "planning" not in done[0],
            repr(done),
        )


def test_session_update_path() -> None:
    os.environ["CIRCLE_OAUTH_MOCK"] = "1"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        home = root / "home"
        ws = root / "ws"
        ws.mkdir()
        init = InitController(home=home, oauth_login=start_oauth_login)
        init.submit_line("2")
        init.confirm()
        init.confirm()
        assert init.settings is not None
        TrustController(init.settings, ws, home=home).confirm()

        # Build session app but do NOT start InkApp terminal — drive updates directly.
        # Avoid real model: patch agent after construct by overriding bridge callbacks only.
        model = ScriptedModel(
            responses=[AIMessage(content=[{"type": "text", "text": "ok"}])]
        )
        app = CircleSessionApp(
            init.settings, ws, home=home, model_override=model
        )
        # Don't call app.run(); poke stream handler under lock-free path
        app._call_started_at = time.time()
        app._is_loading = True
        app._on_stream_update(
            StreamUpdate(
                thinking="considering",
                thinking_done=False,
                reasoning_last_line="considering",
                reasoning_chars=11,
                llm_phase="thinking",
            )
        )
        check(
            "thinking row created",
            app._thinking_idx >= 0,
            f"idx={app._thinking_idx}",
        )
        think_msg = app._transcript.message_at(app._thinking_idx) or ""
        check("thinking glyph", "Thinking" in think_msg or "∴" in think_msg, think_msg)

        app._on_stream_update(
            StreamUpdate(
                text="Hello world",
                thinking="considering",
                thinking_done=True,
                llm_phase="output",
                cumulative=True,
            )
        )
        check("stream row created", app._stream_idx >= 0)
        stream_msg = app._transcript.message_at(app._stream_idx) or ""
        check("assistant visible text", "Hello world" in stream_msg, stream_msg)
        check("thinking not in assistant row", "considering" not in stream_msg)

        app._on_done("Hello world")
        final = app._transcript.message_at(app._stream_idx if app._stream_idx >= 0 else app._transcript.message_count() - 1) or ""
        # after done stream_idx reset; check last messages contain Hello
        all_msgs = [app._transcript.message_at(i) or "" for i in range(app._transcript.message_count())]
        check("final has Hello", any("Hello world" in m for m in all_msgs), repr(all_msgs[-3:]))


def test_live_gateway_best_effort() -> None:
    """Probe user's configured endpoint; report only — does not fail the suite."""
    try:
        from circle.settings import load_settings
        from circle.model import build_chat_model

        settings = load_settings()
        if not settings.is_ready():
            print("[SKIP] live gateway — settings not ready")
            return
        model = build_chat_model(settings)
        t0 = time.time()
        try:
            # Short prompt; respect model timeout
            chunks = 0
            for chunk in model.stream("Reply with exactly: pong"):
                chunks += 1
                if chunks >= 3:
                    break
            print(
                f"[LIVE] gateway stream ok chunks={chunks} "
                f"elapsed={time.time() - t0:.1f}s "
                f"url={settings.auth.base_url} model={settings.auth.model}"
            )
        except Exception as exc:  # noqa: BLE001
            print(
                f"[LIVE] gateway FAILED after {time.time() - t0:.1f}s: "
                f"{type(exc).__name__}: {exc}"
            )
    except Exception as exc:  # noqa: BLE001
        print(f"[LIVE] skipped: {exc}")


def main() -> int:
    print("=== Circle stream/thinking selftest ===")
    test_content_blocks()
    test_bridge_scripted()
    test_session_update_path()
    test_live_gateway_best_effort()
    print("=== ALL SELFTESTS PASSED ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
