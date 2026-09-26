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
from typing import Any, Callable

from circle.approvals import REJECTED_BY_USER, default_policy
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
from circle.ink.components.ask_user_view import AskUserSession
from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.exec_approval_view import ExecApprovalSession, SessionApprovalsSession
from circle.ink.components.footer import FooterPane
from circle.ink.components.plan_panel import PlanPanel
from circle.ink.components.prompt_input import PromptInput
from circle.ink.components.transcript import Transcript
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.parse_keypress import InputEvent, InputParser, KeyPress, MouseEvent, PasteEvent
from circle.ink.theme import GLYPH_ERROR, init_palette_from_terminal, palette
from circle.model import build_chat_model, reasoning_effort_of
from circle.model_guard import add_retry_listener
from circle.pricing import context_window_for
from circle.paths import circle_home, ensure_home, normalize_workspace
from circle import __version__, secret_prompt
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
from circle.tui.agent_detail import render_detail_band, render_detail_rows
from circle.tui.agent_strip import (
    MAX_ROWS,
    format_elapsed,
    format_tokens,
    render_agent_strip,
    running_cards,
    snapshot_cards,
    strip_window,
)
from circle.tui.content_blocks import assistant_block
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.harness_bridge import NO_OUTPUT, HarnessBridge, StreamUpdate
from circle.tui.message_model import MessageSnapshot
from circle.tui.transcript_view import (
    ViewOptions,
    final_text,
    latest_todos,
    render_turn_rows,
    turn_had_output,
)
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
    bgs: list[str | None] = field(default_factory=list)  # 每行的类型底色，与 lines 等长


class _StandaloneEscapeInputParser:
    """A lone ESC is the Esc key (InfoTest ``ist_app._StandaloneEscapeInputParser``).

    Terminals send the Esc key as a bare ``\x1b``, which is also how every escape
    sequence starts, so the tokenizer holds it waiting for more. If nothing follows
    within ``_DELAY_S`` it is emitted as ``escape``. A sequence tail that still turns up
    shortly after (a split read on a slow link) gets its ESC back instead of being
    typed into the prompt."""

    _DELAY_S = 0.25
    _STRAY_WINDOW_S = 1.0
    _STRAY_TAIL_RE = re.compile(r"^\[(?:<\d+;\d+;\d+[Mm]|[0-9;?]*[A-Za-z~])$")

    def __init__(self, delegate: InputParser, emit: Callable[[InputEvent], None]) -> None:
        self._delegate = delegate
        self._emit = emit
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._stray_escape_at: float | None = None

    def feed(self, text: str) -> list[InputEvent]:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            stray_at, self._stray_escape_at = self._stray_escape_at, None
            if (stray_at is not None and time.monotonic() - stray_at <= self._STRAY_WINDOW_S
                    and self._STRAY_TAIL_RE.match(text)):
                text = "\x1b" + text
            events = self._delegate.feed(text)
            tokenizer = getattr(self._delegate, "_tokenizer", None)
            if tokenizer is not None and tokenizer.buffer == "\x1b":
                timer = threading.Timer(self._DELAY_S, self._emit_pending_escape)
                timer.daemon = True
                self._timer = timer
                timer.start()
            return events

    def _emit_pending_escape(self) -> None:
        should_emit = False
        with self._lock:
            tokenizer = getattr(self._delegate, "_tokenizer", None)
            if tokenizer is not None and tokenizer.buffer == "\x1b":
                tokenizer.reset()
                should_emit = True
                self._stray_escape_at = time.monotonic()
            self._timer = None
        if should_emit:
            self._emit(KeyPress(key="escape"))


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
        self._app.style_pool.set_selection_bg([palette().sel_bg])
        self._app._input_parser = _StandaloneEscapeInputParser(  # noqa: SLF001
            self._app._input_parser, self._handle_input)  # noqa: SLF001
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

        self._seen_call_ids: set[str] = set()
        # 在途 strip 由快照里的子代理卡片喂；选中态与滚动窗口起点记在这里
        self._agent_strip = create_element(NodeType.BOX)
        self._agent_strip.style.height = 0
        self._agent_strip_text = create_text("")
        self._agent_strip.append_child(self._agent_strip_text)
        self._strip_ids: list[str] = []
        self._strip_visible_ids: list[str] = []
        self._strip_selecting = False
        self._strip_selected: str | None = None
        self._strip_hover: str | None = None
        self._strip_start = 0
        # 子代理详情页：与主转录互斥显示（两个开关一起翻，否则两个 flex 节点对半分屏）
        self._agent_detail = Transcript()
        self._agent_detail_band = create_element(NodeType.BOX)
        self._agent_detail_band.style.height = 0
        self._agent_detail_band_text = create_text("")
        self._agent_detail_band.append_child(self._agent_detail_band_text)
        self._set_view_visible(self._agent_detail.node, False)
        self._set_view_visible(self._agent_detail_band, False)
        self._detail_active = False
        self._detail_ids: list[str] = []
        self._detail_uuid: str | None = None
        self._detail_drawn: tuple | None = None
        self._detail_buttons: list[tuple[int, int, str]] = []  # 顶栏按钮 (起列, 止列, 动作)
        self._detail_hover: str | None = None
        # 划选拖到转录视口边缘时的定时滚动
        self._autoscroll_timer: threading.Timer | None = None
        self._autoscroll_delta = 0
        self._drag_point: tuple[int, int] | None = None
        self._welcome_shown = False
        self._ticked_at = 0.0
        # write_todos 的计划面板（对话框上方）
        self._plan_panel = PlanPanel()
        self._plan_width = 0
        # 本回合耗时：不含停下等用户审批/作答的时间
        self._turn_started_at = 0.0
        self._turn_elapsed = 0.0

        root = self._app.root
        root.append_child(self._transcript.node)
        root.append_child(self._agent_detail_band)
        root.append_child(self._agent_detail.node)
        root.append_child(self._plan_panel.node)
        root.append_child(self._ask_panel.node)
        root.append_child(self._dialog)
        root.append_child(self._footer.node)
        root.append_child(self._agent_strip)

        self._app.on_input = self._handle_input

        self._is_loading = False
        self._thinking_expanded = False
        self._show_thinking = True
        self._tool_outputs_expanded = False
        self._show_details = False  # alias of tool_outputs_expanded (InfoTest verbose)
        # 本回合在转录里占的区域：从 _turn_base 起的 _turn_entries 条（正文, 底色），由快照
        # 整体渲染；已结束的回合留在 _turns 里，ctrl+o / ctrl+t 时按各自的最后快照原位重画
        self._turn_base = -1
        self._turn_entries: list[tuple[str, str | None]] = []
        self._turns: list[dict[str, Any]] = []
        self._last_snap: MessageSnapshot | None = None
        self._pending_calls: list[dict[str, Any]] = []
        self._snap_sig: tuple | None = None
        self._snap_rendered_at = 0.0
        self._call_started_at = 0.0
        self._exec_approval: ExecApprovalSession | None = None
        # 一次中断里的多个待审批调用逐个问，答案按顺序攒齐后一起 resume
        self._approval_queue: list[dict[str, Any]] = []
        self._approval_decisions: list[dict[str, Any]] = []
        # 非审批形态的中断按 payload["kind"] 分派（C2 的问答面板挂在这里）
        self._interrupt_handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        # question 工具的普通题：ask_user 中断逐个问，答完一起 resume（多个并行时按中断 id）
        self._ask_session: AskUserSession | None = None
        self._ask_queue: list[tuple[str | None, dict[str, Any]]] = []
        self._ask_replies: list[tuple[str | None, dict[str, Any]]] = []
        # /approvals 管理页
        self._approvals_page: SessionApprovalsSession | None = None
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

        self._approvals = default_policy(self.home, settings.credential_files or None)
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
            approvals=self._approvals,
            ask_user=True,
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
            approvals=self._approvals,
            ask_user=True,
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
            on_snapshot=self._on_snapshot,
        )

    def run(self) -> int:
        self._app.start()
        remove_listener = add_retry_listener(self._on_model_retry)
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
            remove_listener()
            self._bridge.cancel()
            self._app.stop()
        return 0

    def _on_model_retry(self, event: dict[str, Any]) -> None:
        """模型层重试与参数降级如实上屏：用户能看到在等什么、丢了什么。"""
        kinds = {"rate_limit": "端点限流", "server": "端点出错", "network": "网络中断",
                 "inband": "流内出错"}
        if event.get("event") == "retry":
            msg = (f"{kinds.get(str(event.get('kind')), '请求失败')}，{event.get('wait_s')}s 后重试"
                   f"（{event.get('attempt')}/{event.get('max')}）")
        elif event.get("event") == "param_dropped":
            msg = f"端点不接受参数 {event.get('param')}，本会话起不再发送"
        elif event.get("event") == "output_budget_exhausted":
            msg = "模型的输出额度在给出回答前就被思考用完，本轮没有回答"
        else:
            return
        with self._app.lock:
            self._toast(msg)

    def _show_welcome(self) -> None:
        self._footer.update(status="ready")
        if not self._welcome_shown:
            # InfoTest 终版 welcome（07 §11.25(5)）：单条消息一次落，空行由消息内 \n 承载；
            # 键位说明只在这里出现这一次（页脚不再常驻键位行）。
            pal = palette()
            auth = self.settings.auth
            self._transcript.append_message(
                f"\n {pal.em}Circle v{__version__}{pal.reset}"
                f"\n {pal.dim}{auth.protocol} / {auth.model} · {self.workspace}{pal.reset}"
                f"\n"
                f"\n {pal.text}终端里的 AI coding agent，在项目目录里读改跑。{pal.reset}"
                f"\n {pal.dim}/help 查看命令 · /init 初始化项目 · /models 切换模型 · "
                f"ctrl+c 中断 · ctrl+d 退出 · ↑↓ 历史{pal.reset}"
            )
            self._welcome_shown = True
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
            bottom_label=self._footer.obs_warning,
        )
        self._dialog_top_text.set_value(top)
        self._dialog_left_text.set_value(left)
        self._dialog_right_text.set_value(right)
        self._dialog_bottom_text.set_value(bottom)
        self._tick_agents()
        self._render_agent_detail()
        self._sync_agent_strip()
        self._sync_plan_panel()

    # ── subagents: strip, selection, detail page ───────────────────────────

    def _tick_agents(self) -> None:
        """While subagents run, redraw what shows their clock and lamps (twice a second)."""
        snap = self._last_snap
        if snap is None or not running_cards(snap):
            return
        now = time.monotonic()
        if now - self._ticked_at < 0.5:
            return
        self._ticked_at = now
        if self._turn_base >= 0:
            self._render_turn_region()
        if self._detail_active:
            self._render_agent_detail(force=True)

    def _sync_agent_strip(self) -> None:
        strip = getattr(self, "_agent_strip", None)
        text = getattr(self, "_agent_strip_text", None)
        if strip is None or text is None:
            return
        snap = getattr(self, "_last_snap", None)
        cards = running_cards(snap) if snap is not None else []
        ids = [uuid_ for uuid_, _card in cards]
        self._strip_ids = ids
        if self._strip_selecting and self._strip_selected not in ids:
            self._strip_selected = ids[0] if ids else None
            self._strip_selecting = bool(ids)
        selected = self._detail_uuid if self._detail_active else (
            self._strip_selected if self._strip_selecting else None)
        self._strip_start = strip_window(ids, selected, self._strip_start, MAX_ROWS)
        visible = cards[self._strip_start:self._strip_start + MAX_ROWS]
        self._strip_visible_ids = [uuid_ for uuid_, _card in visible]
        if not visible:
            strip.style.height = 0
            text.set_value("")
            return
        hover = self._strip_hover if self._strip_hover in self._strip_visible_ids else None
        lines = render_agent_strip(visible, width=max(40, self._app.width or 80),
                                   selected=selected, hover=hover, total=len(cards),
                                   hidden=len(cards) - len(visible))
        strip.style.height = len(lines)
        text.set_value("\n".join(lines))

    def _strip_row_at(self, row: int) -> str | None:
        """The card of the strip row under the mouse (rule and header come first)."""
        if not self._strip_visible_ids:
            return None
        at = int(row) - int(getattr(self._agent_strip.rect, "y", 0)) - 2
        return self._strip_visible_ids[at] if 0 <= at < len(self._strip_visible_ids) else None

    def _find_card(self, uuid_: str | None) -> Any:
        """The card's payload as the snapshot holds it (a changed card is a new object)."""
        snaps = [self._last_snap] + [turn["snap"] for turn in reversed(self._turns)]
        for snap in snaps:
            if snap is None:
                continue
            for card_id, card in snapshot_cards(snap):
                if card_id == uuid_:
                    return card
        return None

    @staticmethod
    def _set_view_visible(node: Any, visible: bool) -> None:
        # is_hidden 只挡绘制、不让布局高度；布局只看 display，两个一起翻
        node.is_hidden = not visible
        node.style.display = "flex" if visible else "none"

    def _enter_agent_detail(self, uuid_: str | None = None) -> bool:
        target = uuid_ or self._strip_selected
        if not target or self._find_card(target) is None:
            return False
        ids = list(self._strip_ids)
        if target not in ids:
            ids.append(target)
        self._detail_active = True
        self._detail_ids = ids
        self._detail_uuid = target
        self._strip_selecting = target in self._strip_ids
        self._strip_selected = target if self._strip_selecting else None
        self._set_view_visible(self._transcript.node, False)
        self._set_view_visible(self._agent_detail.node, True)
        self._set_view_visible(self._agent_detail_band, True)
        self._agent_detail.clear()
        self._detail_drawn = None
        self._render_agent_detail(force=True)
        self._sync_agent_strip()
        self._app.render()
        return True

    def _leave_agent_detail(self, *, render: bool = True) -> None:
        current = self._detail_uuid
        self._detail_active = False
        self._detail_ids = []
        self._detail_uuid = None
        self._detail_drawn = None
        self._detail_buttons = []
        self._detail_hover = None
        self._set_view_visible(self._transcript.node, True)
        self._set_view_visible(self._agent_detail.node, False)
        self._set_view_visible(self._agent_detail_band, False)
        self._agent_detail_band.style.height = 0
        self._agent_detail_band_text.set_value("")
        self._agent_detail.clear()
        self._strip_selecting = bool(self._strip_ids)
        self._strip_selected = (current if current in self._strip_ids
                                else (self._strip_ids[0] if self._strip_ids else None))
        self._sync_agent_strip()
        if render:
            self._app.render()

    def _switch_agent_detail(self, delta: int) -> bool:
        if not self._detail_ids or self._detail_uuid not in self._detail_ids:
            return False
        at = (self._detail_ids.index(self._detail_uuid) + delta) % len(self._detail_ids)
        self._detail_uuid = self._detail_ids[at]
        if self._detail_uuid in self._strip_ids:
            self._strip_selecting = True
            self._strip_selected = self._detail_uuid
        self._agent_detail.clear()
        self._render_agent_detail(force=True)
        self._sync_agent_strip()
        self._app.render()
        return True

    def _render_agent_detail(self, *, force: bool = False) -> None:
        """Redraw the page when its card changed (or on a tick / toggle with ``force``);
        a reader scrolled up stays where they are."""
        if not self._detail_active:
            return
        card = self._find_card(self._detail_uuid)
        width = max(40, self._app.width or 80)
        drawn = self._detail_drawn
        state = (width, self._thinking_expanded, self._detail_hover)
        if not force and drawn is not None and drawn[0] is card and drawn[1:] == state:
            return
        self._detail_drawn = (card, *state)
        view = self._agent_detail
        if card is None:
            self._agent_detail_band.style.height = 0
            self._agent_detail_band_text.set_value("")
            self._detail_buttons = []
            view.clear()
            view.append_message(" " + _faint("这个子代理的记录已不可用，按 esc 返回主视图"))
            return
        ids = self._detail_ids
        band, self._detail_buttons = render_detail_band(
            card, index=ids.index(self._detail_uuid) + 1, total=len(ids), width=width,
            hover=self._detail_hover)
        self._agent_detail_band.style.height = len(band)
        self._agent_detail_band_text.set_value("\n".join(band))
        rows = render_detail_rows(card, expanded=self._thinking_expanded)
        # 重建不丢读者的位置：往上翻过的留在原处，贴底的继续贴底
        sticky, top = view.node.sticky_scroll, view.node.scroll_top
        view.restore([f" {line}" if line else "" for line, _bg in rows], [bg for _line, bg in rows])
        if not sticky:
            view.node.sticky_scroll = False
            view.node.scroll_top = min(top, view.max_top())

    def _handle_agent_view_key(self, kp: KeyPress) -> bool:
        """Strip selection and the detail page; True when the key was theirs."""
        key = kp.key
        printable = bool(kp.char and len(kp.char) == 1 and kp.char.isprintable()
                         and not getattr(kp, "ctrl", False) and not getattr(kp, "alt", False))
        if self._detail_active:
            if key in ("escape", "backspace"):
                self._leave_agent_detail()
                return True
            if key in ("left", "right"):
                return self._switch_agent_detail(-1 if key == "left" else 1)
            if printable:
                self._leave_agent_detail(render=False)
                self._strip_selecting = False
                self._strip_selected = None
                self._sync_agent_strip()
            return False
        if self._strip_selecting:
            ids = self._strip_ids
            at = ids.index(self._strip_selected) if self._strip_selected in ids else 0
            if key == "down" and ids:
                self._strip_selected = ids[(at + 1) % len(ids)]
            elif key == "up" and ids:
                self._strip_selected = ids[(at - 1) % len(ids)]
            elif key in ("return", "enter"):
                return self._enter_agent_detail()
            elif key == "escape":
                self._strip_selecting = False
                self._strip_selected = None
            else:
                if printable:
                    self._strip_selecting = False
                    self._strip_selected = None
                    self._sync_agent_strip()
                return False
            self._sync_agent_strip()
            self._app.render()
            return True
        if key == "down" and self._strip_ids and not self._prompt.value:
            self._strip_selecting = True
            self._strip_selected = self._strip_ids[0]
            self._sync_agent_strip()
            self._app.render()
            return True
        return False

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

        if self._ask_session is not None and self._handle_ask_key(kp):
            return

        if self._approvals_page is not None:
            if self._approvals_page.handle_key(kp.key, kp.char):
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

        # 选中子代理 / 详情页里的 esc 是退出这一层，不是中止回合
        if self._handle_agent_view_key(kp):
            return

        if kp.key == "ctrl+c":
            now = time.time()
            if self._is_loading:
                self._bridge.cancel()
                self._dismiss_user_panels()
                self._notice([" " + _faint("(cancelled)")])
                self._leave_busy()
                self._app.render()
                self._last_ctrl_c = now
                return
            if now - self._last_ctrl_c < 1.5:
                self._app._running = False  # noqa: SLF001
                return
            self._last_ctrl_c = now
            self._notice([" " + _faint("(press ctrl+c again to exit)")])
            self._app.render()
            return

        if kp.key == "ctrl+d":
            self._app._running = False  # noqa: SLF001
            return

        if kp.key == "escape":
            if self._is_loading:
                self._bridge.cancel()
                self._dismiss_user_panels()
                self._notice([" " + _faint("(cancelled)")])
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

        # 转录滚动键只在输入框为空时接管；非空时 home/end 归输入框的光标
        if not self._prompt.value:
            if kp.key == "pageup":
                self._scroll_transcript(-self._half_viewport())
                return
            if kp.key == "pagedown":
                self._scroll_transcript(self._half_viewport())
                return
            if kp.key == "home":
                self._scroll_transcript_to(0)
                return
            if kp.key == "end":
                self._scroll_transcript_to(None)
                return

        if kp.key == "ctrl+r":
            self._enter_or_advance_search()
            return

        # 输入框为空且历史翻尽时 ↑↓ 滚转录；有历史可翻或框里有字时仍是输入历史
        if kp.key == "up":
            if not self._prompt.value and not self._input_history.can_go_up():
                self._scroll_transcript(-3)
            else:
                self._history_up()
            self._app.render()
            return
        if kp.key == "down":
            if not self._prompt.value and not self._input_history.can_go_down():
                self._scroll_transcript(3)
            else:
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
        # InfoTest IstInkApp._handle_mouse — text selection, copy, wheel; a click on
        # an in-flight strip row opens that subagent's detail page.
        col, row = self._mouse_to_screen_coords(me.x, me.y)

        if me.type == "wheel":
            # 划选中滚轮同样扩选：选区锚点随内容走、落点留在鼠标下
            if me.button == 0:
                self._scroll_transcript(-3)
            elif me.button == 1:
                self._scroll_transcript(3)
            return

        if me.type == "move" and me.button != 0:
            self._handle_hover(col, row)
            return

        if me.button != 0:
            return

        if me.type == "press":
            if self._handle_ui_click(col, row):
                return
            self._handle_left_press(col, row, alt=me.alt)
            return

        if me.type == "move":
            sel = self._app.selection
            if not sel.is_dragging:
                return
            self._drag_to(col, row)
            self._start_selection_autoscroll(row)
            self._app.notify_selection_change()
            self._app.render()
            return

        if me.type == "release":
            from circle.ink.selection import finish_selection, has_selection

            self._stop_selection_autoscroll()
            self._drag_point = None
            sel = self._app.selection
            was_dragging = sel.is_dragging
            finish_selection(sel)
            if was_dragging and has_selection(sel):
                self._copy_selection(clear_after=False)
            self._app.notify_selection_change()
            self._app.render()

    def _drag_to(self, col: int, row: int) -> None:
        from circle.ink.selection import extend_selection, update_selection

        sel = self._app.selection
        self._drag_point = (col, row)
        if sel.anchor_span is not None:
            extend_selection(sel, self._app._curr_screen, col, row)  # noqa: SLF001
        else:
            update_selection(sel, col, row)

    def _start_selection_autoscroll(self, row: int) -> None:
        """Dragging a selection to the transcript's top or bottom edge keeps scrolling
        it (every 0.12s, two rows) and the selection grows onto the revealed rows."""
        view = self._agent_detail if self._detail_active else self._transcript
        rect = view.node.rect
        delta = 0
        if rect.height > 2:
            if row <= rect.y + 1:
                delta = -2
            elif row >= rect.y + rect.height - 2:
                delta = 2
        if delta == 0:
            self._stop_selection_autoscroll()
            return
        if self._autoscroll_timer is not None and self._autoscroll_delta == delta:
            return
        self._stop_selection_autoscroll()
        self._autoscroll_delta = delta
        self._arm_autoscroll()

    def _arm_autoscroll(self) -> None:
        def _step() -> None:
            with self._app.lock:
                if self._autoscroll_timer is not timer:
                    return
                if not self._app.selection.is_dragging or self._autoscroll_delta == 0:
                    self._stop_selection_autoscroll()
                    return
                self._scroll_transcript(self._autoscroll_delta)
                self._arm_autoscroll()

        timer = threading.Timer(0.12, _step)
        timer.daemon = True
        self._autoscroll_timer = timer
        timer.start()

    def _stop_selection_autoscroll(self) -> None:
        timer = self._autoscroll_timer
        self._autoscroll_timer = None
        self._autoscroll_delta = 0
        if timer is not None:
            timer.cancel()

    def _detail_button_at(self, col: int, row: int) -> str | None:
        """The detail band's button under the mouse (buttons sit on the band's middle line)."""
        if not self._detail_active or not self._detail_buttons:
            return None
        if int(row) != int(getattr(self._agent_detail_band.rect, "y", 0)) + 1:
            return None
        return next((action for start, end, action in self._detail_buttons
                     if start <= int(col) < end), None)

    def _handle_hover(self, col: int, row: int) -> None:
        strip_hover = self._strip_row_at(row)
        button = self._detail_button_at(col, row)
        changed = False
        if strip_hover != self._strip_hover:
            self._strip_hover = strip_hover
            self._sync_agent_strip()
            changed = True
        if button != self._detail_hover:
            self._detail_hover = button
            self._render_agent_detail()
            changed = True
        if changed:
            self._app.render()

    def _handle_ui_click(self, col: int, row: int) -> bool:
        """A click on a detail button or a strip row; True when the click was theirs."""
        action = self._detail_button_at(col, row)
        if action == "back":
            self._leave_agent_detail()
            return True
        if action in ("prev", "next"):
            self._switch_agent_detail(-1 if action == "prev" else 1)
            return True
        clicked = self._strip_row_at(row)
        if clicked is not None:
            self._strip_hover = None
            self._enter_agent_detail(clicked)
            return True
        return False

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
        self._drag_point = (col, row)
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
        view = self._agent_detail if self._detail_active else self._transcript
        return max(1, view.viewport_height() // 2)

    def _scroll_transcript(self, delta: int) -> None:
        if delta == 0:
            return
        view = self._agent_detail if self._detail_active else self._transcript
        old_top = view.node.scroll_top
        view.scroll_by(delta)
        actual = view.node.scroll_top - old_top
        if actual != 0:
            self._shift_selection_for_scroll(actual)
        self._app._repaint_full()  # noqa: SLF001

    def _scroll_transcript_to(self, top: int | None) -> None:
        """Home / End: to the first row, or back to the bottom (None); the detail page
        when it is open."""
        view = self._agent_detail if self._detail_active else self._transcript
        old_top = view.node.scroll_top
        view.scroll_to(top)
        actual = view.node.scroll_top - old_top
        if actual != 0:
            self._shift_selection_for_scroll(actual)
        self._app._repaint_full()  # noqa: SLF001

    def _shift_selection_for_scroll(self, scroll_delta: int) -> None:
        from circle.ink.selection import (
            capture_scrolled_rows,
            has_selection,
            selection_bounds,
            shift_anchor,
            shift_selection,
        )

        sel = self._app.selection
        if not has_selection(sel):
            return
        view = self._agent_detail if self._detail_active else self._transcript
        rect = view.node.rect
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
        if sel.is_dragging:
            # 拖着划选时只有锚点随内容走，落点留在鼠标下——选区扩到新露出的行
            shift_anchor(sel, -scroll_delta, min_row, max_row)
            if self._drag_point is not None:
                self._drag_to(*self._drag_point)
        else:
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
        self._rerender_turns()
        self._render_agent_detail(force=True)
        self._app.render()

    def _toggle_tool_outputs(self) -> None:
        """InfoTest ``_toggle_expand`` / ctrl+o — tool-output verbosity."""
        self._tool_outputs_expanded = not self._tool_outputs_expanded
        self._show_details = self._tool_outputs_expanded
        self._rerender_turns()
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
            self._transcript.append_message(_faint('─' * w))
        self._transcript.ensure_block_gap()
        self._transcript.append_messages([f" {_faint('>')} {line}" for line in text.split("\n")])
        self._transcript.ensure_block_gap()
        self._open_turn_region()
        self._turn_elapsed = 0.0
        self._turn_started_at = time.time()
        self._enter_busy()
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

    def _notice(self, lines: list[str]) -> None:
        """One block of notice lines, one blank line away from the block above."""
        if not lines:
            return
        self._transcript.ensure_block_gap()
        self._transcript.append_messages(list(lines))

    def _toast(self, msg: str) -> None:
        self._notice([f" {_faint(msg)}"])
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
            self._notice([f" {_faint(line)}" for line in help_text(custom=custom or None).splitlines()])
            self._app.render()
            return
        if name == "hotkeys":
            self._notice([f" {_faint(line)}" for line in hotkeys_text().splitlines()])
            self._app.render()
            return
        if name in self._custom_commands:
            cmd = self._custom_commands[name]
            expanded = expand_command_template(cmd.template, args, cwd=self.workspace)
            self._start_user_turn(expanded)
            return
        _busy_ok = {
            "yolo",
            "approvals",  # 看/撤规则不碰在跑的回合；撤销从下一次调用起生效
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
            "approvals": self._cmd_approvals,
        }
        handler = handlers.get(name)
        if handler is None:
            self._toast(f"未知命令 /{name} — 试 /help")
            return
        handler(args)

    def _archive_current(self) -> None:
        if self._transcript.message_count() <= 3 and self._session_title == "new":
            return
        rec = self._snapshot_record()
        for i, existing in enumerate(self._archive):
            if existing.thread_id == rec.thread_id:
                self._archive[i] = rec
                break
        else:
            self._archive.append(rec)
        self._previous_thread_id = self._thread_id

    def _switch_thread(self, thread_id: str, *, lines: list[str] | None = None,
                       bgs: list[str | None] | None = None) -> None:
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = thread_id
        self._bridge = self._make_bridge()
        self._reset_turn_regions()
        if lines is not None:
            self._transcript.restore(lines, bgs)
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
        self._reset_turn_regions()
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
                sessions.append(self._snapshot_record())
        if not sessions:
            self._toast("没有可恢复的会话（先聊几轮或 /new 归档当前）")
            return
        target = args.strip()
        if not target:
            self._toast("会话列表：")
            for i, rec in enumerate(sessions, 1):
                mark = " *" if rec.thread_id == self._thread_id else ""
                self._transcript.append_message(
                    " " + _faint(f"{i}. {rec.thread_id}  {rec.title[:40]}{mark}")
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
        self._switch_thread(chosen.thread_id, lines=chosen.lines, bgs=chosen.bgs)
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
        bgs = None
        title = prev
        for rec in self._archive:
            if rec.thread_id == prev:
                lines = rec.lines
                bgs = rec.bgs
                title = rec.title
                break
        self._switch_thread(prev, lines=lines or [], bgs=bgs)
        self._toast(f"已继续 {prev} · {title[:40]}")

    def _cmd_models(self, args: str) -> None:
        name = args.strip()
        if not name:
            models = self._list_models()
            current = self.settings.auth.model
            self._toast(f"当前模型: {current}")
            for m in models[:40]:
                mark = " *" if m == current else ""
                self._transcript.append_message(" " + _faint(f"  {m}{mark}"))
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
                        _error_line(f"compact 失败: {_format_llm_error(err)}")
                    )
                    self._app.render()
                    return
                self._notice([" " + _faint("— compacted (same thread) —")]
                             + [f" {line}" for line in (summary or "COMPACT_OK").splitlines()])
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
                self._transcript.append_message(f" {_faint(line)}")
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
                self._transcript.append_message(f" {_faint(line)}")
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
        self._reset_turn_regions()
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"已 fork 自 {token} → {self._thread_id}")
        self._notice([f" {_faint('>')} {node.text.splitlines()[0][:80]}"
                      for node in self._session_tree.path_to() if node.role == "user"])
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
        self._reset_turn_regions()
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"已 clone 当前分支 → {self._thread_id}")
        self._app.render()

    def _cmd_thinking(self, _args: str) -> None:
        self._show_thinking = not self._show_thinking
        self._rerender_turns()
        state = "显示" if self._show_thinking else "隐藏"
        self._toast(f"思考块 → {state}")

    def _cmd_details(self, _args: str) -> None:
        self._toggle_tool_outputs()

    def _snapshot_record(self) -> _SessionRecord:
        return _SessionRecord(
            thread_id=self._thread_id,
            title=self._session_title or self._thread_id,
            lines=self._transcript.snapshot(),
            bgs=self._transcript.snapshot_bgs(),
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
        self._reset_turn_regions()
        self._transcript.restore(rec.lines, rec.bgs)

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
            self._transcript.append_message(f" {_faint(line)}")
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
            self._transcript.append_message(f" {_faint(line)}")
        self._app.render()

    def _cmd_approvals(self, args: str) -> None:
        """/approvals — 本会话的「始终允许」规则；/approvals revoke <序号> 撤销一条。"""
        parts = (args or "").split()
        store = self._approvals.store
        if not parts and self._exec_approval is None and self._ask_session is None:
            self._begin_approvals_page()
            return
        if parts[:1] == ["revoke"]:
            if len(parts) != 2 or not parts[1].isdigit():
                self._toast("用法: /approvals revoke <序号>")
                return
            rule = store.revoke(self._thread_id, int(parts[1]) - 1)
            if rule is None:
                self._toast(f"没有第 {parts[1]} 条规则")
                return
            self._toast(f"已撤销：{rule.get('tool')} · {rule.get('label')}")
        rules = store.rules(self._thread_id)
        lines = ["本会话的「始终允许」规则：" if rules else "本会话没有「始终允许」规则。"]
        for i, rule in enumerate(rules, 1):
            lines.append(f"  {i}. {rule.get('tool')} · {rule.get('label') or rule.get('pattern')}")
        recent = store.log(self._thread_id)[-5:]
        if recent:
            names = {"once": "允许一次", "always": "始终允许", "reject": "拒绝", "revoke": "撤销"}
            lines.append("最近的审批：")
            for entry in recent:
                lines.append(f"  {names.get(str(entry.get('kind')), entry.get('kind'))} · "
                             f"{entry.get('tool')}")
        if rules:
            lines.append("撤销：/approvals revoke <序号>")
        for line in lines:
            self._transcript.append_message(f" {_faint(line)}")
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
            self._transcript.append_message(f" {_faint(line)}")
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
            self._transcript.append_message(f" {_faint(line)}")
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
        self._reset_turn_regions()
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
        """Footer and extension events; the transcript and the subagent strip come from
        snapshots."""
        with self._app.lock:
            self._apply_usage(update.usage)
            if update.tool_calls:
                self._app.render()
                return
            if update.tool_name:
                self._extensions.emit("tool_result", {
                    "tool": update.tool_name, "output": str(update.tool_output),
                    "tool_call_id": update.tool_call_id})
                self._app.render()
                return
            if update.thinking or update.llm_phase == "thinking":
                self._footer.update(
                    status="running",
                    llm_phase="thinking" if not update.text else (update.llm_phase or "output"),
                    call_started_at=self._call_started_at or time.time(),
                    reasoning_active=not update.thinking_done,
                    reasoning_last_line=update.reasoning_last_line,
                    reasoning_chars=update.reasoning_chars or len(update.thinking or ""),
                )
            if update.text:
                self._footer.update(
                    status="running",
                    llm_phase=update.llm_phase or "output",
                    call_started_at=self._call_started_at or time.time(),
                    output_token_count=max(1, len(update.text) // 4),
                )
            self._app.render()

    # ── snapshot rendering ────────────────────────────────────────────────

    def _view_options(self) -> ViewOptions:
        return ViewOptions(
            width=max(40, self._transcript.node.rect.width or 100),
            tools_expanded=self._tool_outputs_expanded,
            thinking_expanded=self._thinking_expanded,
            show_thinking=self._show_thinking,
            renderer_for=self._extensions.renderer,
            pending_calls=list(self._pending_calls),
        )

    def _open_turn_region(self) -> None:
        self._close_turn_region()
        self._turn_base = self._transcript.message_count()
        self._turn_entries = []
        self._last_snap = None
        self._pending_calls = []
        self._snap_sig = None

    def _close_turn_region(self) -> None:
        """The turn is over: its last snapshot moves to ``_turns`` for later redraws. No
        region is open until the next user turn, so a late snapshot draws nothing."""
        if self._turn_base >= 0 and self._last_snap is not None:
            self._turns.append({"base": self._turn_base, "entries": list(self._turn_entries),
                                "snap": self._last_snap})
        self._turn_base = -1
        self._turn_entries = []
        self._last_snap = None

    def _reset_turn_regions(self) -> None:
        if self._detail_active:
            self._leave_agent_detail(render=False)
        self._strip_selecting = False
        self._strip_selected = None
        self._plan_panel.clear()
        self._turns = []
        self._turn_base = -1
        self._turn_entries = []
        self._last_snap = None
        self._pending_calls = []
        self._snap_sig = None

    def _sync_plan_panel(self, snap: MessageSnapshot | None = None) -> None:
        width = max(40, self._app.width or 80)
        todos = latest_todos(snap) if snap is not None else None
        if todos is not None and todos != self._plan_panel.todos:
            self._plan_width = width
            self._plan_panel.update(todos, width=width)
        elif width != self._plan_width and self._plan_panel.is_visible:
            self._plan_width = width
            self._plan_panel.update(self._plan_panel.todos, width=width)

    def _on_snapshot(self, snap: MessageSnapshot) -> None:
        with self._app.lock:
            if self._turn_base < 0:
                return  # 回合已收口：迟到的快照不再上屏
            self._last_snap = snap
            self._sync_plan_panel(snap)
            # 流式 token 很密：同一形态的快照 40ms 内只画一次；消息数、状态或流式段起止一变就立刻画
            now = time.monotonic()
            sig = (len(snap.messages), snap.status, snap.streaming_text is None)
            if sig == self._snap_sig and now - self._snap_rendered_at < 0.04:
                return
            self._snap_sig = sig
            self._snap_rendered_at = now
            self._render_turn_region()
            self._app.render()

    def _render_turn_region(self) -> None:
        if self._last_snap is None or self._turn_base < 0:
            return
        new = render_turn_rows(self._last_snap, self._view_options())
        old = self._turn_entries
        i = 0
        while i < min(len(old), len(new)) and old[i] == new[i]:
            i += 1
        if i == len(old) == len(new):
            return
        self._transcript.replace_range(self._turn_base + i, len(old) - i,
                                       [text for text, _bg in new[i:]],
                                       bgs=[bg for _text, bg in new[i:]])
        self._turn_entries = new

    def _rerender_turns(self) -> None:
        """ctrl+o / ctrl+t / /thinking: redraw every turn of this session from its last
        snapshot. A turn that gains or loses entries shifts everything after it."""
        options = self._view_options()
        options.pending_calls = []
        shift = 0
        for turn in self._turns:
            turn["base"] += shift
            new = render_turn_rows(turn["snap"], options)
            old = turn["entries"]
            if new == old:
                continue
            self._transcript.replace_range(turn["base"], len(old), [text for text, _bg in new],
                                           bgs=[bg for _text, bg in new])
            shift += len(new) - len(old)
            turn["entries"] = new
        if self._turn_base >= 0:
            self._turn_base += shift
        self._render_turn_region()

    def _on_done(self, text: str) -> None:
        with self._app.lock:
            self._pending_calls = []
            self._snap_sig = None
            self._render_turn_region()
            shown = final_text(self._last_snap) if self._last_snap is not None else ""
            said = "" if (text or "").strip() == NO_OUTPUT else (text or "").strip()
            visible = shown or said or NO_OUTPUT
            if not shown:
                self._transcript.ensure_block_gap()
                self._transcript.append_message(assistant_block(said or NO_OUTPUT))
            self._last_assistant_plain = visible
            self._session_tree.add("assistant", visible)
            cooked = self._cooked_lines(answered=bool(shown or said))
            self._close_turn_region()
            for line in cooked:
                self._transcript.append_message(line)
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
            self._pending_calls = []
            self._render_turn_region()
            cooked = self._cooked_lines(answered=True)
            self._close_turn_region()
            for line in cooked:
                self._transcript.append_message(line)
            self._transcript.append_message(_error_line(_format_llm_error(exc)))
            self._leave_busy()
            self._app.render()
            self._extensions.emit("turn_end", {"error": _format_llm_error(exc)})
            self._drain_message_queue()

    def _turn_totals(self) -> tuple[float, int, int]:
        """Elapsed (without waits on the user) and this turn's tokens: the main agent's
        usage plus every subagent's, as the turn's snapshot has them."""
        elapsed = self._turn_elapsed
        if self._turn_started_at:
            elapsed += time.time() - self._turn_started_at
        snap = self._last_snap
        if snap is None:
            return elapsed, 0, 0
        usage = snap.usage or {}
        cards = [card for _uuid, card in snapshot_cards(snap)]
        tokens_in = int(usage.get("input_tokens") or 0) + sum(int(c.get("tokens_in") or 0) for c in cards)
        tokens_out = int(usage.get("output_tokens") or 0) + sum(int(c.get("tokens_out") or 0) for c in cards)
        return elapsed, tokens_in, tokens_out

    def _cooked_lines(self, *, answered: bool) -> list[str]:
        """One ``✻ Cooked`` line per user turn (not per approval pause), and a red line
        when the model gave nothing at all."""
        if not self._turn_started_at and not self._turn_elapsed:
            return []
        elapsed, tokens_in, tokens_out = self._turn_totals()
        self._turn_started_at = 0.0
        self._turn_elapsed = 0.0
        pal = palette()
        lines = [f"  {pal.dim}✻ Cooked for {format_elapsed(elapsed)} · ↑ {format_tokens(tokens_in)}"
                 f" · ↓ {format_tokens(tokens_out)} tokens{pal.reset}"]
        snap = self._last_snap
        quiet = not answered and (snap is None or not turn_had_output(snap))
        if quiet and tokens_in == 0 and tokens_out == 0:
            lines.append(_error_line("模型没有返回任何内容（0 token），本轮未完成；"
                                     "检查账户额度与接口状态后重试"))
        return lines

    def _on_interrupt(self, interrupts: Any) -> None:
        # 停下等用户：这段时间不计入本回合耗时
        if self._turn_started_at:
            self._turn_elapsed += time.time() - self._turn_started_at
            self._turn_started_at = 0.0
        items = list(interrupts) if isinstance(interrupts, (list, tuple)) else [interrupts]
        asks = [(getattr(item, "id", None), getattr(item, "value", item)) for item in items]
        asks = [(iid, v) for iid, v in asks if isinstance(v, dict) and v.get("kind") == "ask_user"]
        if asks and len(asks) == len(items):
            self._begin_ask_user(asks)
            return
        first = items[0] if items else interrupts
        value = getattr(first, "value", first)
        if isinstance(value, dict) and value.get("action_requests"):
            self._begin_approvals([r for r in value["action_requests"] if isinstance(r, dict)])
            return
        kind = str(value.get("kind") or "") if isinstance(value, dict) else ""
        handler = self._interrupt_handlers.get(kind)
        if handler is not None:
            handler(value)
            return
        # 不认识的中断形态：不能替用户作答，如实说明、停在这里
        with self._app.lock:
            self._transcript.append_message(
                _warn_line(f"收到无法处理的中断（{kind or type(value).__name__}），本回合已暂停。"))
            self._leave_busy()
            self._app.render()

    def _begin_approvals(self, requests: list[dict[str, Any]]) -> None:
        with self._app.lock:
            self._pending_calls = [dict(r) for r in requests]
            self._render_turn_region()
            self._app.render()
        if getattr(self._bridge, "auto_approve", False):  # /yolo：全部放行，不弹面板
            self._resume_with({"decisions": [{"type": "approve"} for _ in requests]})
            return
        self._approval_queue = list(requests)
        self._approval_decisions = []
        self._next_approval()

    def _record_approval(self, key: str) -> None:
        req = self._approval_queue.pop(0)
        name = str(req.get("name") or "tool")
        approved = self._approvals.remember(self._thread_id, name, req.get("args") or {}, key)
        self._approval_decisions.append(
            {"type": "approve"} if approved
            else {"type": "reject", "message": REJECTED_BY_USER})
        if not approved:
            # 被拒的调用不会执行、也就没有工具回调；补一行让它留在本回合里
            self._bridge.announce_blocked({"name": name, "args": req.get("args") or {}},
                                          REJECTED_BY_USER)

    def _next_approval(self) -> None:
        with self._app.lock:
            while self._approval_queue:
                req = self._approval_queue[0]
                name = str(req.get("name") or "tool")
                args = req.get("args") or {}
                if self._plan_mode and name in _PLAN_BLOCKED_TOOLS:
                    path = str(args.get("file_path") or args.get("path") or "")
                    if name != "write_file" or Path(path).name.lower() not in {"plan.md", "plan"}:
                        self._toast(f"plan mode 自动拒绝 {name}")
                        self._record_approval("reject")
                        continue
                review = self._approvals.review(name, args)
                pending = len(self._approval_queue) - 1
                body = _approval_body(name, args)
                if pending:
                    body += f"\n（之后还有 {pending} 个待审批调用）"
                self._begin_exec_approval({
                    "tool": name,
                    "title": name,
                    "body": body,
                    "policy": review.reason,
                    "allow_always": review.allow_always,
                    "warn_delete": review.warn_delete,
                    "scope": review.scope,
                })
                return
        decisions, self._approval_decisions = self._approval_decisions, []
        self._resume_with({"decisions": decisions})

    def _resume_with(self, value: Any) -> None:
        with self._app.lock:
            if self._ask_saved_prompt:
                self._prompt.set_value(self._ask_saved_prompt)
            self._ask_saved_prompt = ""
            self._turn_started_at = time.time()
            self._enter_busy()
            self._pending_calls = []
            self._render_turn_region()
            self._app.render()
        self._bridge.resume(value)

    # ── question panel (ask_user interrupts) ────────────────────────────

    def _begin_ask_user(self, asks: list[tuple[str | None, dict[str, Any]]]) -> None:
        with self._app.lock:
            self._ask_queue = list(asks)
            self._ask_replies = []
            if not self._ask_saved_prompt:
                self._ask_saved_prompt = self._prompt.value
            self._prompt.clear()
        self._next_ask_user()

    def _next_ask_user(self) -> None:
        with self._app.lock:
            while self._ask_queue:
                _iid, value = self._ask_queue[0]
                questions = [q for q in value.get("questions") or () if isinstance(q, dict)]
                if not questions:
                    self._ask_replies.append((self._ask_queue.pop(0)[0], {"answers": []}))
                    continue
                self._ask_session = AskUserSession(questions, render=self._render_ask_user,
                                                   on_answer=self._finish_ask_user)
                self._render_ask_user()
                return
        replies, self._ask_replies = self._ask_replies, []
        if len(replies) == 1:
            self._resume_with(replies[0][1])
        else:
            self._resume_with({iid: reply for iid, reply in replies})

    def _render_ask_user(self) -> None:
        with self._app.lock:
            if self._ask_session is None:
                self._ask_panel.clear()
            else:
                self._ask_panel.update(self._ask_session.render_lines())
            self._app.render()

    def _finish_ask_user(self, answers: list[list[str]] | None) -> None:
        with self._app.lock:
            session, self._ask_session = self._ask_session, None
            self._ask_panel.clear()
            if session is not None:
                self._toast(_strip_ansi(session.result_summary()).strip())
            if self._ask_queue:
                iid, _value = self._ask_queue.pop(0)
                self._ask_replies.append(
                    (iid, {"answers": answers} if answers is not None else {"cancelled": True}))
        self._next_ask_user()

    def _handle_ask_key(self, kp: KeyPress) -> bool:
        session = self._ask_session
        if session is None:
            return False
        if session.in_other_input:
            # 自己输入回答：字符进输入框，enter 交给面板，esc 回到选项
            if kp.key == "enter":
                text = self._prompt.value
                self._prompt.clear()
                session.submit_other_text(text)
                return True
            if kp.key == "escape":
                self._prompt.clear()
                session.cancel_other_input()
                return True
            if kp.key in ("ctrl+c", "ctrl+d"):
                return False
            if self._prompt.handle_key(kp.key if kp.key else "char",
                                       kp.char if len(kp.char) == 1 else ""):
                self._app.render()
            return True
        return session.handle_key(kp.key, kp.char)

    def _dismiss_user_panels(self) -> None:
        """The turn was cancelled: nothing will resume it, so no panel waits on the user."""
        self._ask_session = None
        self._ask_queue = []
        self._ask_replies = []
        self._exec_approval = None
        self._approval_queue = []
        self._approval_decisions = []
        self._pending_calls = []
        self._ask_panel.clear()
        if self._ask_saved_prompt:
            self._prompt.set_value(self._ask_saved_prompt)
            self._ask_saved_prompt = ""

    # ── /approvals page ──────────────────────────────────────────────────

    def _begin_approvals_page(self) -> None:
        store = self._approvals.store
        rules = store.rules(self._thread_id)
        lines: list[str] = []
        options: list[dict[str, str]] = []
        if not rules:
            lines.append("本会话没有「始终允许」规则。")
        for i, rule in enumerate(rules):
            label = str(rule.get("label") or rule.get("pattern") or "")
            lines.append(f"[always] {rule.get('tool')} · {label}")
            options.append({"key": f"revoke:{i}", "label": f"撤销: {label[:40]}"})
        names = {"once": "允许一次", "always": "始终允许", "reject": "拒绝", "revoke": "撤销"}
        recent = store.log(self._thread_id)[-5:]
        if recent:
            lines.append("最近的审批：")
            lines += [f"[{names.get(str(e.get('kind')), e.get('kind'))}] {e.get('tool')}"
                      for e in recent]
        options.append({"key": "close", "label": "关闭"})
        with self._app.lock:
            self._approvals_page = SessionApprovalsSession(
                lines=lines, options=options, render=self._render_approvals_page,
                on_finish=self._finish_approvals_page)
            self._render_approvals_page()

    def _render_approvals_page(self) -> None:
        with self._app.lock:
            if self._approvals_page is None:
                self._ask_panel.clear()
            else:
                self._ask_panel.update(self._approvals_page.render_lines())
            self._app.render()

    def _finish_approvals_page(self, choice: str) -> None:
        with self._app.lock:
            self._approvals_page = None
            self._ask_panel.clear()
            if choice.startswith("revoke:"):
                rule = self._approvals.store.revoke(self._thread_id, int(choice.split(":", 1)[1]))
                if rule is not None:
                    self._toast(f"已撤销：{rule.get('tool')} · {rule.get('label') or rule.get('pattern')}"
                                "，下次同类调用会再问")
            self._app.render()

    def _begin_exec_approval(self, payload: dict) -> None:
        if not self._ask_saved_prompt:
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
        if self._approval_queue:
            self._record_approval(str(decision.get("decision") or "reject"))
        self._next_approval()


def _faint(text: str) -> str:
    pal = palette()
    return f"{pal.faint}{text}{pal.reset}"


def _error_line(text: str) -> str:
    pal = palette()
    return f" {pal.red}{GLYPH_ERROR}{pal.reset} {text}"


def _warn_line(text: str) -> str:
    pal = palette()
    return f" {pal.yellow}△{pal.reset} {text}"


_PLAN_BLOCKED_TOOLS = frozenset({"execute", "write_file", "edit_file", "apply_patch", "delete"})


def _approval_body(name: str, args: dict[str, Any]) -> str:
    """审批面板正文：命令、目标路径或补丁开头；其余工具列参数。"""
    if name == "execute":
        return "$ " + str(args.get("command") or "")
    if name == "apply_patch":
        lines = str(args.get("patchText") or "").splitlines()
        head = [ln for ln in lines if ln.startswith("*** ") and "Patch" not in ln]
        return "\n".join(head[:12] or lines[:12])
    if name in {"write_file", "edit_file", "delete"}:
        return str(args.get("file_path") or args.get("path") or "")
    return "\n".join(f"{k}={v!r}"[:200] for k, v in list(args.items())[:8])


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
    # 日志进文件：无处理器时 WARNING 以上会经 lastResort 写到 stderr，直接画进全屏界面
    from circle.log_setup import configure_file_logging

    configure_file_logging(home)
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
