#!/usr/bin/env python3
"""Exercise every built-in slash command headlessly and report per-command status."""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from langchain_core.messages import AIMessage

from circle.oauth import start_oauth_login
from circle.settings import load_credentials, load_settings, save_settings
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import ALIAS_TO_CANONICAL, BUILTIN_SLASH


class Results:
    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str]] = []

    def ok(self, name: str, detail: str = "") -> None:
        self.rows.append((name, True, detail))
        print(f"[OK]   /{name}" + (f" — {detail}" if detail else ""))

    def fail(self, name: str, detail: str) -> None:
        self.rows.append((name, False, detail))
        print(f"[FAIL] /{name} — {detail}")


def _ready(tmp: Path) -> CircleSessionApp:
    os.environ["CIRCLE_OAUTH_MOCK"] = "1"
    home = tmp / "home"
    ws = tmp / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    assert init.settings is not None
    TrustController(init.settings, ws, home=home).confirm()
    # Plenty of scripted replies for compact / reload paths that invoke the model.
    model = ScriptedModel(
        responses=[AIMessage(content=f"scripted-{i}") for i in range(20)]
    )
    return CircleSessionApp(init.settings, ws, home=home, model_override=model)


def _snap(app: CircleSessionApp) -> str:
    return "\n".join(app._transcript.snapshot())  # noqa: SLF001


def _wait_idle(app: CircleSessionApp, timeout: float = 8.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not app._is_loading and not app._bridge.is_running:  # noqa: SLF001
            return
        time.sleep(0.05)
    raise TimeoutError("bridge still busy")


def main() -> int:
    r = Results()
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        app = _ready(tmp)

        # Seed some transcript so archive/export/share/compact have content.
        app._transcript.append_message("seed line one")  # noqa: SLF001
        app._transcript.append_message("seed line two")  # noqa: SLF001
        app._session_title = "seed"  # noqa: SLF001
        app._last_assistant_plain = "assistant says hi"  # noqa: SLF001

        # ---- help / hotkeys / exit aliases parse ----
        try:
            app._on_submit("/help")  # noqa: SLF001
            assert "Available commands" in _snap(app)
            for cmd in BUILTIN_SLASH:
                assert f"/{cmd.name}" in _snap(app), cmd.name
            r.ok("help", f"{len(BUILTIN_SLASH)} cmds listed")
        except Exception as exc:  # noqa: BLE001
            r.fail("help", str(exc))

        try:
            app._on_submit("/hotkeys")  # noqa: SLF001
            assert "Keyboard shortcuts" in _snap(app)
            r.ok("hotkeys")
        except Exception as e:  # noqa: BLE001
            r.fail("hotkeys", str(e))

        # ---- name / session / settings / themes / mcp ----
        try:
            app._on_submit("/name slash-demo")  # noqa: SLF001
            assert app._session_title == "slash-demo"  # noqa: SLF001
            r.ok("name")
        except Exception as e:  # noqa: BLE001
            r.fail("name", str(e))

        try:
            app._on_submit("/session")  # noqa: SLF001
            assert app._thread_id in _snap(app)  # noqa: SLF001
            r.ok("session")
        except Exception as e:  # noqa: BLE001
            r.fail("session", str(e))

        try:
            app._on_submit("/settings")  # noqa: SLF001
            assert "settings" in _snap(app)
            r.ok("settings")
        except Exception as e:  # noqa: BLE001
            r.fail("settings", str(e))

        try:
            app._on_submit("/themes")  # noqa: SLF001
            app._on_submit("/themes dark")  # noqa: SLF001
            assert load_settings(app.home).theme == "dark"
            r.ok("themes", "dark")
        except Exception as e:  # noqa: BLE001
            r.fail("themes", str(e))

        try:
            app._on_submit("/mcp")  # noqa: SLF001
            assert "MCP" in _snap(app) or "mcp" in _snap(app).lower()
            # with configured servers
            app.settings.mcp_servers = [{"name": "demo", "command": "echo"}]
            save_settings(app.settings, app.home)
            app._on_submit("/mcp")  # noqa: SLF001
            assert "demo" in _snap(app)
            r.ok("mcp")
        except Exception as e:  # noqa: BLE001
            r.fail("mcp", str(e))

        # ---- thinking / details ----
        try:
            before = app._show_thinking  # noqa: SLF001
            app._on_submit("/thinking")  # noqa: SLF001
            assert app._show_thinking is (not before)  # noqa: SLF001
            r.ok("thinking")
        except Exception as e:  # noqa: BLE001
            r.fail("thinking", str(e))

        try:
            before = app._show_details  # noqa: SLF001
            app._on_submit("/details")  # noqa: SLF001
            assert app._show_details is (not before)  # noqa: SLF001
            r.ok("details")
        except Exception as e:  # noqa: BLE001
            r.fail("details", str(e))

        # ---- copy / export / import / share / unshare ----
        try:
            # Force file fallback by stubbing clipboard
            app._clipboard_set = lambda _t: False  # type: ignore[method-assign]  # noqa: SLF001
            app._on_submit("/copy")  # noqa: SLF001
            assert (app.home / "exports" / "last-copy.txt").is_file()
            r.ok("copy", "file fallback")
        except Exception as e:  # noqa: BLE001
            r.fail("copy", str(e))

        export_path = app.home / "exports" / "roundtrip.md"
        try:
            app._on_submit(f"/export {export_path}")  # noqa: SLF001
            assert export_path.is_file()
            r.ok("export", str(export_path.name))
        except Exception as e:  # noqa: BLE001
            r.fail("export", str(e))

        try:
            app._on_submit(f"/import {export_path}")  # noqa: SLF001
            assert "Circle session" in _snap(app) or "seed" in _snap(app)
            r.ok("import")
        except Exception as e:  # noqa: BLE001
            r.fail("import", str(e))

        try:
            app._on_submit("/share")  # noqa: SLF001
            assert app._share_path is not None and app._share_path.is_file()  # noqa: SLF001
            shared = app._share_path  # noqa: SLF001
            app._on_submit("/unshare")  # noqa: SLF001
            assert not shared.is_file()
            assert app._share_path is None  # noqa: SLF001
            r.ok("share")
            r.ok("unshare")
        except Exception as e:  # noqa: BLE001
            r.fail("share/unshare", str(e))

        # ---- init / trust ----
        try:
            agents = app.workspace / "AGENTS.md"
            if agents.exists():
                agents.unlink()
            app._on_submit("/init")  # noqa: SLF001
            assert agents.is_file()
            app._on_submit("/init")  # noqa: SLF001
            assert "Generated by Circle" in agents.read_text(encoding="utf-8")
            r.ok("init")
        except Exception as e:  # noqa: BLE001
            r.fail("init", str(e))

        try:
            # already trusted from setup
            app._on_submit("/trust")  # noqa: SLF001
            assert "已信任" in _snap(app) or ".agent" in _snap(app)
            r.ok("trust")
        except Exception as e:  # noqa: BLE001
            r.fail("trust", str(e))

        # ---- models (list only; switch would drop ScriptedModel) ----
        try:
            app._on_submit("/models")  # noqa: SLF001
            assert "当前模型" in _snap(app) or "用法" in _snap(app)
            r.ok("models", "list")
        except Exception as e:  # noqa: BLE001
            r.fail("models", str(e))

        # ---- new / clear / resume / continue / sessions ----
        old_tid = app._thread_id  # noqa: SLF001
        try:
            app._transcript.append_message("before-new")  # noqa: SLF001
            app._session_title = "before-new"  # noqa: SLF001
            app._on_submit("/new")  # noqa: SLF001
            assert app._thread_id != old_tid  # noqa: SLF001
            assert any(x.thread_id == old_tid for x in app._archive)  # noqa: SLF001
            r.ok("new")
        except Exception as e:  # noqa: BLE001
            r.fail("new", str(e))

        try:
            app._on_submit("/clear")  # noqa: SLF001
            mid = app._thread_id  # noqa: SLF001
            app._transcript.append_message("keep-me")  # noqa: SLF001
            app._session_title = "keep-me"  # noqa: SLF001
            app._archive_current()  # noqa: SLF001
            app._on_submit("/sessions")  # noqa: SLF001
            assert "用法" in _snap(app) or old_tid in _snap(app)
            app._on_submit(f"/resume {old_tid}")  # noqa: SLF001
            assert app._thread_id == old_tid  # noqa: SLF001
            r.ok("resume", "incl /sessions alias")
            # continue back
            app._on_submit("/continue")  # noqa: SLF001
            assert app._thread_id != old_tid  # noqa: SLF001
            r.ok("continue")
            _ = mid
        except Exception as e:  # noqa: BLE001
            r.fail("resume/continue", str(e))

        # ---- undo / redo ----
        try:
            app._push_undo_checkpoint()  # noqa: SLF001
            app._transcript.append_message("UNDO_MARKER")  # noqa: SLF001
            app._on_submit("/undo")  # noqa: SLF001
            assert "UNDO_MARKER" not in _snap(app)
            app._on_submit("/redo")  # noqa: SLF001
            assert "UNDO_MARKER" in _snap(app)
            r.ok("undo")
            r.ok("redo")
        except Exception as e:  # noqa: BLE001
            r.fail("undo/redo", str(e))

        # ---- compact (async) ----
        try:
            # Ensure scripted model is what compact uses
            app.model_override = ScriptedModel(
                responses=[AIMessage(content="SUMMARY_LINE_OK")]
            )
            app._transcript.append_message("compact a")  # noqa: SLF001
            app._transcript.append_message("compact b")  # noqa: SLF001
            app._on_submit("/summarize")  # noqa: SLF001
            _wait_idle(app, timeout=15)
            snap = _snap(app)
            if "compact 失败" in snap:
                raise AssertionError(snap[-400:])
            assert "compacted" in snap.lower() or "SUMMARY_LINE_OK" in snap
            r.ok("compact", "via /summarize")
        except Exception as e:  # noqa: BLE001
            r.fail("compact", repr(e))

        # ---- login / logout / connect ----
        try:
            app._on_submit("/login")  # noqa: SLF001
            app._on_submit("/connect openai")  # noqa: SLF001
            assert load_settings(app.home).auth.oauth_provider == "openai"
            assert load_credentials(app.home).get("oauth_access_token")
            r.ok("login", "via /connect openai")
            app._on_submit("/logout")  # noqa: SLF001
            assert load_credentials(app.home) == {}
            r.ok("logout")
        except Exception as e:  # noqa: BLE001
            r.fail("login/logout", str(e))

        # ---- reload (uses ScriptedModel override still if set) ----
        try:
            # Re-login so reload has credentials/model
            os.environ["CIRCLE_OAUTH_MOCK"] = "1"
            app._on_submit("/login anthropic")  # noqa: SLF001
            app.model_override = ScriptedModel(responses=[AIMessage(content="reloaded")])
            app._on_submit("/reload")  # noqa: SLF001
            assert "重新加载" in _snap(app) or "reload" in _snap(app).lower()
            r.ok("reload")
        except Exception as e:  # noqa: BLE001
            r.fail("reload", str(e))

        # ---- editor (fake $EDITOR) ----
        try:
            editor_sh = tmp / "fake-editor.sh"
            editor_sh.write_text(
                "#!/bin/sh\nprintf 'from-editor\\n' > \"$1\"\n",
                encoding="utf-8",
            )
            editor_sh.chmod(0o755)
            os.environ["EDITOR"] = str(editor_sh)
            os.environ.pop("VISUAL", None)

            # Avoid full terminal stop/start: call body with stubs
            suspended = {"n": 0}
            resumed = {"n": 0}

            def _suspend() -> None:
                suspended["n"] += 1

            def _resume() -> None:
                resumed["n"] += 1

            app._app.suspend_for_external = _suspend  # type: ignore[method-assign]  # noqa: SLF001
            app._app.resume_from_external = _resume  # type: ignore[method-assign]  # noqa: SLF001
            app._app._running = True  # noqa: SLF001
            app._prompt.set_value("old")  # noqa: SLF001
            app._on_submit("/editor")  # noqa: SLF001
            assert "from-editor" in app._prompt.value  # noqa: SLF001
            assert suspended["n"] == 1 and resumed["n"] == 1
            assert app._app._running is True  # noqa: SLF001
            r.ok("editor", "keeps session running")
        except Exception as e:  # noqa: BLE001
            r.fail("editor", str(e))

        # ---- exit / quit / q ----
        try:
            app._app._running = True  # noqa: SLF001
            app._on_submit("/q")  # noqa: SLF001
            assert app._app._running is False  # noqa: SLF001
            r.ok("exit", "via /q")
        except Exception as e:  # noqa: BLE001
            r.fail("exit", str(e))

        # Coverage: every canonical name was attempted
        covered = {name for name, ok, _ in r.rows if ok}
        # map combined rows
        covered |= {n for n, ok, _ in r.rows if ok for n in n.split("/")}
        missing = []
        for cmd in BUILTIN_SLASH:
            # accept if any row mentions the command
            if not any(cmd.name in name for name, ok, _ in r.rows if ok):
                missing.append(cmd.name)
        if missing:
            r.fail("coverage", f"missing OK for: {', '.join(missing)}")
        else:
            r.ok("coverage", f"all {len(BUILTIN_SLASH)} canonical cmds exercised")

        # Alias map sanity
        try:
            assert ALIAS_TO_CANONICAL["clear"] == "new"
            assert ALIAS_TO_CANONICAL["connect"] == "login"
            assert ALIAS_TO_CANONICAL["sessions"] == "resume"
            r.ok("aliases")
        except Exception as e:  # noqa: BLE001
            r.fail("aliases", str(e))

    failed = [row for row in r.rows if not row[1]]
    print()
    print(f"passed={sum(1 for _, ok, _ in r.rows if ok)} failed={len(failed)}")
    if failed:
        for name, _, detail in failed:
            print(f"  - /{name}: {detail}")
        return 1
    return 0


if __name__ == "__main__":
    # silence unused
    _ = threading
    raise SystemExit(main())
