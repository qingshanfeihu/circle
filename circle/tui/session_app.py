"""Circle session shell — IstInkApp session ring without compile/KMS.

Layout matches InfoTest: transcript · ask panel · thinking · divider ·
prompt · divider · footer. Streaming + exec approval via HarnessBridge.
"""

from __future__ import annotations

import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from circle.harness import create_harness
from circle.ink.app import InkApp
from circle.ink.components.ask_user_panel import AskUserPanel
from circle.ink.components.exec_approval_view import ExecApprovalSession
from circle.ink.components.footer import FooterPane
from circle.ink.components.prompt_input import PromptInput
from circle.ink.components.transcript import Transcript
from circle.ink.dom import NodeType, create_element, create_fill_text, create_text
from circle.ink.parse_keypress import InputEvent, KeyPress, PasteEvent
from circle.ink.theme import GLYPH_AGENT, init_palette_from_terminal, palette
from circle.model import build_chat_model
from circle.paths import circle_home, normalize_workspace
from circle.settings import CircleSettings, apply_auth_to_environ, is_folder_trusted, load_settings
from circle.tui.content_blocks import assistant_block, render_thinking_line
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.harness_bridge import HarnessBridge, StreamUpdate


def _format_llm_error(exc: BaseException) -> str:
    """Make gateway / Anthropic errors readable in the transcript."""
    msg = str(exc)
    # Anthropic-style: {'type': 'error', 'error': {'message': '...'}}
    if "Service temporarily unavailable" in msg or "did not respond" in msg:
        return (
            "模型网关暂时不可用（未返回响应）。"
            "请稍后重试，或检查 base_url / 模型名是否可用。"
        )
    if "timeout" in msg.lower() or "timed out" in msg.lower():
        return f"请求超时：{msg}"
    # Prefer nested message if present
    if "'message':" in msg:
        import re

        m = re.search(r"'message':\s*'([^']+)'", msg)
        if m:
            return m.group(1)
    return msg


class CircleSessionApp:
    """InfoTest-style session loop bound to Circle's harness."""

    def __init__(
        self,
        settings: CircleSettings,
        workspace: Path,
        *,
        home: Path | None = None,
        model_override: Any | None = None,
    ) -> None:
        self.settings = settings
        self.workspace = normalize_workspace(workspace)
        self.home = home or circle_home()
        self.model_override = model_override

        apply_auth_to_environ(settings, self.home)
        init_palette_from_terminal()

        self._app = InkApp(alt_screen=True, mouse=False)
        self._transcript = Transcript()
        self._ask_panel = AskUserPanel()
        self._thinking_line = create_element(NodeType.BOX)
        self._thinking_line.style.height = 0
        self._thinking_text = create_text("")
        self._thinking_line.append_child(self._thinking_text)

        self._prompt = PromptInput(
            cursor_manager=self._app.cursor,
            on_submit=self._on_submit,
            placeholder="输入消息（/exit 离开）",
        )
        self._footer = FooterPane(
            render_callback=self._app.render,
            thinking_text_cb=self._update_thinking_line,
        )
        self._footer.update(model=settings.auth.model, status="ready")

        self._divider_top = create_element(NodeType.BOX)
        self._divider_top.style.height = 1
        self._divider_top.text_styles.dim = True
        self._divider_top.append_child(create_fill_text("─"))
        self._divider_bottom = create_element(NodeType.BOX)
        self._divider_bottom.style.height = 1
        self._divider_bottom.text_styles.dim = True
        self._divider_bottom.append_child(create_fill_text("─"))

        root = self._app.root
        root.append_child(self._transcript.node)
        root.append_child(self._ask_panel.node)
        root.append_child(self._thinking_line)
        root.append_child(self._divider_top)
        root.append_child(self._prompt.node)
        root.append_child(self._divider_bottom)
        root.append_child(self._footer.node)

        self._app.on_input = self._handle_input

        self._is_loading = False
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        self._thinking_expanded = False
        self._call_started_at = 0.0
        self._exec_approval: ExecApprovalSession | None = None
        self._ask_saved_prompt = ""
        self._last_ctrl_c = 0.0
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"

        model = build_chat_model(
            settings, home=self.home, model_override=model_override
        )
        self._agent = create_harness(model, root_dir=self.workspace)
        self._bridge = HarnessBridge(
            agent=self._agent,
            thread_id=self._thread_id,
            on_update=self._on_stream_update,
            on_interrupt=self._on_interrupt,
            on_done=self._on_done,
            on_error=self._on_error,
            on_status=self._on_status,
        )

    def run(self) -> int:
        self._app.start()
        try:
            self._show_welcome()
            while self._app._running:  # noqa: SLF001
                time.sleep(0.05)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                self._footer.shutdown()
            except Exception:  # noqa: BLE001
                pass
            self._bridge.cancel()
            self._app.stop()
        return 0

    def _show_welcome(self) -> None:
        p = palette()
        self._transcript.append_message(
            f" {GLYPH_AGENT} Circle · {self.workspace}"
        )
        self._transcript.append_message(
            f" \x1b[2m{self.settings.auth.protocol} / {self.settings.auth.model}\x1b[0m"
        )
        self._transcript.append_message("")
        self._footer.update(status="ready")
        self._app.render()

    def _update_thinking_line(self, text: str) -> None:
        if not text:
            self._thinking_line.style.height = 0
            self._thinking_text.set_value("")
            return
        self._thinking_text.set_value(f" \x1b[2m{text}\x1b[0m")
        self._thinking_line.style.height = 1

    # ── input ──────────────────────────────────────────────────────────

    def _handle_input(self, event: InputEvent) -> None:
        if isinstance(event, PasteEvent):
            self._prompt.handle_paste(event.text)
            self._app.render()
            return
        if not isinstance(event, KeyPress):
            return
        self._handle_key(event)

    def _handle_key(self, kp: KeyPress) -> None:
        if self._exec_approval is not None:
            if self._exec_approval.handle_key(kp.key, kp.char):
                return

        if kp.key == "ctrl+c":
            now = time.time()
            if self._is_loading:
                self._bridge.cancel()
                self._transcript.append_message(" \x1b[2m(cancelled)\x1b[0m")
                self._leave_busy()
                self._app.render()
                self._last_ctrl_c = now
                return
            if now - self._last_ctrl_c < 1.5:
                self._app._running = False  # noqa: SLF001
                return
            self._last_ctrl_c = now
            self._transcript.append_message(
                " \x1b[2m(press ctrl+c again to exit)\x1b[0m"
            )
            self._app.render()
            return

        if kp.key == "escape":
            if self._is_loading:
                self._bridge.cancel()
                self._transcript.append_message(" \x1b[2m(cancelled)\x1b[0m")
                self._leave_busy()
            else:
                self._prompt.clear()
            self._app.render()
            return

        if kp.key == "ctrl+t":
            self._thinking_expanded = not self._thinking_expanded
            self._refresh_thinking_row()
            self._app.render()
            return

        if kp.key in {"up", "pageup"}:
            self._transcript.scroll_up(3)
            self._app.render()
            return
        if kp.key in {"down", "pagedown"}:
            self._transcript.scroll_down(3)
            self._app.render()
            return

        if self._prompt.handle_key(
            kp.key if kp.key else "char",
            kp.char if len(kp.char) == 1 else "",
        ):
            self._app.render()

    def _on_submit(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if text in {"/exit", "/quit"}:
            self._app._running = False  # noqa: SLF001
            return
        if text == "/help":
            self._transcript.append_message(
                " \x1b[2m/exit 离开 · esc 取消本轮 · ctrl+c 两次退出\x1b[0m"
            )
            self._app.render()
            return
        if self._bridge.is_running or self._is_loading:
            self._transcript.append_message(" \x1b[2m(busy — 等待当前回合完成)\x1b[0m")
            self._app.render()
            return

        if self._transcript.message_count() > 0:
            w = max(40, self._transcript.node.rect.width or 80)
            self._transcript.append_message(f"\x1b[2m{'─' * w}\x1b[0m")
        self._transcript.append_message("")
        for line in text.split("\n"):
            self._transcript.append_message(f" \x1b[2m>\x1b[0m {line}")
        self._transcript.append_message("")
        self._enter_busy()
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        self._call_started_at = time.time()
        self._app.render()
        self._bridge.start(text)

    # ── busy / footer ──────────────────────────────────────────────────

    def _enter_busy(self) -> None:
        self._is_loading = True
        self._footer.update(
            status="running",
            llm_phase="thinking",
            call_started_at=self._call_started_at or time.time(),
            reasoning_active=True,
        )

    def _leave_busy(self) -> None:
        self._is_loading = False
        self._footer.update(
            status="ready",
            llm_phase="",
            output_token_count=0,
            reasoning_active=False,
            reasoning_last_line="",
            reasoning_chars=0,
            call_started_at=None,
        )
        self._update_thinking_line("")
        self._call_started_at = 0.0

    def _on_status(self, status: str) -> None:
        with self._app.lock:
            if status == "thinking":
                self._footer.update(
                    status="running",
                    llm_phase="thinking",
                    call_started_at=self._call_started_at or time.time(),
                    reasoning_active=True,
                )
            elif status == "approval":
                self._footer.update(status="running", llm_phase="", reasoning_active=False)
            elif status in {"ready", "cancelled"}:
                self._leave_busy()
            self._app.render()

    # ── stream callbacks — mirrors IstInkApp._on_snapshot stream/thinking ─

    def _on_stream_update(self, update: StreamUpdate) -> None:
        with self._app.lock:
            # Thinking-only phase (InfoTest: streaming_text is None, llm_phase=thinking)
            if update.thinking and not update.text:
                self._thinking_body = update.thinking
                self._refresh_thinking_row(done=update.thinking_done)
                self._footer.update(
                    status="running",
                    llm_phase="thinking",
                    call_started_at=self._call_started_at or time.time(),
                    reasoning_active=not update.thinking_done,
                    reasoning_last_line=update.reasoning_last_line,
                    reasoning_chars=update.reasoning_chars or len(update.thinking),
                )
                self._app.render()
                return

            if update.thinking:
                self._thinking_body = update.thinking
                self._refresh_thinking_row(done=update.thinking_done)

            if update.text:
                self._stream_buf = update.text
                rendered = assistant_block(self._stream_buf)
                if self._stream_idx < 0:
                    self._transcript.append_message(rendered)
                    self._stream_idx = self._transcript.message_count() - 1
                else:
                    self._transcript.update_message_at(self._stream_idx, rendered)
                self._footer.update(
                    status="running",
                    llm_phase=update.llm_phase or "output",
                    call_started_at=self._call_started_at or time.time(),
                    reasoning_active=bool(update.thinking) and not update.thinking_done,
                    reasoning_last_line=update.reasoning_last_line,
                    reasoning_chars=update.reasoning_chars,
                    output_token_count=max(1, len(update.text) // 4),
                )
            elif update.llm_phase == "thinking":
                self._footer.update(
                    status="running",
                    llm_phase="thinking",
                    call_started_at=self._call_started_at or time.time(),
                    reasoning_active=True,
                    reasoning_last_line=update.reasoning_last_line,
                    reasoning_chars=update.reasoning_chars,
                )
            self._app.render()

    def _refresh_thinking_row(self, *, done: bool | None = None) -> None:
        if not self._thinking_body:
            return
        is_done = True if done is None else done
        if self._is_loading and done is None:
            is_done = False
        line = render_thinking_line(
            body=self._thinking_body,
            done=is_done,
            expanded=self._thinking_expanded,
        )
        if self._thinking_idx < 0:
            # Insert thinking above the streaming assistant row when possible
            self._transcript.append_message(line)
            self._thinking_idx = self._transcript.message_count() - 1
            if self._stream_idx >= 0 and self._stream_idx >= self._thinking_idx:
                self._stream_idx += 1
        else:
            self._transcript.update_message_at(self._thinking_idx, line)

    def _on_done(self, text: str) -> None:
        with self._app.lock:
            visible = (text or "").strip() or "（无输出）"
            rendered = assistant_block(visible)
            if self._stream_idx >= 0:
                self._transcript.update_message_at(self._stream_idx, rendered)
            else:
                self._transcript.append_message(rendered)
            if self._thinking_body:
                self._refresh_thinking_row(done=True)
            self._stream_idx = -1
            self._stream_buf = ""
            self._leave_busy()
            self._app.render()

    def _on_error(self, exc: BaseException) -> None:
        with self._app.lock:
            self._transcript.append_message(f" \x1b[31m✖ {_format_llm_error(exc)}\x1b[0m")
            self._stream_idx = -1
            self._leave_busy()
            self._app.render()

    def _on_interrupt(self, interrupts: Any) -> None:
        with self._app.lock:
            first = (
                interrupts[0]
                if isinstance(interrupts, (list, tuple)) and interrupts
                else interrupts
            )
            value = getattr(first, "value", first)
            action_requests = []
            if isinstance(value, dict):
                action_requests = value.get("action_requests") or []
            if not action_requests and isinstance(value, dict):
                action_requests = [value]
            req = (
                action_requests[0]
                if action_requests
                else {"name": "tool", "args": {}, "description": str(value)}
            )
            name = str(req.get("name") or req.get("tool") or "tool")
            args = req.get("args") or {}
            desc = str(req.get("description") or "")
            body = desc or "\n".join(
                f"{k}={v!r}" for k, v in list(args.items())[:8]
            )
            self._begin_exec_approval(
                {
                    "tool": name,
                    "title": name,
                    "body": body,
                    "allow_always": True,
                }
            )

    def _begin_exec_approval(self, payload: dict) -> None:
        self._ask_saved_prompt = self._prompt.value
        self._prompt.clear()
        self._exec_approval = ExecApprovalSession(
            payload,
            render=self._render_exec_approval,
            on_finish=self._finish_exec_approval,
        )
        self._render_exec_approval()

    def _render_exec_approval(self) -> None:
        if self._exec_approval is None:
            self._ask_panel.clear()
            self._app.render()
            return
        self._ask_panel.update(self._exec_approval.render_lines())
        self._app.render()

    def _finish_exec_approval(self, decision: dict) -> None:
        self._exec_approval = None
        self._ask_panel.clear()
        if self._ask_saved_prompt:
            self._prompt.set_value(self._ask_saved_prompt)
        self._ask_saved_prompt = ""
        self._enter_busy()
        self._stream_idx = -1
        self._stream_buf = ""
        self._app.render()
        self._bridge.resume(decision)


def run_circle_session(
    workspace: str | Path = ".",
    *,
    home: Path | None = None,
    force_init: bool = False,
    model_override=None,
) -> int:
    """Entry used by CLI: init/trust gates then CircleSessionApp."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Circle TUI 需要交互式终端。", file=sys.stderr)
        return 2

    home = home or circle_home()
    workspace = normalize_workspace(workspace)
    settings = load_settings(home)

    # Reuse existing init/trust controllers (line-driven) inside ink for now
    if force_init or not settings.is_ready():
        from circle.tui.app import CircleApp

        # Keep init/trust on the existing CircleApp path, then hand off
        app = CircleApp(
            workspace, home=home, force_init=force_init, model_override=model_override
        )
        # Only run until main would start — simpler: run init/trust then session
        return _run_gates_then_session(
            workspace, home=home, force_init=force_init, model_override=model_override
        )

    if not is_folder_trusted(settings, workspace):
        return _run_gates_then_session(
            workspace, home=home, force_init=False, model_override=model_override
        )

    return CircleSessionApp(
        settings, workspace, home=home, model_override=model_override
    ).run()


def _run_gates_then_session(
    workspace: Path,
    *,
    home: Path,
    force_init: bool,
    model_override,
) -> int:
    """Init/trust via existing ink CircleApp controllers, then session shell."""
    # Use the gate portion of CircleApp by composing controllers directly in ink
    from circle.tui.app import CircleApp

    class _GateThenSession(CircleApp):
        def run(self) -> int:  # type: ignore[override]
            init_palette_from_terminal()
            settings = load_settings(self.home)
            if self.force_init or not settings.is_ready():
                self.init = InitController(home=self.home)
                self._stage = "init"
            elif not is_folder_trusted(settings, self.workspace):
                self.trust = TrustController(settings, self.workspace, home=self.home)
                self._stage = "trust"
            else:
                self._ink.stop() if self._ink._running else None  # noqa: SLF001
                return CircleSessionApp(
                    settings,
                    self.workspace,
                    home=self.home,
                    model_override=self.model_override,
                ).run()

            self._rebuild()
            self._ink.start()
            try:
                while self._ink._running:  # noqa: SLF001
                    if self._stage == "done":
                        return 1
                    time.sleep(0.05)
                    if self.init and self.init.done:
                        settings = self.init.settings
                        assert settings is not None
                        if not is_folder_trusted(settings, self.workspace):
                            self.trust = TrustController(
                                settings, self.workspace, home=self.home
                            )
                            self.init = None
                            self._stage = "trust"
                            self._rebuild()
                        else:
                            self._ink.stop()
                            return CircleSessionApp(
                                settings,
                                self.workspace,
                                home=self.home,
                                model_override=self.model_override,
                            ).run()
                    if self.trust and self.trust.finished:
                        if not self.trust.accepted:
                            return 1
                        assert self.trust.result is not None
                        self._ink.stop()
                        return CircleSessionApp(
                            self.trust.result,
                            self.workspace,
                            home=self.home,
                            model_override=self.model_override,
                        ).run()
            finally:
                if self._ink._running:  # noqa: SLF001
                    self._ink.stop()
            return 0

    return _GateThenSession(
        workspace, home=home, force_init=force_init, model_override=model_override
    ).run()
