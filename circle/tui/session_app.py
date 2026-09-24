"""Circle session shell — IstInkApp session ring without compile/KMS.

Layout: transcript · ask panel · closed composer frame · footer.
The frame is one rounded loop. While busy, one rainbow runs around that
loop and through the status text on the top edge.
Streaming + exec approval via HarnessBridge.
"""

from __future__ import annotations

import re
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from circle.checkpoint_store import (
    copy_thread_if_possible,
    make_checkpointer,
    make_store,
)
from circle.commands import (
    CustomCommand,
    discover_custom_commands,
    expand_command_template,
)
from circle.context_middleware import (
    compact_prompt,
    inject_thread_message,
    plan_boundary_message,
    skill_boundary_message,
    thread_config,
)
from circle.extensions import CommandContext, ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.mcp_loader import format_mcp_status
from circle.session_tree import SessionTree
from circle.ink.app import InkApp
from circle.ink.components.ask_user_panel import AskUserPanel
from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.exec_approval_view import ExecApprovalSession
from circle.ink.components.footer import FooterPane
from circle.ink.components.prompt_input import PromptInput
from circle.ink.components.transcript import Transcript
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.parse_keypress import InputEvent, KeyPress, MouseEvent, PasteEvent
from circle.ink.theme import GLYPH_AGENT, init_palette_from_terminal, palette
from circle.model import build_chat_model, reasoning_effort_of
from circle.pricing import context_window_for
from circle.tui.harness_bridge import format_tool_args
from circle.paths import circle_home, ensure_home, normalize_workspace
from circle import secret_prompt
from circle.settings import (
    CircleSettings,
    ModelAuth,
    apply_auth_to_environ,
    clear_credentials,
    is_folder_trusted,
    load_credentials,
    load_settings,
    save_credentials,
    save_settings,
)
from circle.tui.agent_strip import render_agent_strip
from circle.tui.content_blocks import assistant_block, render_thinking_line
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.harness_bridge import HarnessBridge, StreamUpdate
from circle.tui.input_history import InputHistory
from circle.tui.slash_commands import (
    BUILTIN_SLASH,
    help_text,
    hotkeys_text,
    known_slash_names,
    parse_slash,
)

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


@dataclass
class _SessionRecord:
    thread_id: str
    title: str
    lines: list[str] = field(default_factory=list)


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

        self._app = InkApp(alt_screen=True, mouse=True)
        self._transcript = Transcript()
        self._ask_panel = AskUserPanel()
        self._dialog_label = ""
        self._dialog_phase_origin = 0.0

        self._prompt = PromptInput(
            cursor_manager=self._app.cursor,
            on_submit=self._on_submit,
            placeholder="",
        )
        self._prompt.node.style.flex_grow = 1
        self._dialog = create_element(NodeType.BOX)
        self._dialog.style.height = 3
        self._dialog.style.overflow = "hidden"
        self._dialog_top_text = create_text("")
        self._dialog_left_text = create_text("│")
        self._dialog_right_text = create_text("│")
        self._dialog_bottom_text = create_text("")
        dialog_top = create_element(NodeType.BOX)
        dialog_top.style.height = 1
        dialog_top.append_child(self._dialog_top_text)
        dialog_mid = create_element(NodeType.BOX)
        dialog_mid.style.height = 1
        dialog_mid.style.flex_direction = "row"
        dialog_left = create_element(NodeType.BOX)
        dialog_left.style.width = 1
        dialog_left.style.height = 1
        dialog_left.append_child(self._dialog_left_text)
        dialog_right = create_element(NodeType.BOX)
        dialog_right.style.width = 1
        dialog_right.style.height = 1
        dialog_right.append_child(self._dialog_right_text)
        dialog_bottom = create_element(NodeType.BOX)
        dialog_bottom.style.height = 1
        dialog_bottom.append_child(self._dialog_bottom_text)
        dialog_mid.append_child(dialog_left)
        dialog_mid.append_child(self._prompt.node)
        dialog_mid.append_child(dialog_right)
        self._dialog.append_child(dialog_top)
        self._dialog.append_child(dialog_mid)
        self._dialog.append_child(dialog_bottom)

        self._footer = FooterPane(
            render_callback=self._app.render,
            thinking_text_cb=self._update_thinking_line,
        )
        self._footer.update(model=settings.auth.model, status="ready")
        hist_path = (self.home / "history")
        self._input_history = InputHistory(path=hist_path)
        self._app.before_render = self._sync_dialog_frame

        self._agent_rows: list[dict] = []
        self._seen_call_ids: set[str] = set()
        self._tool_line_at: dict[str, int] = {}
        self._tool_names: dict[str, str] = {}
        self._tool_filled: dict[str, bool] = {}
        self._agent_strip = create_element(NodeType.BOX)
        self._agent_strip.style.height = 0
        self._agent_strip_text = create_text("")
        self._agent_strip.append_child(self._agent_strip_text)

        root = self._app.root
        root.append_child(self._transcript.node)
        root.append_child(self._ask_panel.node)
        root.append_child(self._dialog)
        root.append_child(self._footer.node)
        root.append_child(self._agent_strip)

        self._app.on_input = self._handle_input

        self._is_loading = False
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        self._thinking_expanded = False
        self._show_thinking = True
        self._tool_outputs_expanded = False
        self._show_details = False  # alias of tool_outputs_expanded (InfoTest verbose)
        self._main_thinking_lines: list[dict[str, Any]] = []
        self._call_started_at = 0.0
        self._exec_approval: ExecApprovalSession | None = None
        self._ask_saved_prompt = ""
        self._last_ctrl_c = 0.0
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        ensure_home(self.home)
        self._checkpointer = make_checkpointer(self.home)
        self._store = make_store()
        self._archive: list[_SessionRecord] = []
        self._previous_thread_id: str | None = None
        self._session_title = "new"
        self._undo_stack: list[_SessionRecord] = []
        self._redo_stack: list[_SessionRecord] = []
        self._share_path: Path | None = None
        self._last_assistant_plain = ""
        self._plan_mode = False
        self._session_tree = SessionTree()
        self._msg_queue: list[tuple[str, str]] = []  # (steering|followup, text)
        self._custom_commands: dict[str, CustomCommand] = {
            c.name: c
            for c in discover_custom_commands(self.workspace, self.home)
        }
        self._mcp_tools: list[Any] = []
        self._extensions = self._load_extensions()
        # 机密输入模式（question 工具 secret 类型）：buffer 只存在内存，
        # 输入行只渲染掩码；值经 secret_prompt 直写目标文件，不进对话。
        self._secret_entry: dict[str, Any] | None = None
        self._secret_hint_shown = False
        self._secret_last_check = 0.0

        model = build_chat_model(
            settings, home=self.home, model_override=model_override
        )
        self._chat_model = model
        self._sync_model_meter()
        self._agent = create_harness(
            model,
            root_dir=self.workspace,
            home=self.home,
            checkpointer=self._checkpointer,
            store=self._store,
            model_id=settings.auth.model,
            protocol=settings.auth.protocol,
            plan_mode=self._plan_mode,
            mcp_servers=settings.mcp_servers,
            extensions=self._extensions,
        )
        self._mcp_tools = list(getattr(self._agent, "_circle_mcp_tools", []) or [])
        self._bridge = self._make_bridge()

    def _rebuild_agent(self, *, model: Any | None = None) -> None:
        """Rebuild harness with current settings / plan mode."""
        chat = model or build_chat_model(
            self.settings, home=self.home, model_override=self.model_override
        )
        self._custom_commands = {
            c.name: c
            for c in discover_custom_commands(self.workspace, self.home)
        }
        self._chat_model = chat
        self._agent = create_harness(
            chat,
            root_dir=self.workspace,
            home=self.home,
            checkpointer=self._checkpointer,
            store=self._store,
            model_id=self.settings.auth.model,
            protocol=self.settings.auth.protocol,
            plan_mode=self._plan_mode,
            mcp_servers=self.settings.mcp_servers,
            extensions=self._extensions,
        )
        self._sync_model_meter()
        self._mcp_tools = list(getattr(self._agent, "_circle_mcp_tools", []) or [])
        self._bridge = self._make_bridge()
        backend = getattr(self._agent, "_circle_backend", None)
        if backend is not None and hasattr(backend, "set_plan_mode"):
            backend.set_plan_mode(self._plan_mode)

    def _load_extensions(self) -> ExtensionHost:
        """用户级扩展总是考虑；项目级只在当前工作区受信任时加载。"""
        reserved_commands = known_slash_names() | set(self._custom_commands)
        return ExtensionHost(
            home=self.home,
            workspace=self.workspace,
            trusted=is_folder_trusted(self.settings, self.workspace),
            settings=self.settings.extensions,
            reserved_tools=set(BUILTIN_TOOL_NAMES),
            reserved_commands=reserved_commands,
        ).load()

    def _command_context(self) -> CommandContext:
        return CommandContext(
            workspace=self.workspace,
            toast=self._toast,
            append=lambda text: (self._transcript.append_message(text), self._app.render()),
            send_user_message=self._start_user_turn,
        )

    def _make_bridge(self) -> HarnessBridge:
        return HarnessBridge(
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
                self._maybe_update_secret_hint()
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
        self._extensions.emit("session_start", {"workspace": str(self.workspace)})

    def _update_thinking_line(self, text: str | None) -> None:
        """Store the status that the closed frame embeds in its top edge."""
        label = text or ""
        if label and not self._dialog_label:
            self._dialog_phase_origin = time.monotonic()
        if not label:
            self._dialog_phase_origin = 0.0
        self._dialog_label = label

    def _sync_dialog_frame(self) -> None:
        width = self._app.width
        if width < 8:
            return
        elapsed = None
        if self._dialog_label:
            elapsed = time.monotonic() - self._dialog_phase_origin
        top, left, right, bottom = build_loop_frame(
            width,
            elapsed=elapsed,
            label=self._dialog_label,
        )
        self._dialog_top_text.set_value(top)
        self._dialog_left_text.set_value(left)
        self._dialog_right_text.set_value(right)
        self._dialog_bottom_text.set_value(bottom)
        self._sync_agent_strip()

    def _note_task(self, call: dict) -> None:
        if str(call.get("name") or "") != "task":
            return
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        action = " ".join(str(
            args.get("description")
            or args.get("prompt")
            or args.get("task")
            or "运行中"
        ).split())
        name = str(args.get("subagent_type") or "task")
        call_id = str(call.get("id") or "")
        for row in self._agent_rows:
            same = (call_id and row.get("id") == call_id) or (
                not call_id and not row.get("id") and row.get("name") == name
            )
            if same:
                if action != "运行中":
                    row["action"] = action
                    row["name"] = name
                return
        self._agent_rows.append({
            "id": call_id,
            "name": name,
            "action": action,
            "started": time.time(),
        })

    def _drop_task(self, call_id: str) -> None:
        if call_id:
            kept = [row for row in self._agent_rows if row.get("id") != call_id]
            if len(kept) != len(self._agent_rows):
                self._agent_rows[:] = kept
                return
        if self._agent_rows:
            self._agent_rows.pop(0)

    def _sync_agent_strip(self) -> None:
        strip = getattr(self, "_agent_strip", None)
        text = getattr(self, "_agent_strip_text", None)
        if strip is None or text is None:
            return
        rows = getattr(self, "_agent_rows", [])
        if not rows:
            strip.style.height = 0
            text.set_value("")
            return
        width = max(40, self._app.width or 80)
        lines = render_agent_strip(rows, width=width)
        strip.style.height = len(lines)
        text.set_value("\n".join(lines))

    # ── input ──────────────────────────────────────────────────────────

    def _handle_input(self, event: InputEvent) -> None:
        if isinstance(event, PasteEvent):
            if self._input_history.in_search_mode:
                return
            self._prompt.handle_paste(event.text)
            self._app.render()
            return
        if isinstance(event, MouseEvent):
            self._handle_mouse(event)
            return
        if not isinstance(event, KeyPress):
            return
        self._handle_key(event)

    def _handle_key(self, kp: KeyPress) -> None:
        # InfoTest ist_app._handle_key — same session-ring order.
        if self._exec_approval is not None:
            if self._exec_approval.handle_key(kp.key, kp.char):
                return

        if self._input_history.in_search_mode:
            if self._handle_search_key(kp):
                return

        if self._secret_entry is not None:
            self._handle_secret_key(kp)
            return

        if kp.key == "ctrl+s":
            self._start_secret_entry()
            return

        from circle.ink.selection import clear_selection, has_selection

        if has_selection(self._app.selection):
            if kp.key == "ctrl+c":
                self._copy_selection(clear_after=False)
                return
            if kp.key == "escape":
                clear_selection(self._app.selection)
                self._app.notify_selection_change()
                self._app.render()
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

        if kp.key == "ctrl+d":
            self._app._running = False  # noqa: SLF001
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

        if kp.key == "ctrl+o":
            self._toggle_tool_outputs()
            return

        if kp.key == "ctrl+t":
            self._toggle_thinking()
            return

        if kp.key == "ctrl+l":
            self._app._force_full_render()  # noqa: SLF001
            return

        if kp.key == "pageup":
            self._scroll_transcript(-self._half_viewport())
            return
        if kp.key == "pagedown":
            self._scroll_transcript(self._half_viewport())
            return

        if kp.key == "ctrl+r":
            self._enter_or_advance_search()
            return

        if kp.key == "up":
            self._history_up()
            self._app.render()
            return
        if kp.key == "down":
            self._history_down()
            self._app.render()
            return

        if kp.key == "tab":
            self._tab_complete()
            return

        # Pi-style: Alt+Enter queues a follow-up while busy (or sends now).
        if kp.key in {"alt+enter", "alt+return"} or (getattr(kp, "alt", False) and kp.key in {"enter", "return"}):
            text = self._prompt.value
            if text.strip():
                self._prompt.clear()
                self._on_submit(text, kind="followup")
                self._app.render()
            return

        if self._prompt.handle_key(
            kp.key if kp.key else "char",
            kp.char if len(kp.char) == 1 else "",
        ):
            self._app.render()

    # ── secret entry（question 工具 secret 类型的 TUI 侧）──────────────

    def _maybe_update_secret_hint(self) -> None:
        """发现待答机密请求时提示 Ctrl+S；只在非忙碌时动 footer，避免覆盖状态。"""
        now = time.monotonic()
        if now - self._secret_last_check < 0.5:
            return
        self._secret_last_check = now
        if self._secret_entry is not None or self._is_loading:
            return
        pending = secret_prompt.list_pending(self.home)
        if pending:
            if not self._secret_hint_shown:
                self._secret_hint_shown = True
                self._footer.update(
                    status=f"ctrl+s 补录机密（{len(pending)} 项待输入）"
                )
                self._app.render()
        elif self._secret_hint_shown:
            self._secret_hint_shown = False
            self._footer.update(status="ready")
            self._app.render()

    def _start_secret_entry(self) -> None:
        if self._secret_entry is not None:
            return
        pending = secret_prompt.list_pending(self.home)
        if not pending:
            self._footer.update(status="没有待输入的机密")
            self._app.render()
            return
        request = pending[0]
        self._secret_entry = {"request": request, "buffer": ""}
        self._prompt.clear()
        self._secret_hint_shown = False
        question = str(request.get("question") or "请输入机密")
        self._footer.hold_status(f"请输入{question}（回车确认 / Esc 取消）")
        self._app.render()

    def _sync_secret_display(self) -> None:
        """密码显示掩码；用户名按请求里的 mask=false 原文显示。值不进对话。"""
        entry = self._secret_entry or {}
        buffer = entry.get("buffer") or ""
        request = entry.get("request") or {}
        shown = "*" * len(buffer) if request.get("mask", True) else buffer
        self._prompt.set_value(shown)

    def _handle_secret_key(self, kp: KeyPress) -> None:
        entry = self._secret_entry
        if entry is None:
            return
        request = entry["request"]
        if kp.key in {"enter", "return"}:
            if not entry["buffer"]:
                self._footer.update(status="机密不能为空（Esc 取消）")
                self._app.render()
                return
            try:
                secret_prompt.submit_answer(self.home, request["id"], entry["buffer"])
            except secret_prompt.SecretPromptError as exc:
                self._footer.update(status=f"提交失败：{exc}")
            else:
                self._footer.update(status="已收集（未显示）")
            self._secret_entry = None
            entry["buffer"] = ""
            self._prompt.clear()
            if secret_prompt.list_pending(self.home):
                self._start_secret_entry()
            else:
                self._footer.clear_hold_status()
                self._footer.update(status="设备口令已收集")
                self._app.render()
            return
        if kp.key == "escape":
            self._secret_entry = None
            entry["buffer"] = ""
            self._prompt.clear()
            self._footer.clear_hold_status()
            self._footer.update(status="已取消")
            self._app.render()
            return
        if kp.key == "backspace":
            entry["buffer"] = entry["buffer"][:-1]
            self._sync_secret_display()
            self._app.render()
            return
        if len(kp.char) == 1 and kp.char.isprintable():
            if len(entry["buffer"]) >= 512:
                return
            entry["buffer"] += kp.char
            self._sync_secret_display()
            self._app.render()

    def _handle_mouse(self, me: MouseEvent) -> None:
        # InfoTest IstInkApp._handle_mouse — text selection, copy, wheel.
        # Circle has no agent strip / fork-row targets, so those clicks fall
        # through to ordinary text selection.
        col, row = self._mouse_to_screen_coords(me.x, me.y)

        if me.type == "wheel":
            if me.button == 0:
                self._scroll_transcript(-3)
            elif me.button == 1:
                self._scroll_transcript(3)
            return

        if me.button != 0:
            return

        if me.type == "press":
            self._handle_left_press(col, row, alt=me.alt)
            return

        if me.type == "move":
            sel = self._app.selection
            if not sel.is_dragging:
                return
            if sel.anchor_span is not None:
                from circle.ink.selection import extend_selection

                extend_selection(sel, self._app._curr_screen, col, row)
            else:
                from circle.ink.selection import update_selection

                update_selection(sel, col, row)
            self._app.notify_selection_change()
            self._app.render()
            return

        if me.type == "release":
            from circle.ink.selection import finish_selection, has_selection

            sel = self._app.selection
            was_dragging = sel.is_dragging
            finish_selection(sel)
            if was_dragging and has_selection(sel):
                self._copy_selection(clear_after=False)
            self._app.notify_selection_change()
            self._app.render()

    def _handle_left_press(self, col: int, row: int, *, alt: bool) -> None:
        now = time.monotonic()
        last = getattr(self, "_last_click_meta", None)
        click_count = 1
        if (
            last is not None
            and now - last[0] < 0.3
            and last[1] == col
            and last[2] == row
        ):
            click_count = last[3] + 1
        if click_count > 3:
            click_count = 3

        from circle.ink.selection import select_line_at, select_word_at, start_selection

        sel = self._app.selection
        sel.scrolled_off_above = []
        sel.scrolled_off_below = []
        sel.scrolled_off_above_sw = []
        sel.scrolled_off_below_sw = []

        screen = self._app._curr_screen
        if click_count == 1:
            start_selection(sel, col, row, alt=alt)
        elif click_count == 2:
            select_word_at(sel, screen, col, row)
        else:
            select_line_at(sel, screen, row)

        self._last_click_meta = (now, col, row, click_count)
        self._app.notify_selection_change()
        self._app.render()

    def _mouse_to_screen_coords(self, x: int, y: int) -> tuple[int, int]:
        screen = self._app._curr_screen
        clamped_x = max(0, min(x, max(0, screen.width - 1)))
        clamped_y = max(0, min(y, max(0, screen.height - 1)))
        return clamped_x, clamped_y

    def _copy_selection(self, *, clear_after: bool) -> None:
        from circle.ink.selection import clear_selection, get_selected_text, has_selection
        from circle.ink.termio.osc import set_clipboard

        sel = self._app.selection
        if not has_selection(sel):
            return
        text = get_selected_text(sel, self._app.visible_screen())
        if not text:
            return
        seq = set_clipboard(text)
        if seq:
            self._app._terminal.write(seq)
        self._footer.set_toast(f"Copied {len(text)} chars", ttl_seconds=1.2)
        if clear_after:
            clear_selection(sel)
            self._app.notify_selection_change()
        self._app.render()

    def _half_viewport(self) -> int:
        return max(1, self._transcript.viewport_height() // 2)

    def _scroll_transcript(self, delta: int) -> None:
        if delta == 0:
            return
        old_top = self._transcript.node.scroll_top
        self._transcript.scroll_by(delta)
        actual = self._transcript.node.scroll_top - old_top
        if actual != 0:
            self._shift_selection_for_scroll(actual)
        self._app._repaint_full()  # noqa: SLF001

    def _shift_selection_for_scroll(self, scroll_delta: int) -> None:
        from circle.ink.selection import (
            capture_scrolled_rows,
            has_selection,
            selection_bounds,
            shift_selection,
        )

        sel = self._app.selection
        if not has_selection(sel):
            return
        rect = self._transcript.node.rect
        if rect.height <= 0:
            return
        min_row = rect.y
        max_row = rect.y + rect.height - 1
        bounds = selection_bounds(sel)
        if bounds is None or bounds[0].row > max_row or bounds[1].row < min_row:
            return

        screen = self._app.visible_screen()
        if scroll_delta > 0:
            capture_scrolled_rows(
                sel, screen, min_row, min(max_row, min_row + scroll_delta - 1),
                side="above",
            )
        else:
            span = -scroll_delta
            capture_scrolled_rows(
                sel, screen, max(min_row, max_row - span + 1), max_row,
                side="below",
            )
        shift_selection(
            sel,
            d_row=-scroll_delta,
            min_row=min_row,
            max_row=max_row,
            width=screen.width,
        )
        self._app.notify_selection_change()

    def _history_up(self) -> None:
        result = self._input_history.up(self._prompt.value)
        if result is not None:
            self._prompt.set_value(result)

    def _history_down(self) -> None:
        result = self._input_history.down(self._prompt.value)
        if result is not None:
            self._prompt.set_value(result)
        else:
            self._prompt.clear()

    def _tab_complete(self) -> None:
        val = self._prompt.value
        if not val.startswith("/"):
            return
        prefix = val[1:].lower()
        matches = [
            cmd for cmd in BUILTIN_SLASH if cmd.name.lower().startswith(prefix)
        ]
        if not matches:
            return
        if len(matches) == 1:
            self._prompt.set_value(f"/{matches[0].name} ")
        else:
            names = "  ".join(f"/{m.name}" for m in matches[:8])
            self._footer.set_toast(f"{names}  [Tab · Enter]", ttl_seconds=2.0)
            self._prompt.set_value(f"/{matches[0].name} ")
        self._app.render()

    def _enter_or_advance_search(self) -> None:
        if self._input_history.in_search_mode:
            result = self._input_history.search_next()
            self._update_search_ui(result)
        else:
            result = self._input_history.start_search(self._prompt.value)
            self._update_search_ui(result)

    def _update_search_ui(self, match: str | None) -> None:
        query = self._input_history.search_query
        if match is not None:
            self._prompt.set_value(match)
        self._footer.set_search_state(query=query, match=match if match else "")
        self._app.render()

    def _handle_search_key(self, kp: KeyPress) -> bool:
        key = kp.key
        if key == "ctrl+r":
            return False
        if key == "escape":
            draft = self._input_history.exit_search(restore=True)
            self._prompt.set_value(draft)
            self._footer.set_search_state(query=None, match=None)
            self._app.render()
            return True
        if key == "enter":
            self._input_history.exit_search(restore=False)
            self._footer.set_search_state(query=None, match=None)
            text = self._prompt.value
            if text:
                self._prompt.clear()
                self._on_submit(text)
            else:
                self._app.render()
            return True
        if key == "backspace":
            new_q = self._input_history.search_query[:-1]
            result = self._input_history.update_search_query(new_q)
            self._update_search_ui(result)
            return True
        if key == "ctrl+c":
            draft = self._input_history.exit_search(restore=True)
            self._prompt.set_value(draft)
            self._footer.set_search_state(query=None, match=None)
            self._app.render()
            return True
        if kp.char and len(kp.char) == 1 and kp.char.isprintable():
            new_q = self._input_history.search_query + kp.char
            result = self._input_history.update_search_query(new_q)
            self._update_search_ui(result)
            return True
        self._input_history.exit_search(restore=False)
        self._footer.set_search_state(query=None, match=None)
        return False

    def _toggle_thinking(self) -> None:
        """InfoTest ``_toggle_thinking`` — expand/collapse all thinking rows."""
        self._thinking_expanded = not self._thinking_expanded
        self._show_thinking = True
        done = not self._is_loading
        for rec in self._main_thinking_lines:
            body = str(rec.get("body") or "")
            idx = int(rec.get("idx", -1))
            if idx < 0:
                continue
            self._transcript.update_message_at(
                idx,
                render_thinking_line(
                    body=body,
                    done=True if idx != self._thinking_idx else done,
                    expanded=self._thinking_expanded,
                ),
            )
        if self._thinking_body and self._thinking_idx >= 0:
            self._refresh_thinking_row(done=None if self._is_loading else True)
        self._app.render()

    def _toggle_tool_outputs(self) -> None:
        """InfoTest ``_toggle_expand`` / ctrl+o — tool-output verbosity."""
        self._tool_outputs_expanded = not self._tool_outputs_expanded
        self._show_details = self._tool_outputs_expanded
        state = "展开" if self._tool_outputs_expanded else "折叠"
        self._toast(f"工具输出 → {state}（ctrl+o）")
        self._footer.update(status="ready" if not self._is_loading else "running")
        self._app.render()

    def _on_submit(self, text: str, *, kind: str = "steering") -> None:
        text = text.strip()
        if not text:
            return
        self._input_history.add(text)
        self._input_history.reset_navigation()
        extra = set(self._custom_commands) | set(self._extensions.commands())
        parsed = parse_slash(text, extra_commands=extra)
        if parsed is not None:
            self._dispatch_slash(parsed.name, parsed.args)
            return
        if self._bridge.is_running or self._is_loading:
            self._msg_queue.append((kind, text))
            label = "follow-up" if kind == "followup" else "steering"
            self._toast(f"已排队 {label}（{len(self._msg_queue)}）")
            return
        self._start_user_turn(text)

    def _start_user_turn(self, text: str) -> None:
        self._push_undo_checkpoint()
        self._session_tree.add("user", text)

        if self._session_title == "new":
            self._session_title = text.split("\n", 1)[0][:60]

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
        self._extensions.emit("turn_start", {"text": text})
        self._bridge.start(text)

    def _drain_message_queue(self) -> None:
        if self._bridge.is_running or self._is_loading or not self._msg_queue:
            return
        steering = [(k, t) for k, t in self._msg_queue if k != "followup"]
        followups = [(k, t) for k, t in self._msg_queue if k == "followup"]
        if steering:
            _, text = steering[0]
            self._msg_queue = steering[1:] + followups
            self._start_user_turn(text)
            return
        if followups:
            _, text = followups[0]
            self._msg_queue = followups[1:]
            self._start_user_turn(text)

    def _toast(self, msg: str) -> None:
        self._transcript.append_message(f" \x1b[2m{msg}\x1b[0m")
        self._app.render()

    def _cmd_yolo(self, args: str) -> None:
        """/yolo — 切换自动批准所有工具调用。"""
        enabled = args.strip().lower() not in ("off", "0", "false", "no")
        self._footer.set_yolo(enabled)
        self._bridge.auto_approve = enabled
        self._toast("yolo → 开（自动批准所有工具调用）" if enabled
                    else "yolo → 关（恢复逐项审批）")
        self._app.render()

    def _dispatch_slash(self, name: str, args: str) -> None:
        if name == "exit":
            self._app._running = False  # noqa: SLF001
            return
        if name == "help":
            custom = [(c.name, c.description) for c in self._custom_commands.values()]
            custom += [(c.name, c.description) for c in self._extensions.commands().values()]
            for line in help_text(custom=custom or None).splitlines():
                self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
            self._app.render()
            return
        if name == "hotkeys":
            for line in hotkeys_text().splitlines():
                self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
            self._app.render()
            return
        if name in self._custom_commands:
            cmd = self._custom_commands[name]
            expanded = expand_command_template(cmd.template, args, cwd=self.workspace)
            self._start_user_turn(expanded)
            return
        _busy_ok = {
            "yolo",
            "settings",
            "session",
            "themes",
            "mcp",
            "copy",
            "export",
            "share",
            "unshare",
            "thinking",
            "details",
            "name",
            "tree",
        }
        if name not in _busy_ok and (self._bridge.is_running or self._is_loading):
            self._toast("(busy — 等待当前回合完成)")
            return
        ext_command = self._extensions.commands().get(name)
        if ext_command is not None:
            try:
                ext_command.handler(args, self._command_context())
            except Exception as exc:  # noqa: BLE001 — 扩展命令出错只提示，不影响会话
                self._toast(f"/{name} 失败: {type(exc).__name__}: {exc}")
            return
        handlers = {
            "login": self._cmd_login,
            "logout": self._cmd_logout,
            "init": self._cmd_init,
            "trust": self._cmd_trust,
            "settings": self._cmd_settings,
            "themes": self._cmd_themes,
            "mcp": self._cmd_mcp,
            "new": self._cmd_new,
            "resume": self._cmd_resume,
            "continue": self._cmd_continue,
            "name": self._cmd_name,
            "session": self._cmd_session,
            "models": self._cmd_models,
            "compact": self._cmd_compact,
            "plan": self._cmd_plan,
            "skill": self._cmd_skill,
            "tree": self._cmd_tree,
            "fork": self._cmd_fork,
            "clone": self._cmd_clone,
            "undo": self._cmd_undo,
            "redo": self._cmd_redo,
            "thinking": self._cmd_thinking,
            "details": self._cmd_details,
            "copy": self._cmd_copy,
            "export": self._cmd_export,
            "import": self._cmd_import,
            "share": self._cmd_share,
            "unshare": self._cmd_unshare,
            "editor": self._cmd_editor,
            "reload": self._cmd_reload,
            "yolo": self._cmd_yolo,
            "extensions": self._cmd_extensions,
        }
        handler = handlers.get(name)
        if handler is None:
            self._toast(f"未知命令 /{name} — 试 /help")
            return
        handler(args)

    def _archive_current(self) -> None:
        if self._transcript.message_count() <= 3 and self._session_title == "new":
            return
        rec = _SessionRecord(
            thread_id=self._thread_id,
            title=self._session_title or self._thread_id,
            lines=self._transcript.snapshot(),
        )
        for i, existing in enumerate(self._archive):
            if existing.thread_id == rec.thread_id:
                self._archive[i] = rec
                break
        else:
            self._archive.append(rec)
        self._previous_thread_id = self._thread_id

    def _switch_thread(self, thread_id: str, *, lines: list[str] | None = None) -> None:
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = thread_id
        self._bridge = self._make_bridge()
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        if lines is not None:
            self._transcript.restore(lines)
            for rec in self._archive:
                if rec.thread_id == thread_id:
                    self._session_title = rec.title
                    break
        else:
            self._transcript.clear()
            self._session_title = "new"
            self._show_welcome()

    def _cmd_login(self, args: str) -> None:
        """OAuth provider login (/login, /connect)."""
        from circle.oauth import (
            OAuthNotConfiguredError,
            SUPPORTED_OAUTH_PROVIDERS,
            start_oauth_login,
        )

        provider = args.strip().lower()
        if not provider:
            cur = self.settings.auth.oauth_provider or self.settings.auth.mode
            self._toast(
                f"用法: /login anthropic|openai  ·  当前: {cur or '未登录'}"
            )
            self._toast("API URL+KEY 请运行 circle --init（避免密钥进 transcript）")
            return
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            self._toast(
                f"未知提供方 {provider!r}；可选: {', '.join(SUPPORTED_OAUTH_PROVIDERS)}"
            )
            return
        self._toast(f"正在登录 {provider}…")
        try:
            session = start_oauth_login(provider)
        except OAuthNotConfiguredError as exc:
            self._toast(str(exc))
            return
        except ValueError as exc:
            self._toast(str(exc))
            return

        models = list(session.models) or [self.settings.auth.model]
        model = models[0] if models else self.settings.auth.model
        self.settings.auth = ModelAuth(
            mode="oauth",
            protocol="anthropic" if provider == "anthropic" else "openai",
            base_url=session.base_url,
            model=model or self.settings.auth.model,
            oauth_provider=provider,
            api_key_ref="oauth_access_token",
        )
        self.settings.initialized = True
        save_credentials(
            {
                "oauth_access_token": session.access_token,
                "oauth_refresh_token": session.refresh_token,
            },
            self.home,
        )
        save_settings(self.settings, self.home)
        apply_auth_to_environ(self.settings, self.home)
        try:
            chat = build_chat_model(self.settings, home=self.home)
            self._rebuild_agent(model=chat)
            self.model_override = None
        except Exception as exc:  # noqa: BLE001
            self._toast(f"凭证已保存，但重建模型失败: {exc}")
            return
        self._footer.update(model=self.settings.auth.model)
        self._toast(f"已登录 {provider} · 模型 {self.settings.auth.model}")

    def _cmd_logout(self, _args: str) -> None:
        clear_credentials(self.home)
        self.settings.auth = ModelAuth()
        self.settings.initialized = False
        save_settings(self.settings, self.home)
        self._toast("已退出登录（credentials 已清空）。下次对话前请 /login 或 circle --init")

    def _cmd_new(self, _args: str) -> None:
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._bridge = self._make_bridge()
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        self._session_title = "new"
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"新会话 {self._thread_id}")

    def _cmd_resume(self, args: str) -> None:
        self._archive_current()
        sessions = list(self._archive)
        # Always include current at end if not already archived this turn
        if not any(s.thread_id == self._thread_id for s in sessions):
            if self._transcript.message_count() > 3:
                sessions.append(
                    _SessionRecord(
                        self._thread_id,
                        self._session_title,
                        self._transcript.snapshot(),
                    )
                )
        if not sessions:
            self._toast("没有可恢复的会话（先聊几轮或 /new 归档当前）")
            return
        target = args.strip()
        if not target:
            self._toast("会话列表：")
            for i, rec in enumerate(sessions, 1):
                mark = " *" if rec.thread_id == self._thread_id else ""
                self._transcript.append_message(
                    f" \x1b[2m{i}. {rec.thread_id}  {rec.title[:40]}{mark}\x1b[0m"
                )
            self._toast("用法: /resume <n|id>")
            return
        chosen: _SessionRecord | None = None
        if target.isdigit():
            idx = int(target) - 1
            if 0 <= idx < len(sessions):
                chosen = sessions[idx]
        else:
            for rec in sessions:
                if rec.thread_id == target or rec.thread_id.endswith(target):
                    chosen = rec
                    break
        if chosen is None:
            self._toast(f"找不到会话 {target!r}")
            return
        if chosen.thread_id == self._thread_id:
            self._toast("已在该会话")
            return
        self._switch_thread(chosen.thread_id, lines=chosen.lines)
        self._toast(f"已恢复 {chosen.thread_id} · {chosen.title[:40]}")

    def _cmd_continue(self, _args: str) -> None:
        prev = self._previous_thread_id
        if not prev or prev == self._thread_id:
            # fall back to last archive entry that isn't current
            for rec in reversed(self._archive):
                if rec.thread_id != self._thread_id:
                    prev = rec.thread_id
                    break
        if not prev or prev == self._thread_id:
            self._toast("没有上一会话")
            return
        lines = None
        title = prev
        for rec in self._archive:
            if rec.thread_id == prev:
                lines = rec.lines
                title = rec.title
                break
        self._switch_thread(prev, lines=lines or [])
        self._toast(f"已继续 {prev} · {title[:40]}")

    def _cmd_models(self, args: str) -> None:
        name = args.strip()
        if not name:
            models = self._list_models()
            current = self.settings.auth.model
            self._toast(f"当前模型: {current}")
            for m in models[:40]:
                mark = " *" if m == current else ""
                self._transcript.append_message(f" \x1b[2m  {m}{mark}\x1b[0m")
            if len(models) > 40:
                self._toast(f"…共 {len(models)} 个，用法 /models <name>")
            else:
                self._toast("用法: /models <name>")
            self._app.render()
            return
        self._switch_model(name)

    def _list_models(self) -> list[str]:
        from circle.probe import FALLBACK_MODELS, probe_endpoint

        creds = load_credentials(self.home)
        key = (
            creds.get(self.settings.auth.api_key_ref)
            or creds.get("api_key")
            or creds.get("oauth_access_token")
            or ""
        )
        base = self.settings.auth.base_url
        if base and key:
            hit = probe_endpoint(base, key)
            if hit and hit.models:
                return list(hit.models)
        return list(FALLBACK_MODELS)

    def _switch_model(self, name: str) -> None:
        self.settings.auth.model = name
        save_settings(self.settings, self.home)
        apply_auth_to_environ(self.settings, self.home)
        # Explicit /models switch leaves the scripted/test override behind.
        self.model_override = None
        try:
            model = build_chat_model(self.settings, home=self.home)
        except Exception as exc:  # noqa: BLE001
            self._toast(f"切换失败: {exc}")
            return
        self._rebuild_agent(model=model)
        self._footer.update(model=name)
        self._toast(f"模型 → {name}")

    def _cmd_compact(self, args: str) -> None:
        """Run deepagents ``compact_conversation`` in the current thread."""
        hint = args.strip()
        try:
            state = self._agent.get_state(thread_config(self._thread_id))
            msgs = (state.values or {}).get("messages") or []
        except Exception:  # noqa: BLE001
            msgs = []
        if len(msgs) < 2:
            self._toast("对话太短，无需压缩")
            return
        self._toast("正在压缩上下文（deepagents compact_conversation）…")
        self._enter_busy()
        self._app.render()

        def _work() -> None:
            summary = ""
            err: BaseException | None = None
            try:
                result = self._agent.invoke(
                    {"messages": [{"role": "user", "content": compact_prompt(hint=hint)}]},
                    config=thread_config(self._thread_id),
                )
                out_msgs = result.get("messages") or []
                last = out_msgs[-1] if out_msgs else None
                content = getattr(last, "content", "") if last is not None else ""
                if isinstance(content, list):
                    parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            parts.append(str(block.get("text") or ""))
                        else:
                            parts.append(str(block))
                    summary = "\n".join(parts).strip()
                else:
                    summary = str(content or "").strip()
            except BaseException as exc:  # noqa: BLE001
                err = exc
            with self._app.lock:
                if err is not None:
                    self._leave_busy()
                    self._transcript.append_message(
                        f" \x1b[31m✖ compact 失败: {_format_llm_error(err)}\x1b[0m"
                    )
                    self._app.render()
                    return
                self._transcript.append_message(" \x1b[2m— compacted (same thread) —\x1b[0m")
                for line in (summary or "COMPACT_OK").splitlines():
                    self._transcript.append_message(f" {line}")
                self._transcript.append_message("")
                self._leave_busy()
                self._app.render()

        threading.Thread(target=_work, name="circle-compact", daemon=True).start()

    def _cmd_plan(self, args: str) -> None:
        token = (args or "").strip().lower()
        if token in {"on", "1", "true", "enable"}:
            want = True
        elif token in {"off", "0", "false", "disable"}:
            want = False
        elif not token:
            want = not self._plan_mode
        else:
            self._toast("用法: /plan [on|off]")
            return
        if want == self._plan_mode:
            state = "开" if want else "关"
            self._toast(f"plan mode 已是{state}")
            return
        self._plan_mode = want
        try:
            self._rebuild_agent()
            inject_thread_message(
                self._agent,
                self._thread_id,
                plan_boundary_message(enabled=want),
            )
        except Exception as exc:  # noqa: BLE001
            self._plan_mode = not want
            self._toast(f"切换 plan mode 失败: {exc}")
            return
        if want:
            self._toast("plan mode → 开（硬拦截写改/shell；仅允许 /plan.md）")
        else:
            self._toast("plan mode → 关")

    def _cmd_skill(self, args: str) -> None:
        from circle.skills import discover_skills, format_skills_slash_list, load_skill_body

        skills = discover_skills(self.workspace, self.home)
        token = (args or "").strip()
        if not token:
            for line in format_skills_slash_list(skills).splitlines():
                self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
            self._app.render()
            return
        parts = token.split(None, 1)
        name = parts[0]
        skill_args = parts[1] if len(parts) > 1 else ""
        body = load_skill_body(name, skills=skills)
        if body.startswith("Error:"):
            self._toast(body)
            return
        try:
            inject_thread_message(
                self._agent,
                self._thread_id,
                skill_boundary_message(name=name, body=body, args=skill_args),
            )
        except Exception as exc:  # noqa: BLE001
            self._toast(f"加载 skill 失败: {exc}")
            return
        suffix = f" args={skill_args!r}" if skill_args else ""
        self._toast(f"已加载 skill `{name}`{suffix}（已写入 checkpointer 线程）")

    def _cmd_tree(self, args: str) -> None:
        token = (args or "").strip()
        if not token:
            for line in self._session_tree.render_list().splitlines():
                self._transcript.append_message(f" [2m{line}[0m")
            self._app.render()
            return
        if not self._session_tree.jump(token):
            self._toast(f"未知节点 {token}")
            return
        self._toast(f"已跳到节点 {token}（后续对话从此分支）")

    def _cmd_fork(self, args: str) -> None:
        token = (args or "").strip() or (self._session_tree.active_id or "")
        if not token:
            self._toast("用法: /fork <id>")
            return
        forked = self._session_tree.fork_from(token)
        if forked is None:
            self._toast(f"无法 fork {token}")
            return
        self._archive_current()
        old_thread = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._session_tree = forked
        copy_thread_if_possible(self._checkpointer, old_thread, self._thread_id)
        self._rebuild_agent()
        self._session_title = (self._session_title or "session") + " (fork)"
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"已 fork 自 {token} → {self._thread_id}")
        for node in self._session_tree.path_to():
            if node.role == "user":
                self._transcript.append_message(f" \x1b[2m>\x1b[0m {node.text.splitlines()[0][:80]}")
        self._app.render()

    def _cmd_clone(self, _args: str) -> None:
        cloned = self._session_tree.clone_active()
        self._archive_current()
        old_thread = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._session_tree = cloned
        copy_thread_if_possible(self._checkpointer, old_thread, self._thread_id)
        self._rebuild_agent()
        self._session_title = (self._session_title or "session") + " (clone)"
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"已 clone 当前分支 → {self._thread_id}")
        self._app.render()

    def _cmd_thinking(self, _args: str) -> None:
        self._show_thinking = not self._show_thinking
        if not self._show_thinking:
            for rec in self._main_thinking_lines:
                idx = int(rec.get("idx", -1))
                if idx >= 0:
                    self._transcript.update_message_at(idx, "")
        else:
            for rec in self._main_thinking_lines:
                idx = int(rec.get("idx", -1))
                body = str(rec.get("body") or "")
                if idx < 0:
                    continue
                self._transcript.update_message_at(
                    idx,
                    render_thinking_line(
                        body=body,
                        done=True,
                        expanded=self._thinking_expanded,
                    ),
                )
        state = "显示" if self._show_thinking else "隐藏"
        self._toast(f"思考块 → {state}")

    def _cmd_details(self, _args: str) -> None:
        self._toggle_tool_outputs()

    def _snapshot_record(self) -> _SessionRecord:
        return _SessionRecord(
            thread_id=self._thread_id,
            title=self._session_title or self._thread_id,
            lines=self._transcript.snapshot(),
        )

    def _push_undo_checkpoint(self) -> None:
        self._undo_stack.append(self._snapshot_record())
        if len(self._undo_stack) > 40:
            self._undo_stack = self._undo_stack[-40:]
        self._redo_stack.clear()

    def _restore_record(self, rec: _SessionRecord) -> None:
        self._thread_id = rec.thread_id
        self._session_title = rec.title
        self._bridge = self._make_bridge()
        self._stream_idx = -1
        self._stream_buf = ""
        self._thinking_idx = -1
        self._thinking_body = ""
        self._main_thinking_lines = []
        self._transcript.restore(rec.lines)

    def _cmd_undo(self, _args: str) -> None:
        if not self._undo_stack:
            self._toast("没有可撤销的回合")
            return
        self._redo_stack.append(self._snapshot_record())
        rec = self._undo_stack.pop()
        self._restore_record(rec)
        self._toast("已撤销上一回合")

    def _cmd_redo(self, _args: str) -> None:
        if not self._redo_stack:
            self._toast("没有可重做的回合")
            return
        self._undo_stack.append(self._snapshot_record())
        rec = self._redo_stack.pop()
        self._restore_record(rec)
        self._toast("已重做")

    def _cmd_init(self, args: str) -> None:
        """Send the initialize template to the agent to write AGENTS.md."""
        from circle.system_prompt import load_command_prompt

        tmpl = load_command_prompt("initialize")
        if not tmpl:
            self._toast("缺少 prompts/commands/initialize.md")
            return
        focus = (args or "").strip() or "(none)"
        prompt = tmpl.replace("$ARGUMENTS", focus)
        # Feed as a normal user turn so the agent writes AGENTS.md via tools.
        self._on_submit(prompt)

    def _cmd_trust(self, _args: str) -> None:
        from circle.trust import accept_trust

        if is_folder_trusted(self.settings, self.workspace):
            self._toast(f"已信任: {self.workspace}")
            return
        self.settings = accept_trust(self.settings, self.workspace, home=self.home)
        self._toast(f"已信任并创建 .agent/: {self.workspace}")

    def _cmd_settings(self, _args: str) -> None:
        auth = self.settings.auth
        lines = [
            f"settings · theme={self.settings.theme}",
            f"  mode={auth.mode} protocol={auth.protocol} model={auth.model}",
            f"  base_url={auth.base_url or '—'}",
            f"  oauth_provider={auth.oauth_provider or '—'}",
            f"  trusted_folders={len(self.settings.trusted_folders)}",
            f"  mcp_servers={len(self.settings.mcp_servers)}",
            f"  home={self.home}",
        ]
        for line in lines:
            self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
        self._app.render()

    def _cmd_themes(self, args: str) -> None:
        available = ("terminal", "dark", "light")
        name = args.strip().lower()
        if not name:
            self._toast(f"当前主题: {self.settings.theme}")
            self._toast("可选: " + ", ".join(available))
            return
        if name not in available:
            self._toast(f"未知主题 {name!r}；可选: {', '.join(available)}")
            return
        self.settings.theme = name
        save_settings(self.settings, self.home)
        self._toast(f"主题 → {name}（终端色板仍以探测为准）")

    def _cmd_mcp(self, args: str) -> None:
        token = (args or "").strip().lower()
        if token in {"reload", "refresh", "connect"}:
            try:
                self._rebuild_agent()
            except Exception as exc:  # noqa: BLE001
                self._toast(f"MCP reload 失败: {exc}")
                return
            self._toast(f"MCP 已重载，工具 {len(self._mcp_tools)} 个")
            return
        for line in format_mcp_status(self.settings.mcp_servers, self._mcp_tools).splitlines():
            self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
        self._app.render()

    def _cmd_extensions(self, args: str) -> None:
        """/extensions — 列出扩展；/extensions reload 重新加载并重建 agent。"""
        if (args or "").strip().lower() in {"reload", "refresh"}:
            self.settings = load_settings(self.home)
            self._extensions = self._load_extensions()
            try:
                self._rebuild_agent()
            except Exception as exc:  # noqa: BLE001
                self._toast(f"扩展重载失败: {exc}")
                return
            self._toast(f"扩展已重载，工具 {len(self._extensions.tool_specs())} 个")
        for line in self._extensions.describe():
            self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
        self._app.render()

    def _cmd_name(self, args: str) -> None:
        title = args.strip()
        if not title:
            self._toast(f"当前会话名: {self._session_title}")
            self._toast("用法: /name <title>")
            return
        self._session_title = title[:80]
        self._toast(f"会话名 → {self._session_title}")

    def _cmd_session(self, _args: str) -> None:
        n = self._transcript.message_count()
        share = str(self._share_path) if self._share_path else "—"
        for line in (
            f"session {self._thread_id}",
            f"  title={self._session_title}",
            f"  model={self.settings.auth.model}",
            f"  lines={n}  undo={len(self._undo_stack)}  archive={len(self._archive)}",
            f"  share={share}",
        ):
            self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
        self._app.render()

    def _clipboard_set(self, text: str) -> bool:
        import shutil
        import subprocess

        payload = text.encode("utf-8")
        for cmd in (
            ["pbcopy"],
            ["wl-copy"],
            ["xclip", "-selection", "clipboard"],
        ):
            if not shutil.which(cmd[0]):
                continue
            try:
                subprocess.run(cmd, input=payload, check=True)
                return True
            except (OSError, subprocess.CalledProcessError):
                continue
        return False

    def _cmd_copy(self, _args: str) -> None:
        text = self._last_assistant_plain.strip()
        if not text:
            # fall back: last non-empty transcript line
            for msg in reversed(self._transcript.snapshot()):
                plain = _strip_ansi(msg).strip()
                if plain and not plain.startswith(">") and "Circle ·" not in plain:
                    text = plain
                    break
        if not text:
            self._toast("没有可复制的助手消息")
            return
        if self._clipboard_set(text):
            self._toast(f"已复制 {len(text)} 字符到剪贴板")
        else:
            path = self.home / "exports" / "last-copy.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text + "\n", encoding="utf-8")
            self._toast(f"无剪贴板工具，已写入 {path}")

    def _write_markdown_export(self, path: Path) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f"# Circle session `{self._thread_id}`",
            "",
            f"- workspace: `{self.workspace}`",
            f"- model: `{self.settings.auth.model}`",
            f"- title: `{self._session_title}`",
            f"- exported: `{stamp}`",
            "",
            "---",
            "",
        ]
        for msg in self._transcript.snapshot():
            lines.append(_strip_ansi(msg).rstrip())
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _cmd_export(self, args: str) -> None:
        ensure_home(self.home)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        raw = args.strip()
        if raw:
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = self.workspace / path
        else:
            path = self.home / "exports" / f"circle-{self._thread_id}-{stamp}.md"
        self._write_markdown_export(path)
        self._toast(f"已导出 {path}")

    def _cmd_import(self, args: str) -> None:
        raw = args.strip()
        if not raw:
            self._toast("用法: /import <path.md>")
            return
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = self.workspace / path
        if not path.is_file():
            alt = self.home / "exports" / raw
            path = alt if alt.is_file() else path
        if not path.is_file():
            self._toast(f"找不到文件 {raw}")
            return
        body = path.read_text(encoding="utf-8")
        self._push_undo_checkpoint()
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._bridge = self._make_bridge()
        self._session_title = path.stem[:60]
        lines = [f" {ln}" if ln else "" for ln in body.splitlines()]
        self._transcript.restore(lines)
        try:
            from langchain_core.messages import HumanMessage

            inject_thread_message(
                self._agent,
                self._thread_id,
                HumanMessage(
                    content=(
                        "Imported prior transcript for continuity.\n" + body[:8000]
                    )
                ),
            )
        except Exception as exc:  # noqa: BLE001
            self._toast(f"已导入 UI，但写入 checkpointer 失败: {exc}")
            return
        self._toast(f"已导入 {path}（已写入 checkpointer 线程）")

    def _cmd_share(self, _args: str) -> None:
        ensure_home(self.home)
        share_dir = self.home / "shares"
        share_dir.mkdir(parents=True, exist_ok=True)
        path = share_dir / f"{self._thread_id}.md"
        self._write_markdown_export(path)
        self._share_path = path
        copied = self._clipboard_set(str(path))
        extra = " · 路径已复制" if copied else ""
        self._toast(f"本地分享副本: {path}{extra}")

    def _cmd_unshare(self, _args: str) -> None:
        path = self._share_path
        if path is None:
            candidate = self.home / "shares" / f"{self._thread_id}.md"
            path = candidate if candidate.is_file() else None
        if path is None or not path.is_file():
            self._toast("没有活动的分享文件")
            return
        try:
            path.unlink()
        except OSError as exc:
            self._toast(f"删除失败: {exc}")
            return
        self._share_path = None
        self._toast(f"已取消分享 {path}")

    def _cmd_editor(self, _args: str) -> None:
        import os
        import shutil
        import subprocess
        import tempfile

        editor = (
            (os.environ.get("VISUAL") or "").strip()
            or (os.environ.get("EDITOR") or "").strip()
            or ("nvim" if shutil.which("nvim") else "")
            or ("vim" if shutil.which("vim") else "")
            or ("nano" if shutil.which("nano") else "")
        )
        if not editor:
            self._toast("未设置 $VISUAL/$EDITOR，且找不到 nvim/vim/nano")
            return
        initial = self._prompt.value
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".md",
            delete=False,
            encoding="utf-8",
        ) as tmp:
            tmp.write(initial)
            tmp_path = Path(tmp.name)
        try:
            self._app.suspend_for_external()
            try:
                subprocess.run([editor, str(tmp_path)], check=False)
            finally:
                self._app.resume_from_external()
            text = tmp_path.read_text(encoding="utf-8")
        except OSError as exc:
            self._toast(f"打开编辑器失败: {exc}")
            return
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
        self._prompt.set_value(text.rstrip("\n"))
        self._toast("已从编辑器载入（Enter 发送）")
        self._app.render()

    def _cmd_reload(self, _args: str) -> None:
        self.settings = load_settings(self.home)
        apply_auth_to_environ(self.settings, self.home)
        self._extensions = self._load_extensions()
        try:
            self._rebuild_agent()
        except Exception as exc:  # noqa: BLE001
            self._toast(f"reload 部分失败: {exc}")
            return
        self._footer.update(model=self.settings.auth.model)
        self._toast("已重新加载 settings / 模型")

    # ── busy / footer ──────────────────────────────────────────────────

    def _sync_model_meter(self) -> None:
        self._footer.update(
            model=self.settings.auth.model,
            tokens_budget=context_window_for(self.settings.auth.model),
            reasoning_effort=reasoning_effort_of(getattr(self, "_chat_model", None)),
        )

    def _apply_usage(self, usage: dict | None) -> None:
        if not usage:
            return
        kwargs: dict = {
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
            "cache_hit_tokens": int(usage.get("cache_hit") or 0),
            "cache_write_tokens": int(usage.get("cache_write") or 0),
            "reasoning_tokens": int(usage.get("reasoning_tokens") or 0),
            "tokens_used": int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0),
        }
        if usage.get("reasoning_effort"):
            kwargs["reasoning_effort"] = str(usage["reasoning_effort"])
        self._footer.update(**kwargs)

    def _fill_tool_lines(self, reqs: list) -> None:
        for req in reqs:
            if not isinstance(req, dict):
                continue
            name = str(req.get("name") or req.get("tool") or "")
            args = req.get("args") if isinstance(req.get("args"), dict) else {}
            if not name or not args:
                continue
            call_id = str(req.get("id") or req.get("tool_call_id") or "")
            self._upsert_tool_line(call_id, name, args)

    def _tool_call_line(self, name: str, args: dict) -> str:
        from circle.ink.theme import status_light

        pal = palette()
        shown = format_tool_args(args)
        return (
            f" {status_light('running')} {pal.dim}{name}"
            f"({pal.blue}{shown}{pal.dim}){pal.reset}"
        )

    def _upsert_tool_line(self, call_id: str, name: str, args: dict) -> None:
        shown = format_tool_args(args)
        line = self._tool_call_line(name, args if shown else {})
        if call_id and call_id in self._tool_line_at:
            if not shown:
                return
            self._transcript.update_message_at(self._tool_line_at[call_id], line)
            return
        if not call_id and shown:
            for cid, idx in reversed(list(self._tool_line_at.items())):
                if self._tool_names.get(cid) == name and not self._tool_filled.get(cid):
                    self._transcript.update_message_at(idx, line)
                    self._tool_filled[cid] = True
                    return
        self._transcript.append_message(line)
        if call_id:
            self._tool_line_at[call_id] = self._transcript.message_count() - 1
            self._tool_names[call_id] = name
            self._tool_filled[call_id] = bool(shown)

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
        self._agent_rows.clear()
        self._seen_call_ids.clear()
        self._sync_agent_strip()
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
            self._apply_usage(update.usage)
            # 工具调用请求（LLM 要调工具）→ 状态灯 + 工具名(参数)
            if update.tool_calls:
                for tc in update.tool_calls:
                    name = str(tc.get("name", "tool"))[:40]
                    call_id = str(tc.get("id") or "")
                    args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
                    if name == "task":
                        self._note_task(tc)
                    self._upsert_tool_line(call_id, name, args)
                self._sync_agent_strip()
                self._app.render()
                return
            # 工具结果 → 状态灯 + 摘要（折叠，ctrl+o 展开）
            if update.tool_name:
                if update.tool_name == "task":
                    self._drop_task(update.tool_call_id)
                    self._sync_agent_strip()
                pal = palette()
                from circle.ink.theme import status_light
                output = str(update.tool_output)
                self._extensions.emit("tool_result", {
                    "tool": update.tool_name, "output": output,
                    "tool_call_id": update.tool_call_id})
                if self._render_extension_result(update):
                    self._app.render()
                    return
                lines = output.split("\n")
                is_error = "error" in output.lower()[:200] or "Error" in output[:200]
                is_ok = not is_error and ("exit code 0" in output or "succeeded" in output or len(output.strip()) > 0)
                light = status_light("error" if is_error else "ok")
                # 折叠模式：只显示首行摘要
                if not self._tool_outputs_expanded:
                    first = lines[0][:100] if lines else ""
                    hidden = max(0, len(lines) - 1)
                    hint = f" {pal.faint}(ctrl+o 展开 +{hidden}行){pal.reset}" if hidden > 3 else ""
                    line = f" {light} {pal.faint}{first}{pal.reset}{hint}"
                    self._transcript.append_message(line)
                else:
                    # 展开模式：最多 30 行
                    shown = lines[:30]
                    rendered = f" {light} {pal.faint}{shown[0][:120]}{pal.reset}"
                    for ln in shown[1:]:
                        rendered += f"\n   {pal.faint}{ln[:120]}{pal.reset}"
                    if len(lines) > 30:
                        rendered += f"\n   {pal.faint}… +{len(lines)-30} 行{pal.reset}"
                    self._transcript.append_message(rendered)
                self._app.render()
                return
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

    def _render_extension_result(self, update: StreamUpdate) -> bool:
        """扩展为该工具注册了渲染器时由它出行；渲染器出错就回落默认折叠行。"""
        renderer = self._extensions.renderer(str(update.tool_name))
        if renderer is None:
            return False
        try:
            lines = renderer(update)
        except Exception:  # noqa: BLE001
            return False
        if not lines:
            return False
        for line in lines:
            self._transcript.append_message(str(line))
        return True

    def _refresh_thinking_row(self, *, done: bool | None = None) -> None:
        if not self._show_thinking:
            if self._thinking_idx >= 0:
                self._transcript.update_message_at(self._thinking_idx, "")
            return
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
            self._main_thinking_lines.append(
                {"idx": self._thinking_idx, "body": self._thinking_body}
            )
        else:
            self._transcript.update_message_at(self._thinking_idx, line)
            for rec in self._main_thinking_lines:
                if rec.get("idx") == self._thinking_idx:
                    rec["body"] = self._thinking_body
                    break
            else:
                self._main_thinking_lines.append(
                    {"idx": self._thinking_idx, "body": self._thinking_body}
                )

    def _on_done(self, text: str) -> None:
        with self._app.lock:
            visible = (text or "").strip() or "（无输出）"
            self._last_assistant_plain = visible
            self._session_tree.add("assistant", visible)
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
            self._extensions.emit("turn_end", {"text": visible})
            # 延迟 drain：等 bridge 完全退出 running 状态后再消费队列
            import threading
            timer = threading.Timer(0.15, self._drain_message_queue)
            timer.daemon = True
            timer.start()

    def _on_error(self, exc: BaseException) -> None:
        with self._app.lock:
            self._transcript.append_message(f" \x1b[31m✖ {_format_llm_error(exc)}\x1b[0m")
            self._stream_idx = -1
            self._leave_busy()
            self._app.render()
            self._extensions.emit("turn_end", {"error": _format_llm_error(exc)})
            self._drain_message_queue()

    def _on_interrupt(self, interrupts: Any) -> None:
        # yolo 模式：直接批准，不弹审批面板
        if getattr(self._bridge, "auto_approve", False):
            import time as _time
            first = (interrupts[0] if isinstance(interrupts, (list, tuple)) and interrupts
                     else interrupts)
            value = getattr(first, "value", first)
            # 统计所有待审批的 tool calls（可能有多个）
            reqs = []
            if isinstance(value, dict):
                reqs = value.get("action_requests") or [value]
            elif isinstance(value, list):
                reqs = value
            else:
                reqs = [value]
            # 每个 tool call 都要有一个 decision
            decisions = [{"type": "approve"} for _ in reqs]
            with self._app.lock:
                self._fill_tool_lines(reqs)
            # 如果数量不匹配，用 bridge 的原始 resume（不走 slash 路径）
            try:
                from langgraph.types import Command as _Cmd
                self._bridge._cancelled = False
                self._bridge._spawn(_Cmd(resume={"decisions": decisions}))
            except Exception:
                # fallback：bridge.resume 会把决定扇出到全部挂起调用
                self._bridge.resume({"decision": "approve"})
            return
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
            self._fill_tool_lines(action_requests or [req])
            desc = str(req.get("description") or "")
            # Plan mode: auto-reject mutating tools (backend also hard-blocks).
            if self._plan_mode and name in {
                "execute",
                "write_file",
                "edit_file",
                "apply_patch",
            }:
                path = str(args.get("file_path") or args.get("path") or "")
                if name != "write_file" or Path(path).name.lower() not in {"plan.md", "plan"}:
                    self._toast(f"plan mode 自动拒绝 {name}")
                    self._enter_busy()
                    self._bridge.resume({"decision": "reject"})
                    return
            body = desc or "\n".join(
                f"{k}={v!r}" for k, v in list(args.items())[:8]
            )
            if len(action_requests) > 1:
                body += (
                    f"\n（另有 {len(action_requests) - 1} 个待审批工具调用，"
                    "本次决定将一并应用）"
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
