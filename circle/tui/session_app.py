"""Circle session shell — IstInkApp session ring without compile/KMS.

Layout: transcript · ask panel · closed composer frame · footer.
The frame is one rounded loop. While busy, one rainbow runs around that
loop and through the status text on the top edge.
Streaming + exec approval via HarnessBridge.
"""

from __future__ import annotations

import difflib
import logging
import os
import re
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import ExecuteResponse
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from circle import __version__, secret_prompt, session_index, update
from circle.approvals import REJECTED_BY_USER, default_policy
from circle.checkpoint_store import make_checkpointer, make_store
from circle.compaction import CompactionProgress, CompactionWatcher, done_text
from circle.commands import (
    CustomCommand,
    discover_custom_commands,
    expand_command_template,
)
from circle.context_middleware import (
    append_messages,
    compact_prompt,
    inject_thread_message,
    plan_boundary_message,
    skill_boundary_message,
    thread_config,
)
from circle.extensions import CommandContext, ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.job_agents import ApprovalHost, is_true
from circle.jobs import (
    NOTICE_MARKER,
    JobRegistry,
    Owner,
    format_elapsed,
    install_exit_guard,
    notice_message,
    read_head,
)
from circle.ink.app import InkApp
from circle.ink.components.ask_user_panel import AskUserPanel
from circle.ink.components.ask_user_view import AskUserSession
from circle.ink.components.dialog_card import PopupItem, card_rows, popup_rows
from circle.ink.components.dialog_frame import build_loop_frame
from circle.ink.components.exec_approval_view import (
    ExecApprovalSession,
    SessionApprovalsSession,
)
from circle.ink.components.footer import FooterPane
from circle.ink.components.picker import Picker, PickerItem
from circle.ink.components.plan_panel import PlanPanel
from circle.ink.components.prompt_input import PromptInput
from circle.ink.components.transcript import Transcript
from circle.ink.components.welcome import WelcomeInfo, WelcomeItem, welcome_rows
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.escape_input import StandaloneEscapeInputParser as _StandaloneEscapeInputParser
from circle.ink.parse_keypress import (
    ColorReportEvent,
    ColorSchemeEvent,
    InputEvent,
    KeyPress,
    MouseEvent,
    PasteEvent,
)
from circle.ink.string_width import string_width
from circle.ink.theme import (
    GLYPH_ERROR,
    THEME_CHOICES,
    apply_theme,
    init_palette_from_terminal,
    normalize_theme,
    palette,
)
from circle.ink.theme_watch import ThemeWatcher
from circle.mcp_loader import format_mcp_status
from circle.mentions import attach_files, complete
from circle.middleware.cancellation import CancellationToken
from circle import model_catalog
from circle.model import (
    EFFORT_LEVELS,
    apply_context_window,
    build_chat_model,
    reasoning_effort_of,
)
from circle.model_guard import _chain, add_retry_listener
from circle.paths import circle_home, ensure_home, normalize_workspace
from circle.run_options import RunOptions
from circle.session_tree import SessionTree
from circle.settings import (
    CircleSettings,
    ModelAuth,
    apply_auth_to_environ,
    apply_project_settings,
    clear_credentials,
    is_folder_trusted,
    load_credentials,
    load_settings,
    save_credentials,
    save_settings,
    without_project_settings,
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
from circle.tui.conversation_tree import row_text
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.harness_bridge import NO_OUTPUT, HarnessBridge, StreamUpdate
from circle.tui.input_history import InputHistory
from circle.tui.job_rows import (
    JOB_ROWS,
    job_activity,
    job_log_rows,
    notice_rows,
    outcome_words,
    render_job_band,
    render_job_rows,
    strip_header,
)
from circle.tui.message_model import (
    MessageSnapshot,
    make_assistant_message,
    make_tool_result_block,
    make_tool_use_block,
)
from circle.tui.slash_commands import (
    BUILTIN_SLASH,
    help_text,
    hotkeys_text,
    command_word,
    known_slash_names,
    parse_slash,
)
from circle.tui.progress_handler import UsageOnlyHandler, extract_message_usage
from circle.tui.replay import draft_of, first_turns, is_user_message, saved_turns, write_history
from circle.tui.tool_display import approval_preview
from circle.tui.transcript_view import (
    ViewOptions,
    final_text,
    latest_todos,
    render_turn_rows,
    tool_type_bg_sgr,
    turn_had_output,
    user_rows,
)

logger = logging.getLogger(__name__)

# 契约 R3：你正在打字时，卡片等你停手这么久再接管框，免得一个字母答错问题。
_CARD_TYPING_IDLE_S = 1.0

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


@dataclass
class _SessionRecord:
    thread_id: str
    title: str
    lines: list[str] = field(default_factory=list)
    bgs: list[str | None] = field(default_factory=list)  # 每行的类型底色，与 lines 等长


def _format_llm_error(exc: BaseException) -> str:
    """Make gateway / Anthropic errors readable in the transcript."""
    msg = str(exc)
    # Anthropic-style: {'type': 'error', 'error': {'message': '...'}}
    if "Service temporarily unavailable" in msg or "did not respond" in msg:
        return (
            "The model gateway is unavailable (no response). "
            "Retry later, or check the base_url and the model name."
        )
    if "timeout" in msg.lower() or "timed out" in msg.lower():
        return f"Request timed out: {msg}"
    # Prefer nested message if present
    if "'message':" in msg:
        import re

        m = re.search(r"'message':\s*'([^']+)'", msg)
        if m:
            return m.group(1)
    return msg


def _refused_the_key(exc: BaseException) -> bool:
    """The endpoint turned the key down (401, 403): no key, a wrong one, no plan behind it."""
    return any(getattr(e, "status_code", None) in (401, 403) for e in _chain(exc))


def _endpoint_name(base_url: str) -> str:
    """``https://gateway.example/v1`` as ``gateway.example/v1``: short enough for a list."""
    return re.sub(r"^[a-z][a-z0-9+.-]*://", "", (base_url or "").strip(), flags=re.I).rstrip("/")


class _NotConnected:
    """The bridge before the session has connected: nothing runs, nothing to stop."""

    is_running = False
    auto_approve = False
    inbox = None

    def cancel(self) -> None:
        pass


class CircleSessionApp:
    """InfoTest-style session loop bound to Circle's harness."""

    # A session made without __init__ (tests) is a connected one with no gate and no welcome
    _gate: Any = None
    _connected = True
    _connecting = False
    _welcome_on = False
    _early_submits: list[str] = []

    def __init__(
        self,
        settings: CircleSettings,
        workspace: Path,
        *,
        home: Path | None = None,
        model_override: Any | None = None,
        resume: str | None = None,
        pick_session: bool = False,
        run_options: RunOptions | None = None,
        thread_id: str | None = None,
        fork: str | None = None,
        initial: list[tuple[str, str]] | None = None,
        connect: bool = True,
        setup: bool = False,
    ) -> None:
        """``connect=False``: draw the screen first and connect in :meth:`run`, after setup
        (when the settings are not ready, or ``setup``) and trust (when the folder is not
        trusted yet) have been answered in the frame."""
        self.settings = settings
        self._resume_at_start = resume
        self._pick_session_at_start = pick_session
        # From the command line: --tools, --system-prompt, --name, --no-session, --models …
        self._run_options = run_options or RunOptions()
        self._fork_at_start = fork
        # Messages given on the command line, as (text for the model, text shown)
        self._initial_messages = list(initial or [])
        self.workspace = normalize_workspace(workspace)
        self.home = home or circle_home()
        self._project_settings: dict[str, tuple[Any, Any]] = {}
        self._settings_problems: list[str] = []
        self._saved_model: str | None = None
        self._model_arg = model_override
        self.model_override = None if isinstance(model_override, str) else model_override
        self._connected = False
        self._connecting = False
        self._project_applied = False
        # Setup or trust, asked in the frame before the session connects
        self._gate: InitController | TrustController | None = None
        self._setup_first = setup
        self._early_submits: list[str] = []  # typed while connecting, sent once connected
        self._welcome_on = False
        self._welcome_items: list[Any] | None = None
        self._welcome_recent: tuple[list[tuple[str, str]], int] | None = None
        if connect:
            self._apply_project()
        init_palette_from_terminal(settings.theme)

        self._app = InkApp(alt_screen=True, mouse=True)
        self._app.color_scheme_reports = normalize_theme(settings.theme) == "auto"
        self._app.style_pool.set_selection_bg([palette().sel_bg])
        self._theme_watch = ThemeWatcher(
            write=self._app.write_passthrough,
            active=lambda: self._app.active,
            on_change=self._on_terminal_theme_change,
        )
        self._app._input_parser = _StandaloneEscapeInputParser(
            self._app._input_parser, self._handle_input)
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
        # 页眉（常驻）：版本 · 模型 · 目录，右侧唯一一处键位提示
        self._header = create_element(NodeType.BOX)
        self._header.style.height = 2
        self._header_text = create_text("")
        self._header.append_child(self._header_text)
        self._dialog_top_text = create_text("")
        self._dialog_left_text = create_text("│")
        self._dialog_right_text = create_text("│")
        self._dialog_bottom_text = create_text("")
        dialog_top = create_element(NodeType.BOX)
        dialog_top.style.height = 1
        dialog_top.append_child(self._dialog_top_text)
        # 卡片（审批 / 提问）的行放在上沿与输入行之间：还是同一个框，只是内容换了。
        self._dialog_body = create_element(NodeType.BOX)
        self._dialog_body.style.height = 0
        self._dialog_body_text = create_text("")
        self._dialog_body.append_child(self._dialog_body_text)
        dialog_mid = create_element(NodeType.BOX)
        dialog_mid.style.height = 1
        dialog_mid.style.flex_direction = "row"
        self._dialog_mid = dialog_mid
        self._prompt_shown = True
        dialog_left = create_element(NodeType.BOX)
        dialog_left.style.width = 1
        dialog_left.style.height = 1
        dialog_left.append_child(self._dialog_left_text)
        dialog_right = create_element(NodeType.BOX)
        dialog_right.style.width = 1
        dialog_right.style.height = 1
        dialog_right.append_child(self._dialog_right_text)
        # the side edges grow with the input rows
        self._dialog_sides = (dialog_left, dialog_right)
        dialog_bottom = create_element(NodeType.BOX)
        dialog_bottom.style.height = 1
        dialog_bottom.append_child(self._dialog_bottom_text)
        dialog_mid.append_child(dialog_left)
        dialog_mid.append_child(self._prompt.node)
        dialog_mid.append_child(dialog_right)
        self._dialog.append_child(dialog_top)
        self._dialog.append_child(self._dialog_body)
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
        self._ticked_at = 0.0
        # write_todos 的计划面板（对话框上方）
        self._plan_panel = PlanPanel()
        self._plan_width = 0
        self._composer_gap = create_element(NodeType.BOX)
        self._composer_gap.style.height = 0
        # What you typed while Circle works and it has not read yet, above the input box
        self._pending_box = create_element(NodeType.BOX)
        self._pending_box.style.height = 0
        self._pending_text = create_text("")
        self._pending_box.append_child(self._pending_text)
        # 本回合耗时：不含停下等用户审批/作答的时间
        self._turn_started_at = 0.0
        self._turn_elapsed = 0.0

        root = self._app.root
        root.append_child(self._header)
        root.append_child(self._transcript.node)
        root.append_child(self._agent_detail_band)
        root.append_child(self._agent_detail.node)
        root.append_child(self._composer_gap)
        root.append_child(self._plan_panel.node)
        root.append_child(self._pending_box)
        root.append_child(self._ask_panel.node)
        root.append_child(self._dialog)
        root.append_child(self._footer.node)
        root.append_child(self._agent_strip)

        self._app.on_input = self._handle_input

        self._is_loading = False
        self._thinking_expanded = False
        self._show_thinking = not settings.hide_thinking
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
        self._last_key_at = 0.0
        self._card_defer: object | None = None  # 等用户停手的那次延迟
        # A paused graph may have several interrupts, each with its own ordered
        # action_requests. Collect one reply per interrupt before resuming.
        self._interrupt_order: list[str | None] = []
        self._interrupt_replies: dict[str | None, dict[str, Any]] = {}
        self._approval_queue: list[tuple[str | None, dict[str, Any]]] = []
        self._approval_decisions: dict[str | None, list[dict[str, Any]]] = {}
        # 非审批形态的中断按 payload["kind"] 分派（C2 的问答面板挂在这里）
        self._interrupt_handlers: dict[str, Callable[[dict[str, Any]], None]] = {}
        # question 工具的普通题：ask_user 中断逐个问，答完一起 resume（多个并行时按中断 id）
        self._ask_session: AskUserSession | None = None
        self._ask_queue: list[tuple[str | None, dict[str, Any]]] = []
        self._ask_replies: list[tuple[str | None, dict[str, Any]]] = []
        # /approvals 管理页
        self._approvals_page: SessionApprovalsSession | None = None
        self._picker: Picker | None = None
        self._login: InitController | None = None  # /login while its lists are open
        # The list of /commands or @files under what is being typed, and the text it was
        # closed for with esc (it stays closed until the text changes)
        self._completion: dict[str, Any] | None = None
        # ctrl+f: what is being looked for in the conversation, and where
        self._find: dict[str, Any] | None = None
        # keybindings.json: pressed key → the key whose action it does
        from circle.keybindings import load_remap

        self._key_remap, self._keybinding_problems = load_remap(self.home)
        self._completion_dismissed: str | None = None
        self._skill_descriptions: dict[str, str] | None = None
        # /tree took the conversation back here; the next message branches from it
        self._leaf_checkpoint: str | None = None
        self._last_esc_at = 0.0
        self._model_list: list[str] | None = None  # what the endpoint offers, asked once
        self._ask_saved_prompt = ""
        self._ask_saved_pastes: dict[int, str] = {}
        self._draft_parked = False
        self._last_ctrl_c = 0.0
        self._requested_thread_id = thread_id
        self._thread_id = thread_id or f"circle-{uuid.uuid4().hex[:8]}"
        ensure_home(self.home)
        # --no-session: the conversation lives in memory and is not listed
        self._checkpointer = (MemorySaver() if self._run_options.no_session
                              else make_checkpointer(self.home))
        self._store = make_store()
        self._archive: list[_SessionRecord] = []
        self._previous_thread_id: str | None = None
        self._session_title = self._run_options.session_name or "new"
        self._undo_stack: list[_SessionRecord] = []
        self._redo_stack: list[_SessionRecord] = []
        self._share_path: Path | None = None
        self._last_assistant_plain = ""
        self._plan_mode = False
        self._session_tree = SessionTree()
        self._msg_queue: list[tuple[str, str]] = []  # (steering|followup, text)
        # The compaction under way (automatic or /compact): its row sits above the input box
        self._compaction: CompactionProgress | None = None
        # A compaction's closing lines while a turn draws (see _compaction_note)
        self._held_notes: list[tuple[str, str]] = []
        self._shell_stop: CancellationToken | None = None  # a running !command
        # Background jobs of this session; they outlive turns and agent rebuilds
        self._jobs = JobRegistry()
        self._jobs_hold = False  # after esc a finished job starts no turn until you send one
        self._notice_streak = 0  # turns started by job notices in a row
        # !command jobs: job id → (command, quiet, thread); their output is shared at the end
        self._user_jobs: dict[str, tuple[str, bool, str]] = {}
        self._shell_shares: list[tuple[str, str, Any]] = []  # (thread, command, result)
        self._job_ticker: threading.Thread | None = None
        self._jobs_picker: tuple[Picker, Callable[[], list[PickerItem]]] | None = None
        # Background agents waiting for an answer, one card at a time after the turn's own
        self._job_rounds: list[_JobRound] = []
        self._job_card: _JobRound | None = None
        # Backends of earlier builds: background agents started then still use theirs
        self._earlier_backends: list[Any] = []
        self._job_draft_parked = False
        self._jobs.subscribe(self._on_job_event)
        # a sent message → (how it is shown, the pastes it names), when that differs
        self._shown_as: dict[str, tuple[str, dict[int, str]]] = {}
        self._custom_commands: dict[str, CustomCommand] = {}
        self._mcp_tools: list[Any] = []
        # Nothing is loaded before the session connects: no extension runs in a folder you
        # have not trusted yet
        self._extensions = ExtensionHost(home=self.home, workspace=self.workspace, trusted=False)
        # 机密输入模式（question 工具 secret 类型）：buffer 只存在内存，
        # 输入行只渲染掩码；值经 secret_prompt 直写目标文件，不进对话。
        self._secret_entry: dict[str, Any] | None = None
        self._secret_hint_shown = False
        self._secret_last_check = 0.0

        self._approvals = default_policy(self.home, settings.credential_files or None)
        self._chat_model: Any = None
        self._agent: Any = None
        self._bridge: Any = _NotConnected()
        if connect:
            self._connect()

    def _apply_project(self) -> None:
        """The project's .circle/settings.json over yours, in memory only. ``circle --model``
        (or the project's model): this run uses it, settings.json keeps the saved one."""
        if self._project_applied:
            return
        self._project_applied = True
        settings = self.settings
        self._project_settings, self._settings_problems = apply_project_settings(settings, self.workspace)
        self._saved_model = (self._project_settings["model"][0]
                             if "model" in self._project_settings else None)
        model_override = self._model_arg
        if isinstance(model_override, str) and model_override:
            if self._saved_model is None:
                self._saved_model = settings.auth.model
            settings.auth.model = model_override
            model_override = None
        self.model_override = model_override

    def _connect(self) -> None:
        """Load what the folder and your settings bring and build the agent. In a full-screen
        run this happens after setup and trust, with the welcome's lamps blinking."""
        first = not self._project_applied
        self._apply_project()
        settings = self.settings
        if first and "theme" in self._project_settings:
            self._apply_theme()
        apply_auth_to_environ(settings, self.home)
        self._custom_commands = {
            c.name: c
            for c in discover_custom_commands(self.workspace, self.home)
        }
        self._extensions = self._load_extensions()
        self._approvals = default_policy(self.home, settings.credential_files or None)
        model = build_chat_model(
            settings, home=self.home, model_override=self.model_override
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
            run_options=self._run_options,
            jobs=self._jobs,
        )
        self._mcp_tools = list(getattr(self._agent, "_circle_mcp_tools", []) or [])
        self._host_background_agents()
        self._bridge = self._make_bridge()
        self._footer.update(model=settings.auth.model, status="ready")
        self._connected = True

    def _save_settings(self, *changed: str) -> None:
        """Save your settings after you changed ``changed``: what you chose now is yours,
        even where the project's settings had set it for this folder."""
        for key in changed:
            getattr(self, "_project_settings", {}).pop(key, None)
        save_settings(self._settings_to_save(), self.home)

    def _settings_to_save(self) -> CircleSettings:
        """The settings as they belong in settings.json: without a ``--model`` override,
        and without what the project's own settings put over yours."""
        base = self.settings
        if self._saved_model is not None:
            base = replace(self.settings, auth=replace(self.settings.auth, model=self._saved_model))
        return without_project_settings(base, getattr(self, "_project_settings", {}))

    def _rebuild_agent(self, *, model: Any | None = None) -> None:
        """Rebuild harness with current settings / plan mode."""
        if self._bridge.is_running or self._is_loading:
            raise RuntimeError("A turn is still running; the agent cannot be rebuilt")
        earlier = getattr(self._agent, "_circle_backend", None)
        if earlier is not None and self._jobs.live("agent"):
            self._earlier_backends.append(earlier)
        chat = model or build_chat_model(
            self.settings, home=self.home, model_override=self.model_override
        )
        self._custom_commands = {
            c.name: c
            for c in discover_custom_commands(self.workspace, self.home)
        }
        self._skill_descriptions = None  # read again for the completion list
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
            run_options=self._run_options,
            jobs=self._jobs,
        )
        self._sync_model_meter()
        self._mcp_tools = list(getattr(self._agent, "_circle_mcp_tools", []) or [])
        self._host_background_agents()
        self._bridge = self._make_bridge()
        backend = getattr(self._agent, "_circle_backend", None)
        if backend is not None and hasattr(backend, "set_plan_mode"):
            backend.set_plan_mode(self._plan_mode)
        # A background agent keeps its build; read-only reaches it all the same
        if not self._jobs.live("agent"):
            self._earlier_backends = []
        for old in self._earlier_backends:
            if hasattr(old, "set_plan_mode"):
                old.set_plan_mode(self._plan_mode)

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
        # A different graph/thread has no known latest model request yet.
        self._footer.update(context_input_tokens=None)
        bridge = HarnessBridge(
            agent=self._agent,
            thread_id=self._thread_id,
            on_update=self._on_stream_update,
            on_interrupt=self._on_interrupt,
            on_done=self._on_done,
            on_error=self._on_error,
            on_status=self._on_status,
            on_snapshot=self._on_snapshot,
            snapshot_lock=self._app.lock,
            on_compaction=self._on_compaction,
        )
        bridge.auto_approve = self._approvals.yolo_enabled(self._thread_id)
        self._footer.set_yolo(bridge.auto_approve)
        return bridge

    def run(self) -> int:
        self._app.start()
        # Closing the terminal or a kill stops background jobs too
        remove_exit_guard = install_exit_guard(self._jobs)
        self._theme_watch.start(self.settings.theme)
        remove_listener = add_retry_listener(self._on_model_retry)
        code = 0
        stopped = 0
        try:
            self._welcome_on = True
            if not self._connected:
                self._refresh_welcome_data()
                self._start_ticker()
                gate_code = self._run_gate()
                if gate_code is not None:
                    return gate_code
                self._connect_now()
                if not self._app._running:  # left (ctrl+c) while it connected
                    return code
            self._show_welcome()
            for problem in [*self._keybinding_problems, *self._settings_problems]:
                self._fail(problem)
            self._start_update_check()
            # models.dev once a day, in the background: windows and prices of new models
            model_catalog.refresh_in_background(self.home, on_refreshed=self._on_models_refreshed)
            if self._resume_at_start:
                self._open_saved(self._resume_at_start)
            elif self._fork_at_start:
                found = session_index.find(self.home, self._fork_at_start)
                if found is not None:
                    # --session-id with --fork names the new conversation
                    self._fork_from_elsewhere(found, into=self._requested_thread_id)
            elif self._pick_session_at_start:
                self._open_session_picker()
            self._send_initial_messages()
            while self._app._running:
                self._maybe_update_secret_hint()
                self._maybe_wake_for_jobs()
                time.sleep(0.05)
        except KeyboardInterrupt:
            pass
        finally:
            try:
                self._footer.shutdown()
            except Exception:
                logger.debug("footer shutdown failed", exc_info=True)
            remove_listener()
            self._theme_watch.stop()
            self._bridge.cancel()
            stopped = self._stop_jobs_at_exit()
            self._app.stop()
            remove_exit_guard()
        if stopped:
            print(f"{stopped} background job{'s' if stopped != 1 else ''} stopped", flush=True)
        hint = self._resume_hint() if self._connected else ""
        if hint:
            print(hint, flush=True)
        return code

    # ── setup and trust, asked in the frame before the session connects ────

    def _run_gate(self) -> int | None:
        """Setup (when the settings are not ready, or ``circle --init``) and then trust (when
        the folder is not trusted yet), each a card in the frame. None once both are answered;
        otherwise the exit code: 1 when trust was declined, 0 when you left with esc or ctrl+c."""
        self._begin_gate()
        self._app.render()
        while self._app._running and self._gate is not None:
            time.sleep(0.05)
        if self._gate is not None or not self._app._running:
            return self._gate_exit
        return None

    def _begin_gate(self) -> None:
        """The first question: setup, or trust when Circle is set up already."""
        self._gate_exit = 0
        with self._app.lock:
            if self._setup_first or not self.settings.is_ready():
                self._gate = InitController(home=self.home, probe=self._probe_endpoint, defer_probe=True)
            elif not is_folder_trusted(self.settings, self.workspace):
                self._gate = TrustController(self.settings, self.workspace, home=self.home)
            self._sync_gate()

    def _advance_gate(self) -> None:
        """After an answer: the next step, the next gate, or the end of the gates."""
        gate = self._gate
        if isinstance(gate, InitController):
            if gate.step == InitStep.PROBING and getattr(self, "_probing", None) is not gate:
                self._probing = gate
                threading.Thread(target=self._gate_probe, args=(gate,), name="circle-setup-probe",
                                 daemon=True).start()
            if gate.done and gate.settings is not None:
                self.settings = gate.settings
                if is_folder_trusted(self.settings, self.workspace):
                    self._gate = None
                else:
                    self._gate = TrustController(self.settings, self.workspace, home=self.home)
        elif isinstance(gate, TrustController) and gate.finished:
            if not gate.accepted:
                self._gate_exit = 1
                self._app._running = False  # leave without a session
                return
            assert gate.result is not None
            self.settings = gate.result
            self._gate = None
        self._sync_gate()

    def _gate_probe(self, gate: InitController) -> None:
        """Ask the endpoint for its models off the input thread; the card says so meanwhile."""
        probed = gate.probe(gate.base_url, gate.api_key)
        with self._app.lock:
            if self._gate is gate and gate.step == InitStep.PROBING:
                gate.apply_probe(probed)
                self._sync_gate()
        self._app.render()

    def _sync_gate(self) -> None:
        """The input row as the gate's step wants it: masked for the key, its placeholder,
        emptied when the step changes."""
        gate = self._gate
        step = gate.step if isinstance(gate, InitController) else ("trust" if gate is not None else None)
        if step != getattr(self, "_gate_step", None):
            self._gate_step = step
            self._prompt.clear()
        if isinstance(gate, InitController):
            self._prompt.masked = gate.step == InitStep.API_KEY
            self._prompt.placeholder = gate.placeholder()
        else:
            self._prompt.masked = False
            self._prompt.placeholder = ""

    def _handle_gate_key(self, kp: KeyPress) -> None:
        gate = self._gate
        key, char = kp.key, kp.char if len(kp.char or "") == 1 else ""
        if key in ("escape", "ctrl+c", "ctrl+d"):
            self._gate_exit = 0
            self._app._running = False  # esc leaves setup, as ctrl+c does
            return
        if isinstance(gate, TrustController):
            if key in ("up", "down"):
                gate.move(-1 if key == "up" else 1)
            elif key in ("enter", "return"):
                gate.confirm()
            elif char.lower() in ("y", "1"):
                gate.submit_line("y")
            elif char.lower() in ("n", "2"):
                gate.submit_line("n")
        elif isinstance(gate, InitController):
            step = gate.step
            if step in (InitStep.AUTH_MODE, InitStep.OAUTH_PROVIDER, InitStep.MANUAL_PROTOCOL):
                if key in ("up", "down"):
                    gate.move(-1 if key == "up" else 1)
                elif key in ("enter", "return"):
                    gate.confirm()
                elif char in ("1", "2"):
                    gate.submit_line(char)
            elif step == InitStep.PICK_MODEL:
                if key in ("up", "down"):
                    gate.move_choice(-1 if key == "up" else 1)
                elif key in ("enter", "return"):
                    gate.set_query(self._prompt.value)
                    gate.pick_choice()
                elif self._prompt.handle_key(key if key else "char", char):
                    gate.set_query(self._prompt.value)
            elif step in (InitStep.API_URL, InitStep.API_KEY):
                if key in ("enter", "return"):
                    text = self._prompt.value
                    self._prompt.clear()
                    gate.submit_line(text)
                else:
                    self._prompt.handle_key(key if key else "char", char)
            # looking for models or waiting for a browser: nothing to answer yet
        self._advance_gate()
        self._app.render()

    def _handle_connecting_key(self, kp: KeyPress) -> None:
        """While the session connects: you may type, and what you send waits for it."""
        if kp.key in ("ctrl+c", "ctrl+d"):
            self._app._running = False
            return
        if kp.key in ("enter", "return"):
            text = self._prompt.value
            if text.strip():
                self._prompt.clear()
                self._early_submits.append(text)
                self._flash(f"Queued · {len(self._early_submits)}")
            return
        if self._prompt.handle_key(kp.key if kp.key else "char", kp.char if len(kp.char or "") == 1 else ""):
            self._app.render()

    def _start_ticker(self) -> None:
        """Repaint a few times a second until the session has connected: the lamps blink."""
        def tick() -> None:
            while self._app._running and not (self._connected and not self._connecting):
                self._app.render()
                time.sleep(0.2)
            self._app.render()

        threading.Thread(target=tick, name="circle-welcome-ticker", daemon=True).start()

    def _connect_now(self) -> None:
        """Connect with the screen up: the folder's rows blink while it loads."""
        self._connecting = True
        try:
            self._connect()
        finally:
            self._connecting = False
        with self._app.lock:
            self._refresh_welcome_data()
            waiting, self._early_submits = self._early_submits, []
            for text in waiting:
                self._on_submit(text)
        self._app.render()

    # ── the welcome block ───────────────────────────────────────────────

    def _refresh_welcome_data(self) -> None:
        """What the welcome lists: the folder's own things and its recent sessions. Looked up
        here, not on every frame."""
        from circle.trust import folder_inventory

        try:
            self._welcome_items = folder_inventory(self.workspace, self.home)
        except OSError:
            self._welcome_items = []
        try:
            saved = [item for item in session_index.for_workspace(self.home, self.workspace, limit=200)
                     if item.thread_id != self._thread_id]
        except Exception:  # noqa: BLE001 - the welcome works without the list
            logger.debug("session index unavailable", exc_info=True)
            saved = []
        shown = [(item.title or "(untitled)", session_index.age(item.updated)) for item in saved[:3]]
        self._welcome_recent = (shown, max(0, len(saved) - 3))

    def _welcome_info(self) -> WelcomeInfo:
        from urllib.parse import urlparse

        settings = self.settings
        auth = settings.auth
        setting_up = isinstance(self._gate, InitController)
        model = "" if setting_up or not settings.is_ready() else auth.model
        depth = reasoning_effort_of(self._chat_model) if self._chat_model is not None else ""
        if model and depth and depth in EFFORT_LEVELS:
            model = f"{model} • {depth}"
        if auth.mode == "oauth":
            endpoint = auth.oauth_provider
        else:
            endpoint = urlparse(auth.base_url or "").hostname or _endpoint_name(auth.base_url)
        path = str(self.workspace)
        home = str(Path.home())
        if path == home or path.startswith(home + os.sep):
            path = "~" + path[len(home):]
        # unlit until trusted, blinking while it loads, then lit (the session only connects
        # in a folder that is trusted)
        if self._gate is not None:
            state = "none"
        elif self._connecting or not self._connected:
            state = "running"
        else:
            state = "ok"
        failed = [f"{ext.name}: {ext.error}" for ext in getattr(self._extensions, "extensions", [])
                  if ext.source == "project" and ext.error]
        items = []
        for found in self._welcome_items or []:
            if found.kind == "instructions":
                text = ", ".join(found.names)
            elif found.kind == "settings":
                text = found.where
            else:
                text = f"{found.count} in {found.where}"
            bad = state == "ok" and found.kind == "extensions" and bool(failed)
            items.append(WelcomeItem(found.kind, text, "error" if bad else state, failed if bad else []))
        recent, more = self._welcome_recent or ([], 0)
        return WelcomeInfo(version=__version__, model=model, endpoint=endpoint if model else "",
                           folder=path, branch=self._branch(), items=items, recent=list(recent), more=more)

    def _sync_welcome(self, width: int) -> None:
        if not self._welcome_on:
            return
        self._transcript.set_head(welcome_rows(self._welcome_info(), width))

    def _resume_hint(self) -> str:
        """After the screen is gone: the command that opens this conversation again."""
        if self._run_options.no_session:
            return ""
        try:
            saved = session_index.find(self.home, self._thread_id)
        except Exception:  # noqa: BLE001 - only a hint
            return ""
        if saved is None or saved.thread_id != self._thread_id:
            return ""
        command = f"circle --session {self._thread_id}"
        try:
            here = Path.cwd().resolve()
        except OSError:
            here = None
        if here != self.workspace:
            command += " " + _shell_word(str(self.workspace))
        return f"To resume this session: {command}"

    def _send_initial_messages(self) -> None:
        """``circle "message" @file``: the first message is sent at once, the others
        follow it, one turn each."""
        if not self._initial_messages:
            return
        messages, self._initial_messages = self._initial_messages, []
        with self._app.lock:
            for full, shown in messages:
                if full != shown:
                    self._shown_as[full] = (shown, {})
                self._input_history.add(shown)
            first, *rest = messages
            self._msg_queue.extend(("followup", full) for full, _shown in rest)
            self._start_user_turn(first[0])

    def _on_model_retry(self, event: dict[str, Any]) -> None:
        """模型层重试与参数降级如实上屏：用户能看到在等什么、丢了什么。"""
        kinds = {"rate_limit": "Endpoint rate-limited", "server": "Endpoint error",
                 "network": "Network interrupted", "inband": "Stream error"}
        with self._app.lock:
            if event.get("event") == "retry":
                self._flash(f"{kinds.get(str(event.get('kind')), 'Request failed')} · retrying in "
                            f"{event.get('wait_s')}s · {event.get('attempt')}/{event.get('max')}", 6.0)
            elif event.get("event") == "param_dropped":
                self._toast(f"The endpoint rejects {event.get('param')} · not sent for the rest of this session")
            elif event.get("event") == "output_budget_exhausted":
                self._fail("The model spent its whole output budget thinking · no answer this turn")

    def _show_welcome(self) -> None:
        """Session start. The welcome block (the logo, version · model · folder, what the folder
        brings, its recent sessions) is the first thing in the transcript; it is drawn on every
        frame, never stored, and the header takes the identity over once it scrolls away."""
        self._refresh_welcome_data()
        self._footer.update(status="ready")
        self._app.render()
        self._extensions.emit("session_start", {"workspace": str(self.workspace)})

    def _start_update_check(self) -> None:
        """Once a day, ask whether a newer release exists. If so, one faint line stays in the
        transcript (契约 R6: a state that is worth coming back to). Runs off the UI thread; a
        network that does not answer costs nothing."""
        if not update.check_enabled(self.settings):
            return

        def _work() -> None:
            try:
                latest = update.available_update(self.home)
                if latest:
                    with self._app.lock:
                        self._toast(update.notice_text(latest))
            except Exception:  # noqa: BLE001 — a reminder must never hurt the session
                logger.debug("update check failed", exc_info=True)

        threading.Thread(target=_work, name="circle-update-check", daemon=True).start()

    def _update_thinking_line(self, text: str | None) -> None:
        """Store the status that the closed frame embeds in its top edge."""
        label = text or ""
        if label and not self._dialog_label:
            self._dialog_phase_origin = time.monotonic()
        if not label:
            self._dialog_phase_origin = 0.0
        self._dialog_label = label

    def _active_card(self):
        """The blocking question that owns the frame right now, or None."""
        gate = self._gate
        if gate is not None:
            return gate.card_spec()
        approval, ask = self._exec_approval, self._ask_session  # one read each: other threads clear them
        if approval is not None:
            return approval.card_spec()
        if ask is not None:
            return ask.card_spec()
        return None

    def _mode_word(self) -> tuple[str, str]:
        """The one-word mode at the frame's bottom-right. The default — approving each call
        by hand — shows nothing. ``read-only`` (plan mode) wins over ``auto`` (yolo)."""
        pal = palette()
        if self._gate is not None:
            return "", ""
        if self._plan_mode:
            return "read-only", pal.green
        if self._approvals.yolo_enabled(self._thread_id):
            return "auto", pal.yellow
        return "", ""

    def _branch(self) -> str:
        """The git branch, read again at most every two seconds."""
        now = time.monotonic()
        cached = getattr(self, "_branch_cache", None)
        if cached is None or now - cached[0] > 2.0:
            from circle.git_info import current_branch

            cached = (now, current_branch(self.workspace))
            self._branch_cache = cached
        return cached[1]

    def _sync_title(self) -> None:
        """The terminal window's title, as pi sets it: ``circle - <title> - <folder>``."""
        title = self._session_title if self._session_title not in ("", "new") else ""
        text = " - ".join(part for part in ("circle", title[:40], self.workspace.name) if part)
        if text != getattr(self, "_terminal_title", None):
            self._terminal_title = text
            setter = getattr(self._app, "set_title", None)
            if callable(setter):
                setter(text)

    def _sync_header(self, width: int) -> None:
        """One row: ``circle <version> · <model> · <directory> (<branch>)`` and, when it
        fits, the one key hint on the right. What gives way first: the hint, then the
        directory (cut from the left, the tail is what identifies it), then the model name."""
        pal = palette()
        self._sync_title()
        if self._gate is not None:
            self._header_text.set_value("\n")  # setup and trust: the welcome says who and where
            return
        model = self.settings.auth.model
        depth = reasoning_effort_of(getattr(self, "_chat_model", None))
        if depth and depth in EFFORT_LEVELS:
            model = f"{model} • {depth}"
        head = f" circle {__version__} · "
        path = str(self.workspace)
        home = str(Path.home())
        if path == home or path.startswith(home + os.sep):
            path = "~" + path[len(home):]
        branch = self._branch()
        if branch:
            path = f"{path} ({branch})"
        hint = "? for shortcuts"
        room = width - 1
        show_hint = (self._connected and width >= 60
                     and string_width(head + model) + 12 + string_width(hint) + 2 <= width)
        if show_hint:
            room -= string_width(hint) + 2
        left_room = room - string_width(head)
        if left_room < 1:  # not even the identity fits: cut what there is
            text = _cut_end(f"{head}{model}", max(1, room))
            path = ""
        else:
            sep = " · "
            model_shown = _cut_end(model, left_room)
            path_room = left_room - string_width(model_shown) - string_width(sep)
            if path_room >= 4:
                path = _cut_start(path, path_room)
                text = f"{head}{model_shown}{sep}{path}"
            else:
                text = f"{head}{model_shown}"
        if self._welcome_on and self._transcript.head_in_view():
            text = ""  # the welcome block on screen already says who and where
        gap = max(1, width - string_width(text) - string_width(hint) - 1) if show_hint else 0
        right = f"{' ' * gap}{pal.faint}{hint}{pal.reset} " if show_hint else ""
        self._header_text.set_value(f"{pal.dim}{text}{pal.reset}{right}\n")

    def _sync_dialog_frame(self) -> None:
        width = self._app.width
        if width < 8:
            return
        pal = palette()
        self._sync_welcome(width)
        self._sync_header(width)
        self._set_view_visible(self._footer.node, self._connected)  # no meters before a session
        card = self._active_card()
        mode, mode_sgr = self._mode_word()
        rows: list[str] = []
        if card is not None:
            # 轮到你：框停转、边框黄色静止、忙碌词撤下（setup 查模型时没什么要你做，框是淡色）
            top, left, right, bottom = build_loop_frame(
                width, elapsed=None, label="", bottom_label=self._footer.obs_warning,
                mode=mode, mode_sgr=mode_sgr, border=pal.faint if card.lamp == "running" else pal.yellow)
            # 屏矮时只裁正文（写明裁了几行），标题和选项永远在：框里 overflow 会把底部选项裁掉。
            strip_h = int(self._agent_strip.style.height or 0)
            room = max(6, (self._app.height or 24) - 2 - 2 - 1 - 1 - strip_h - int(card.input_row) - 1)
            rows = [f"{left}{row}{right}" for row in card_rows(card, width - 2, max_rows=room)]
            show_prompt = bool(card.input_row)
        else:
            elapsed = None
            if self._dialog_label:
                elapsed = time.monotonic() - self._dialog_phase_origin
            top, left, right, bottom = build_loop_frame(
                width, elapsed=elapsed, label=self._dialog_label,
                bottom_label=self._footer.obs_warning, mode=mode, mode_sgr=mode_sgr)
            show_prompt = True
        # The input box grows with the draft, up to 30% of the screen (at least 5 rows)
        self._prompt.max_rows = max(5, int((self._app.height or 24) * 0.3))
        self._prompt.set_width(width - 2)
        prompt_rows = max(1, self._prompt.rows_shown) if show_prompt else 0
        self._dialog_top_text.set_value(top)
        self._dialog_left_text.set_value("\n".join([left] * max(1, prompt_rows)))
        self._dialog_right_text.set_value("\n".join([right] * max(1, prompt_rows)))
        self._dialog_bottom_text.set_value(bottom)
        self._dialog_body_text.set_value("\n".join(rows))
        self._dialog_body.style.height = len(rows)
        self._set_view_visible(self._dialog_mid, show_prompt)
        if show_prompt:
            self._dialog_mid.style.height = prompt_rows
            for side in getattr(self, "_dialog_sides", ()):
                side.style.height = prompt_rows
        self._dialog.style.height = 2 + len(rows) + prompt_rows
        if show_prompt != self._prompt_shown:
            self._prompt_shown = show_prompt
            if show_prompt:
                self._prompt._refresh()  # 光标回到输入行
        if not show_prompt:
            # every frame, not only on the change: clearing the parked draft re-declares the cursor
            self._app.cursor.clear(self._prompt.node)
        self._plan_panel.set_suppressed(card is not None)
        if card is not None and getattr(self, "_completion", None) is not None:
            self._completion = None  # the card takes the frame; the list goes with the draft
            self._ask_panel.clear()
        self._plan_panel.tick()
        self._tick_agents()
        self._render_agent_detail()
        self._sync_agent_strip()
        self._sync_plan_panel()
        self._sync_pending(width)
        active_view = self._agent_detail if self._detail_active else self._transcript
        self._composer_gap.style.height = int(active_view.message_count() > 0)

    def _sync_pending(self, width: int) -> None:
        """Above the input box: the compaction under way, then one faint row per message
        waiting: ``steering:`` for the running turn's next step, ``follow-up:`` for after it."""
        box = getattr(self, "_pending_box", None)
        if box is None:
            return
        progress = getattr(self, "_compaction", None)
        head = [self._compaction_row(progress, width)] if progress is not None else []
        inbox = getattr(getattr(self, "_bridge", None), "inbox", None)
        rows = [("steering", shown) for shown in (inbox.waiting() if inbox is not None else [])]
        shown_as = getattr(self, "_shown_as", {})
        rows += [("follow-up", shown_as.get(full, (full, {}))[0])
                 for _kind, full in getattr(self, "_msg_queue", [])]
        lines = head + [" " + _faint(_cut_end(f"{label}: {' '.join(text.split())}", max(8, width - 2)))
                        for label, text in rows]
        self._pending_text.set_value("\n".join(lines))
        box.style.height = len(lines)

    # ── compaction ─────────────────────────────────────────────────────

    _BAR_CELLS = 16

    def _compaction_row(self, progress: CompactionProgress, width: int) -> str:
        """``auto-compacting · ████░░░░ summarizing · 12s``: a status row (契约 R6: what is
        under way stays resident and goes when it is done). Drops the stage and the clock
        before the bar when the screen is narrow."""
        pal = palette()
        fraction = progress.fraction()
        filled = round(fraction * self._BAR_CELLS)
        if fraction < 1.0:
            filled = min(filled, self._BAR_CELLS - 1)  # full only once the summary is in
        bar = f"{pal.text}{'█' * filled}{pal.faint}{'░' * (self._BAR_CELLS - filled)}"
        head = f"{progress.label} · "
        tail = f" {progress.stage} · {progress.elapsed():.0f}s"
        room = max(8, width - 2)
        if string_width(head) + self._BAR_CELLS + string_width(tail) > room:
            tail = ""
        if string_width(head) + self._BAR_CELLS > room:
            return " " + _faint(_cut_end(head + tail, room))
        return f" {pal.faint}{head}{bar}{pal.reset}{pal.faint}{tail}{pal.reset}"

    def _on_compaction(self, event: dict[str, Any]) -> None:
        """A compaction step, from a run's callbacks (a worker thread): the row follows it,
        and the end leaves one line in the transcript — faint when done, ✖ when it failed —
        under the turn's usage line when a turn is drawing."""
        phase = str(event.get("phase") or "")
        with self._app.lock:
            progress = self._compaction
            if phase == "start" and (progress is None or progress.trigger in ("", "tool")):
                progress = progress or CompactionProgress()
                self._compaction = progress
            if progress is None:
                return
            progress.apply(event)
            if phase == "done":
                self._compaction = None
                self._footer.update(context_input_tokens=None)
                self._compaction_note("toast", done_text(event, automatic=progress.automatic))
                return
            if phase == "failed":
                self._compaction = None
                self._compaction_note(
                    "fail", f"Compaction failed: {event.get('error') or 'unknown error'}")
                return
        self._app.render()

    def _compaction_note(self, kind: str, text: str) -> None:
        """The closing line. A turn on screen is redrawn in place until it ends, so a line
        added now would come between its answer and its usage line: it waits for the end
        (``_leave_busy``)."""
        if self._turn_base >= 0 and self._is_loading and getattr(self._bridge, "is_running", False):
            self._held_notes.append((kind, text))
            self._app.render()
        elif kind == "fail":
            self._fail(text)
        else:
            self._toast(text)

    def _flush_held_notes(self) -> None:
        held = getattr(self, "_held_notes", None)
        if not held:
            return
        self._held_notes = []
        for kind, text in held:
            self._notice([_error_line(text) if kind == "fail" else f" {_faint(text)}"])

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
        jobs_obj = getattr(self, "_jobs", None)
        jobs = jobs_obj.live() if jobs_obj is not None else []
        if not visible and not jobs:
            strip.style.height = 0
            text.set_value("")
            return
        width = max(20, self._app.width or 80)
        header = strip_header(len(cards), len(jobs), width)
        if visible:
            hover = self._strip_hover if self._strip_hover in self._strip_visible_ids else None
            lines = render_agent_strip(visible, width=width, selected=selected, hover=hover,
                                       total=len(cards), hidden=len(cards) - len(visible),
                                       header=header)
        else:
            lines = [header]
        # Background jobs under the subagents: they stay while they run, turn or no turn
        shown = jobs[:JOB_ROWS]
        lines += render_job_rows(shown, width=width,
                                 activity={job.id: job_activity(job) for job in shown},
                                 hidden=len(jobs) - len(shown))
        strip.style.height = len(lines)
        text.set_value("\n".join(lines))

    def _strip_row_at(self, row: int) -> str | None:
        """The card of the strip row under the mouse (rule and header come first)."""
        if not self._strip_visible_ids:
            return None
        at = int(row) - int(getattr(self._agent_strip.rect, "y", 0)) - 1
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
        if str(self._detail_uuid or "").startswith("job:"):
            self._render_job_page()
            return
        card = self._find_card(self._detail_uuid)
        width = max(20, self._app.width or 80)
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
            view.append_message(" " + _faint("This subagent's record is no longer available."))
            return
        ids = self._detail_ids
        band, self._detail_buttons = render_detail_band(
            card, index=ids.index(self._detail_uuid) + 1, total=len(ids), width=width,
            hover=self._detail_hover)
        self._agent_detail_band.style.height = len(band)
        self._agent_detail_band_text.set_value("\n".join(band))
        rows = render_detail_rows(card, expanded=self._thinking_expanded, width=width)
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
        if isinstance(event, (ColorReportEvent, ColorSchemeEvent)):
            self._theme_watch.handle(event)
            return
        if isinstance(event, PasteEvent) and (self._gate is not None or not self._connected):
            gate = self._gate
            if gate is None or (isinstance(gate, InitController) and gate.input_step()):
                self._prompt.handle_paste(event.text)  # a key or a URL, pasted
                if isinstance(gate, InitController) and gate.step == InitStep.PICK_MODEL:
                    gate.set_query(self._prompt.value)
                self._app.render()
            return
        if isinstance(event, PasteEvent):
            if self._input_history.in_search_mode:
                return
            card = self._active_card()
            if card is not None and not card.input_row:
                return  # the prompt row is hidden behind the card: a paste has nowhere to go
            if self._picker is not None:
                # where typing goes: the search, or the line it asks for (a key, as dots)
                self._picker.handle_paste(event.text)
                return
            self._prompt.handle_paste(event.text)
            self._update_completion()
            self._app.render()
            return
        if isinstance(event, MouseEvent):
            self._handle_mouse(event)
            return
        if not isinstance(event, KeyPress):
            return
        target = getattr(self, "_key_remap", {}).get(event.key)
        if target:
            # keybindings.json: this key does the action of another
            event = KeyPress(key=target, char=target[-1] if target.startswith("ctrl+") else "",
                             ctrl=target.startswith("ctrl+"), alt=target.startswith("alt+"),
                             shift=target.startswith("shift+"))
        self._handle_key(event)

    def _handle_key(self, kp: KeyPress) -> None:
        self._last_key_at = time.monotonic()
        if self._gate is not None:
            with self._app.lock:  # the ticker repaints the card meanwhile: one answer at a time
                self._handle_gate_key(kp)
            return
        if not self._connected:
            self._handle_connecting_key(kp)
            return
        # InfoTest ist_app._handle_key — same session-ring order.
        if self._exec_approval is not None and self._handle_exec_approval_key(kp):
            return

        if self._ask_session is not None and self._handle_ask_key(kp):
            return

        if self._approvals_page is not None and self._approvals_page.handle_key(kp.key, kp.char):
            return

        picker = getattr(self, "_picker", None)
        if picker is not None and picker.handle_key(kp.key, kp.char):
            return

        if getattr(self, "_find", None) is not None and self._handle_find_key(kp):
            return

        if self._input_history.in_search_mode and self._handle_search_key(kp):
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

        typed = getattr(getattr(self, "_prompt", None), "value", "")
        if kp.key == "ctrl+c" and typed and not self._is_loading:
            # As in pi: the first ctrl+c clears what you typed, the next ones exit
            self._input_history.add(self._prompt.value)
            self._prompt.clear()
            self._last_ctrl_c = 0.0
            self._update_completion()
            self._app.render()
            return

        if kp.key == "ctrl+c":
            now = time.time()
            if self._is_loading:
                with self._app.lock:
                    self._stop_shell_command()
                    self._bridge.cancel()
                    self._jobs_hold = True
                    self._settle_inbox()
                    self._dismiss_user_panels()
                    self._notice([_stop_line()])
                    self._leave_busy()
                    self._app.render()
                    self._drain_after_worker()
                self._last_ctrl_c = now
                return
            if now - self._last_ctrl_c < 1.5:
                self._app._running = False
                return
            self._last_ctrl_c = now
            jobs = getattr(self, "_jobs", None)
            live = len(jobs.live()) if jobs is not None else 0
            stops = f" · stops {live} job{'s' if live != 1 else ''}" if live else ""
            self._footer.set_toast(f"Press ctrl+c again to exit{stops}", 1.5)
            self._app.render()
            return

        if kp.key == "ctrl+d":
            if typed:
                # Exits only from an empty box; with text it deletes forward, as in a shell
                self._prompt.handle_key("delete")
                self._update_completion()
                self._app.render()
                return
            self._app._running = False
            return

        if kp.key == "ctrl+z":
            self._suspend()
            return

        if kp.key == "ctrl+b":
            self._move_to_background()
            return

        if getattr(self, "_completion", None) is not None and self._completion_key(kp.key):
            return

        if kp.key == "escape":
            if self._is_loading:
                with self._app.lock:
                    self._stop_shell_command()
                    self._bridge.cancel()
                    # You stopped it: a finished job must not start the next turn by itself
                    self._jobs_hold = True
                    self._settle_inbox()
                    self._dismiss_user_panels()
                    self._notice([_stop_line()])
                    self._leave_busy()
                    self._drain_after_worker()
            else:
                now = time.monotonic()
                if not self._prompt.value and now - self._last_esc_at < 0.5:
                    self._last_esc_at = 0.0
                    # esc esc, as in pi: the tree, the fork list, or nothing (double_escape)
                    action = getattr(self.settings, "double_escape", "tree")
                    if action == "tree":
                        self._open_tree()
                        return
                    if action == "fork":
                        self._open_fork_picker()
                        return
                # Only an esc on an already empty box counts toward esc esc: the one that
                # clears your text must not open the tree as well
                self._last_esc_at = 0.0 if self._prompt.value else now
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
            self._app._force_full_render()
            self._open_model_picker()
            return

        if kp.key == "ctrl+p":
            self._cycle_model()
            return

        if kp.key == "shift+tab":
            self._cycle_thinking()
            return

        if kp.key == "ctrl+g":
            self._dispatch_slash("editor", "")
            return

        if kp.key == "ctrl+x":
            self._dispatch_slash("copy", "")  # the last answer, as pi's ctrl+x
            return

        if kp.key == "ctrl+f":
            self._open_find()
            return

        if kp.key == "alt+up" and self._dequeue_to_prompt():
            self._app.render()
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

        # A draft of several rows: ↑ ↓ move between them first, as in pi's editor (while
        # browsing the history they keep browsing)
        if kp.key in ("up", "down") and not getattr(self._input_history, "browsing", False):
            if self._prompt.move_vertical(-1 if kp.key == "up" else 1):
                self._app.render()
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

        # 页眉写着「? for shortcuts」：空输入框里按 ? 就是快捷键表
        if not self._prompt.value and (kp.char == "?" or kp.key == "?"):
            self._dispatch_slash("hotkeys", "")
            return

        # Pi-style: Alt+Enter queues a follow-up while busy (or sends now). Most terminals
        # send alt+enter as shift+enter, so ctrl+q does it too (pi's key on Windows).
        if kp.key in {"alt+enter", "alt+return", "ctrl+q"} or (
                getattr(kp, "alt", False) and kp.key in {"enter", "return"}):
            if self._prompt.value.strip():
                self._on_submit(self._prompt.take(), kind="followup")
                self._app.render()
            return

        if self._prompt.handle_key(
            kp.key if kp.key else "char",
            kp.char if len(kp.char) == 1 else "",
        ):
            self._update_completion()
            self._app.render()

    def _suspend(self) -> None:
        """ctrl+z: give the terminal back to the shell; ``fg`` brings Circle back."""
        import signal

        if not hasattr(signal, "SIGTSTP"):
            self._flash("Suspending is not supported here")
            return
        self._app.suspend_for_external()
        try:
            os.kill(os.getpid(), signal.SIGTSTP)  # returns once the shell continues us
        finally:
            self._app.resume_from_external()

    # ── find in the conversation (ctrl+f) ───────────────────────────────────

    def _open_find(self) -> None:
        """ctrl+f: find text in the conversation. Typing narrows, enter or ↓ goes to the
        next match, shift+enter or ↑ to the one before, esc closes."""
        if self._active_card() is not None:
            return
        self._find = {"query": "", "matches": [], "at": -1, "lit": None}
        self._show_find_status()
        self._app.render()

    def _find_matches(self, query: str) -> list[int]:
        words = " ".join(query.lower().split())
        if not words:
            return []
        return [index for index, row in enumerate(self._transcript.snapshot())
                if words in " ".join(_strip_ansi(row).lower().split())]

    def _show_find_status(self) -> None:
        state = self._find
        if state is None:
            return
        count = len(state["matches"])
        where = (f"{state['at'] + 1}/{count}" if count else "no matches") if state["query"] else ""
        text = f"find: {state['query']}▏" + (f"  {where}" if where else "")
        self._footer.hold_status(f"{text} · enter next · shift+enter previous · esc closes")

    def _unlight_find(self) -> None:
        state = self._find
        lit = state.get("lit") if state else None
        if lit is None:
            return
        index, original, highlighted = lit
        if self._transcript.message_at(index) == highlighted:  # a live turn may have redrawn it
            self._transcript.update_message_at(index, original)
        state["lit"] = None

    def _light_find(self) -> None:
        """Mark the current match and scroll it a third of the way down the view."""
        state = self._find
        self._unlight_find()
        if not state["matches"]:
            return
        index = state["matches"][state["at"]]
        original = self._transcript.message_at(index) or ""
        highlighted = _mark_text(original, state["query"])
        self._transcript.update_message_at(index, highlighted)
        state["lit"] = (index, original, highlighted)
        view = self._transcript.viewport_height()
        self._transcript.scroll_to(max(0, self._transcript.row_of(index) - view // 3))

    def _find_refresh(self, *, keep: bool = True) -> None:
        state = self._find
        self._unlight_find()
        state["matches"] = self._find_matches(state["query"])
        if state["matches"]:
            node = self._transcript.node
            top = self._transcript.message_at_row(int(getattr(node, "scroll_top", 0) or 0))
            later = [i for i, index in enumerate(state["matches"]) if index >= top]
            state["at"] = later[0] if later else len(state["matches"]) - 1
            self._light_find()
        else:
            state["at"] = -1
        self._show_find_status()

    def _close_find(self) -> None:
        self._unlight_find()
        self._find = None
        self._footer.clear_hold_status()
        self._app.render()

    def _handle_find_key(self, kp: KeyPress) -> bool:
        state = self._find
        key = kp.key
        if key in ("escape", "ctrl+c", "ctrl+f"):
            self._close_find()
            return True
        if key in ("enter", "return", "down", "shift+enter", "up"):
            if state["matches"]:
                step = -1 if key in ("shift+enter", "up") else 1
                state["at"] = (state["at"] + step) % len(state["matches"])
                self._light_find()
                self._show_find_status()
                self._app.render()
            return True
        if key == "backspace":
            state["query"] = state["query"][:-1]
        elif kp.char and len(kp.char) == 1 and kp.char.isprintable():
            state["query"] += kp.char
        else:
            return key not in ("ctrl+d",)  # other keys do nothing while finding
        self._find_refresh()
        self._app.render()
        return True

    # ── completion list: /commands and @files as you type ─────────────────

    _COMPLETION_ROWS = 6

    def _command_descriptions(self) -> dict[str, str]:
        found = {cmd.name: cmd.description for cmd in BUILTIN_SLASH}
        found.update({name: cmd.description for name, cmd in self._custom_commands.items()})
        found.update({name: cmd.description for name, cmd in self._extensions.commands().items()})
        if getattr(self, "_skill_descriptions", None) is None:
            from circle.skills import discover_skills

            try:
                self._skill_descriptions = {f"skill:{s.name}": s.description
                                            for s in discover_skills(self.workspace, self.home)}
            except Exception:  # noqa: BLE001 - completion without skills is still useful
                self._skill_descriptions = {}
        found.update(self._skill_descriptions)
        return found

    def _update_completion(self) -> None:
        """After each key in the input box: the commands that ``/part`` can still become,
        or the files ``@part`` can mean, listed above the box (as pi does)."""
        value, cursor = self._prompt.value, self._prompt.cursor_pos
        state: dict[str, Any] | None = None
        if value == getattr(self, "_completion_dismissed", None):
            state = None
        elif value.startswith("/") and cursor == len(value) and not any(
                ch.isspace() or ch == "↵" for ch in value):
            typed = value[1:].lower()
            described = self._command_descriptions()
            names = [n for n in sorted(described) if n.lower().startswith(typed)]
            if names and names != [typed]:
                state = {"kind": "command", "start": 0, "token": value,
                         "items": [(f"/{n}", f"/{n}", described[n].split("\n")[0][:70])
                                   for n in names]}
        else:
            before = value[:cursor]
            word = before.rsplit(" ", 1)[-1].rsplit("↵", 1)[-1]
            if word.startswith("@"):
                paths = complete(word[1:], self.workspace, limit=50)
                if paths and paths != [word[1:]]:
                    state = {"kind": "file", "start": cursor - len(word), "token": word,
                             "items": [(f"@{p}", p, "") for p in paths]}
        previous = getattr(self, "_completion", None)
        if state is not None:
            state["value"], state["cursor"] = value, cursor  # what the list was made for
            keep = previous.get("focused") if previous is not None else None
            values = [item[0] for item in state["items"]]
            state["focus"] = values.index(keep) if keep in values else 0
            state["focused"] = values[state["focus"]]
        self._completion = state
        if state is not None or previous is not None:
            self._render_completion()

    def _render_completion(self) -> None:
        state = getattr(self, "_completion", None)
        if getattr(self, "_picker", None) is not None or self._approvals_page is not None:
            return  # the panel is theirs
        if state is None:
            self._ask_panel.clear()
            return
        focus, rows = state["focus"], self._COMPLETION_ROWS
        top = min(max(0, focus - rows + 1), max(0, len(state["items"]) - rows))
        window = state["items"][top:top + rows]
        items = [PopupItem(label, f"  {meta}" if meta else "", False) for _v, label, meta in window]
        title = "commands" if state["kind"] == "command" else "files"
        more = len(state["items"]) - len(window)
        lines = popup_rows(f"{title}" + (f" · {focus + 1}/{len(state['items'])}" if more else ""),
                           items, focus - top, max(20, self._app.width or 80))
        self._ask_panel.update(lines)

    def _completion_key(self, key: str) -> bool:
        """↑ ↓ move in the list, tab takes the marked entry, enter takes it (and runs a
        command), esc closes the list. Other keys go on to the input box."""
        if (self._completion["value"], self._completion["cursor"]) != (
                self._prompt.value, self._prompt.cursor_pos):
            # the box changed without a key (a paste, a draft put back): list it again
            self._update_completion()
            if self._completion is None:
                return False
        state = self._completion
        if key in ("up", "down"):
            step = -1 if key == "up" else 1
            state["focus"] = (state["focus"] + step) % len(state["items"])
            state["focused"] = state["items"][state["focus"]][0]
            self._render_completion()
            self._app.render()
            return True
        if key == "escape":
            self._completion_dismissed = self._prompt.value
            self._completion = None
            self._render_completion()
            self._app.render()
            return True
        if key not in ("tab", "enter", "return"):
            return False
        chosen = state["items"][state["focus"]][0]
        value, cursor = self._prompt.value, self._prompt.cursor_pos
        if state["kind"] == "command":
            self._completion = None
            self._render_completion()
            if key == "tab":
                self._prompt.set_value(f"{chosen} ")
            else:
                self._prompt.set_value(chosen)
                self._on_submit(self._prompt.take())  # enter on a command runs it, as in pi
            self._app.render()
            return True
        start = state["start"]
        tail = "" if chosen.endswith("/") else " "
        head = value[:start] + chosen + tail
        self._prompt.set_value(head + value[cursor:], cursor=len(head))
        self._completion = None
        self._update_completion()  # a folder lists what is in it
        if self._completion is None:
            self._render_completion()
        self._app.render()
        return True

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
                self._flash(f"{len(pending)} secret(s) waiting · ctrl+s to enter", 5.0)
        elif self._secret_hint_shown:
            self._secret_hint_shown = False
            self._footer.update(status="ready")
            self._app.render()

    def _start_secret_entry(self) -> None:
        if self._secret_entry is not None:
            return
        pending = secret_prompt.list_pending(self.home)
        if not pending:
            self._flash("No secrets waiting")
            return
        request = pending[0]
        self._secret_entry = {"request": request, "buffer": ""}
        self._prompt.clear()
        self._secret_hint_shown = False
        question = str(request.get("question") or "the secret")
        self._footer.hold_status(f"Enter {question} · enter confirms · esc cancels")
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
                self._flash("A secret can't be empty · esc cancels")
                return
            try:
                secret_prompt.submit_answer(self.home, request["id"], entry["buffer"])
            except secret_prompt.SecretPromptError as exc:
                self._fail(f"Could not submit: {exc}")
            else:
                self._flash("Collected · not shown")
            self._secret_entry = None
            entry["buffer"] = ""
            self._prompt.clear()
            if secret_prompt.list_pending(self.home):
                self._start_secret_entry()
            else:
                self._footer.clear_hold_status()
                self._flash("Secrets collected")
            return
        if kp.key == "escape":
            self._secret_entry = None
            entry["buffer"] = ""
            self._prompt.clear()
            self._footer.clear_hold_status()
            self._flash("Cancelled")
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
            if self._plan_panel_at(col, row):
                direction = -1 if me.button == 0 else 1 if me.button == 1 else 0
                if direction and self._plan_panel.scroll(direction):
                    self._app.render()
                return
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

    def _plan_panel_at(self, col: int, row: int) -> bool:
        """Hit the whole visible panel, including its title and count rows."""
        panel = getattr(self, "_plan_panel", None)
        if panel is None or not panel.is_visible:
            return False
        rect = panel.node.rect
        return (rect.width > 0 and rect.height > 0
                and rect.x <= col < rect.x + rect.width
                and rect.y <= row < rect.y + rect.height)

    def _drag_to(self, col: int, row: int) -> None:
        from circle.ink.selection import extend_selection, update_selection

        sel = self._app.selection
        self._drag_point = (col, row)
        if sel.anchor_span is not None:
            extend_selection(sel, self._app._curr_screen, col, row)
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
        if int(row) != int(getattr(self._agent_detail_band.rect, "y", 0)):
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
        click_count = min(click_count, 3)

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
        from circle.ink.selection import (
            clear_selection,
            get_selected_text,
            has_selection,
        )
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
        self._app._repaint_full()

    def _scroll_transcript_to(self, top: int | None) -> None:
        """Home / End: to the first row, or back to the bottom (None); the detail page
        when it is open."""
        view = self._agent_detail if self._detail_active else self._transcript
        old_top = view.node.scroll_top
        view.scroll_to(top)
        actual = view.node.scroll_top - old_top
        if actual != 0:
            self._shift_selection_for_scroll(actual)
        self._app._repaint_full()

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
        if self._complete_mention():
            return
        if not val.startswith("/") or " " in val:
            return
        prefix = val[1:].lower()
        matches = [name for name in self._command_names() if name.startswith(prefix)]
        if not matches:
            self._flash(f"No command starts with /{prefix}")
            return
        if len(matches) == 1:
            self._prompt.set_value(f"/{matches[0]} ")
        else:
            shared = os.path.commonprefix(matches)
            self._footer.set_toast("  ".join(f"/{m}" for m in matches[:8])
                                   + ("  …" if len(matches) > 8 else ""), ttl_seconds=4.0)
            if len(shared) > len(prefix):
                self._prompt.set_value(f"/{shared}")
        self._app.render()

    def _command_names(self) -> list[str]:
        """Everything that can follow ``/``: built-in, custom and extension commands, and
        ``skill:<name>`` for each skill."""
        from circle.skills import discover_skills

        names = {cmd.name for cmd in BUILTIN_SLASH}
        names |= set(self._custom_commands) | set(self._extensions.commands())
        try:
            names |= {f"skill:{s.name}" for s in discover_skills(self.workspace, self.home)}
        except Exception:  # noqa: BLE001 - completion without skills is still useful
            logger.debug("skills unavailable for completion", exc_info=True)
        return sorted(names)

    def _complete_mention(self) -> bool:
        """tab on ``@part``: the path it can only mean, or as much of it as all the
        matches share, with the matches in the footer."""
        cursor = self._prompt.cursor_pos
        before, after = self._prompt.value[:cursor], self._prompt.value[cursor:]
        word = before.rsplit(" ", 1)[-1].rsplit("↵", 1)[-1]
        if not word.startswith("@"):
            return False
        matches = complete(word[1:], self.workspace)
        if not matches:
            self._flash(f"No file matches {word}")
            return True
        if len(matches) == 1:
            chosen = matches[0] + ("" if matches[0].endswith("/") else " ")
        else:
            chosen = os.path.commonprefix(matches)
            shown = "  ".join(matches[:8]) + ("  …" if len(matches) > 8 else "")
            self._footer.set_toast(shown, ttl_seconds=4.0)
            # Found by name elsewhere, the shared start need not contain what was typed
            if len(chosen) <= len(word) - 1 or not chosen.startswith(word[1:]):
                self._app.render()
                return True
        head = before[: len(before) - len(word)] + "@" + chosen
        self._prompt.set_value(head + after, cursor=len(head))
        self._app.render()
        return True

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
            if self._prompt.value:
                self._on_submit(self._prompt.take())
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
        self._flash("Thinking " + ("expanded" if self._thinking_expanded else "collapsed"), 1.2)

    def _toggle_tool_outputs(self) -> None:
        """InfoTest ``_toggle_expand`` / ctrl+o — tool-output verbosity."""
        self._tool_outputs_expanded = not self._tool_outputs_expanded
        self._show_details = self._tool_outputs_expanded
        self._rerender_turns()
        self._flash("Tool output " + ("expanded" if self._tool_outputs_expanded else "collapsed"), 1.2)
        self._footer.update(status="ready" if not self._is_loading else "running")
        self._app.render()

    def _on_submit(self, text: str, *, kind: str = "steering") -> None:
        raw, text = text, text.strip()
        if not text:
            return
        self._input_history.add(text)
        self._input_history.reset_navigation()
        extra = set(self._custom_commands) | set(self._extensions.commands())
        parsed = parse_slash(text, extra_commands=extra)
        if parsed is not None:
            self._dispatch_slash(parsed.name, parsed.args)
            return
        name = command_word(raw)
        if name:
            # A mistyped command would otherwise go to the model as a message. Give the
            # draft back; a leading space sends it as text, and a path is never a command.
            close = difflib.get_close_matches(name, sorted(known_slash_names() | extra), n=1)
            hint = f" · did you mean /{close[0]}?" if close else " · /help lists them"
            self._prompt.restore_draft(raw, self._prompt.submitted_pastes())
            self._flash(f"Unknown command /{name}{hint}", 4.0)
            return
        if text.startswith("!"):
            if self._is_loading:
                self._prompt.restore_draft(raw, self._prompt.submitted_pastes())
                self._flash("Busy · run it when the turn has finished")
                return
            self._run_shell_from_prompt(self._prompt.model_text(text))
            return
        # The model gets the long pastes, the line breaks and the @files; the transcript
        # keeps the short form the user saw in the input box.
        full = attach_files(self._prompt.model_text(text), self.workspace)
        shown = text.replace("↵", "\n")
        pastes = self._prompt.submitted_pastes()
        if full != shown or pastes:
            self._shown_as[full] = (shown, pastes)
        text = full
        inbox = getattr(self._bridge, "inbox", None)
        if kind == "steering" and inbox is not None and self._bridge.is_running:
            # The model reads it before its next call, without the turn being stopped
            waiting = inbox.put(text, shown)
            self._footer.set_toast(f"Steering · {waiting} waiting · read after the current step",
                                   ttl_seconds=4.0)
            self._app.render()
            return
        if self._bridge.is_running or self._is_loading or self._msg_queue:
            self._msg_queue.append((kind, text))
            label = "follow-up" if kind == "followup" else "steering"
            self._footer.set_toast(f"Queued {label} · {len(self._msg_queue)}")
            self._drain_message_queue()
            return
        self._start_user_turn(text)

    def _start_user_turn(self, text: str) -> None:
        # Under the lock: a finished background job must not start its turn in between
        with self._app.lock:
            self._start_user_turn_locked(text)

    def _start_user_turn_locked(self, text: str) -> None:
        if self._bridge.is_running or self._is_loading:
            self._msg_queue.append(("steering", text))
            self._footer.set_toast(f"Queued steering · {len(self._msg_queue)}")
            return
        # You are back: finished jobs may start turns again
        self._jobs_hold = False
        self._notice_streak = 0
        self._push_undo_checkpoint()
        shown, pastes = self._shown_as.pop(text, (text, {}))
        self._session_tree.add("user", shown)

        if self._session_title == "new":
            self._session_title = shown.split("\n", 1)[0][:60]
        self._remember_session()

        # 契约 D5：回合之间靠 1 空行分隔，不画横线。
        self._transcript.ensure_block_gap()
        self._transcript.append_messages(_user_rows(shown, self._view_options().width))
        self._transcript.ensure_block_gap()
        self._open_turn_region()
        self._turn_elapsed = 0.0
        self._turn_started_at = time.time()
        self._enter_busy()
        self._call_started_at = time.time()
        self._app.render()
        self._extensions.emit("turn_start", {"text": text})
        if self._leaf_checkpoint:
            self._bridge.branch_from = self._leaf_checkpoint
            self._forget_leaf()
        if shown != text or pastes:
            self._bridge.start(text, shown=shown, pastes=pastes)
        else:
            self._bridge.start(text)

    def _drain_message_queue(self) -> None:
        with self._app.lock:
            if self._bridge.is_running or self._is_loading or not self._msg_queue:
                return
            # Steering keeps its original priority; each class stays FIFO.
            index = next((i for i, (kind, _text) in enumerate(self._msg_queue)
                          if kind != "followup"), 0)
            _, text = self._msg_queue.pop(index)
            self._start_user_turn(text)

    def _drain_after_worker(self) -> None:
        """Drain after the old graph worker really exits, including cancellation."""
        bridge = self._bridge
        worker = bridge._worker

        def _wait_and_drain() -> None:
            if worker is not None and worker is not threading.current_thread():
                worker.join()
            if self._bridge is bridge:
                self._drain_message_queue()

        threading.Thread(target=_wait_and_drain, name="circle-queue-drain", daemon=True).start()

    def _notice(self, lines: list[str]) -> None:
        """One block of notice lines, one blank line away from the block above."""
        if not lines:
            return
        self._transcript.ensure_block_gap()
        self._transcript.append_messages(list(lines))

    def _toast(self, msg: str) -> None:
        """A state change worth keeping: one faint line in the transcript (契约 R6)."""
        self._notice([f" {_faint(msg)}"])
        self._app.render()

    def _flash(self, msg: str, ttl: float = 2.0) -> None:
        """An operation receipt: the footer's right side for a moment, never the transcript."""
        self._footer.set_toast(msg, ttl_seconds=ttl)
        self._app.render()

    def _fail(self, msg: str) -> None:
        """Something did not work and the user should be able to read why: a ✖ line that stays."""
        self._notice([_error_line(msg)])
        self._app.render()

    def _cmd_yolo(self, args: str) -> None:
        """/yolo — 切换自动批准所有工具调用。"""
        enabled = args.strip().lower() not in ("off", "0", "false", "no")
        self._approvals.set_yolo(self._thread_id, enabled)
        self._footer.set_yolo(enabled)
        self._bridge.auto_approve = enabled
        self._toast("Auto on · tool calls run without asking" if enabled
                    else "Auto off · asking for each call again")
        self._app.render()

    def _dispatch_slash(self, name: str, args: str) -> None:
        if name == "exit":
            self._app._running = False
            return
        if name == "help":
            custom = [(f"{c.name} {c.argument_hint}".strip(), c.description)
                      for c in self._custom_commands.values()]
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
            "jobs",  # list and stop jobs while a turn runs
        }
        if name not in _busy_ok and (self._bridge.is_running or self._is_loading):
            self._footer.set_toast("Busy · wait for the current turn to finish")
            return
        ext_command = self._extensions.commands().get(name)
        if ext_command is not None:
            try:
                ext_command.handler(args, self._command_context())
            except Exception as exc:  # noqa: BLE001 — 扩展命令出错只提示，不影响会话
                self._fail(f"/{name} failed: {type(exc).__name__}: {exc}")
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
            "effort": self._cmd_effort,
            "extensions": self._cmd_extensions,
            "approvals": self._cmd_approvals,
            "jobs": self._cmd_jobs,
        }
        handler = handlers.get(name)
        if handler is None:
            self._flash(f"Unknown command /{name} · try /help")
            return
        try:
            handler(args)
        except Exception as exc:  # noqa: BLE001 - a failed command must not end the session
            logger.warning("/%s failed", name, exc_info=True)
            self._fail(f"/{name} failed: {type(exc).__name__}: {exc}")

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
        found = session_index.find(self.home, thread_id)
        self._leaf_checkpoint = found.leaf if found is not None and found.leaf else None
        self._session_tree = _tree_from(self._saved_messages(thread_id, self._leaf_checkpoint))
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
        """/login (/connect): the ways to reach the model, as setup offers them.
        ``/login anthropic|openai`` goes straight to that OAuth sign-in."""
        from circle.oauth import (
            SUPPORTED_OAUTH_PROVIDERS,
            OAuthNotConfiguredError,
            start_oauth_login,
        )

        provider = args.strip().lower()
        if not provider:
            self._open_login_picker()
            return
        if provider not in SUPPORTED_OAUTH_PROVIDERS:
            self._fail(f"Unknown provider {provider!r} · choose {', '.join(SUPPORTED_OAUTH_PROVIDERS)}")
            return
        self._flash(f"Signing in to {provider}…", 4.0)
        try:
            session = start_oauth_login(provider)
        except OAuthNotConfiguredError as exc:
            self._fail(str(exc))
            return
        except ValueError as exc:
            self._fail(str(exc))
            return

        models = list(session.models) or [self.settings.auth.model]
        model = models[0] if models else self.settings.auth.model
        self._use_connection(
            ModelAuth(
                mode="oauth",
                protocol="anthropic" if provider == "anthropic" else "openai",
                base_url=session.base_url,
                model=model or self.settings.auth.model,
                oauth_provider=provider,
                api_key_ref="oauth_access_token",
            ),
            {
                "oauth_access_token": session.access_token,
                "oauth_refresh_token": session.refresh_token,
            },
        )

    def _use_connection(self, auth: ModelAuth, credentials: dict[str, str]) -> None:
        """Signed in: the connection becomes the saved one and this session's model is built
        on it. As in setup, the models ctrl+p goes through were the old endpoint's, so a new
        endpoint clears them."""
        changed = ["model"]
        if self.settings.auth.base_url.rstrip("/") != auth.base_url.rstrip("/"):
            self.settings.enabled_models = []
            changed.append("enabled_models")
        self.settings.auth = auth
        self.settings.initialized = True
        save_credentials(credentials, self.home)
        self._saved_model = None
        self._model_list = None  # the new endpoint is asked again
        self._save_settings(*changed)
        apply_auth_to_environ(self.settings, self.home)
        try:
            chat = build_chat_model(self.settings, home=self.home)
            self._rebuild_agent(model=chat)
            self.model_override = None
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Credentials saved, but rebuilding the model failed: {exc}")
            return
        self._footer.update(model=self.settings.auth.model)
        where = auth.oauth_provider or _endpoint_name(auth.base_url)
        self._toast(f"Signed in to {where} · model {self.settings.auth.model}")

    # ── /login: setup's questions, asked in the session ─────────────────────

    def _open_login_picker(self) -> None:
        """How Circle reaches the model, then the URL, the key and the model, asked by the
        controller setup uses. Nothing is saved before a model is picked; esc leaves."""
        login = InitController(home=self.home, probe=self._probe_endpoint,
                               defer_probe=True, persist=False)
        self._login = login
        self._login_step(login)

    def _close_login(self) -> None:
        self._login = None
        self._close_picker()

    def _probe_endpoint(self, base_url: str, api_key: str):
        from circle.probe import resolve_endpoint

        try:
            return resolve_endpoint(base_url, api_key)
        except Exception:  # noqa: BLE001 - a probe that breaks is a failed probe
            logger.warning("asking %s for its models failed", base_url, exc_info=True)
            return None

    def _login_title(self, login: InitController) -> str:
        return "Sign in" + (f" · {login.error}" if login.error else "")

    def _login_step(self, login: InitController) -> None:
        """The list for the step ``login`` is at; at DONE, sign in with what was chosen."""
        with self._app.lock:
            if getattr(self, "_login", None) is not login:
                return  # left with esc while the endpoint was being asked
            step = login.step
            if step == InitStep.DONE and login.auth is not None:
                self._close_login()
            elif step == InitStep.PROBING:
                self._login_probe(login)
            elif step == InitStep.OAUTH_PROVIDER:
                self._login_choice(login, [("anthropic", "anthropic"), ("openai", "openai")],
                                   hint="sign in with OAuth")
            elif step == InitStep.MANUAL_PROTOCOL:
                self._login_choice(login, [("openai", "OpenAI-style API"),
                                           ("anthropic", "Anthropic-style API")],
                                   hint=f"{login.status} · which kind of API is it?")
            elif step == InitStep.PICK_MODEL:
                self._login_models(login)
            else:
                self._login_methods(login)
        if step == InitStep.DONE and login.auth is not None:
            # Not under the screen lock: building the agent can take seconds (MCP servers)
            self._use_connection(login.auth, login.credentials)

    def _login_methods(self, login: InitController) -> None:
        from circle.oauth import oauth_available

        auth = self.settings.auth
        oauth_ok = oauth_available()
        if not self.settings.initialized:
            now = "not signed in"
        elif auth.mode == "oauth":
            now = f"now oauth · {auth.oauth_provider} · {auth.model}"
        else:
            now = f"now api key · {_endpoint_name(auth.base_url)} · {auth.model}"
        items = [
            PickerItem(key="api_key", label="API URL + KEY", current=auth.mode == "api_key"),
            PickerItem(key="oauth", label="OAuth sign-in", current=auth.mode == "oauth",
                       meta="" if oauth_ok else "not available yet"),
        ]
        steps = "enter continues · esc goes back"

        def ask_url(text: str) -> None:
            picker.title = self._login_title(login)
            picker.ask("base url", text, got_url, keys=steps)

        def got_url(text: str) -> None:
            login.submit_line(text)
            if login.step == InitStep.API_URL:  # not a URL: say why and ask again
                ask_url(text)
            else:
                ask_key()

        def ask_key() -> None:
            picker.title = self._login_title(login)
            label = "api key" + (" (enter keeps the saved one)" if login.has_saved_key else "")
            picker.ask(label, "", got_key, mask=True, keys=steps)

        def got_key(text: str) -> None:
            login.submit_line(text)
            if login.step == InitStep.API_KEY:
                ask_key()
            else:
                self._login_step(login)

        def pick(item: PickerItem) -> None:
            if item.key == "oauth" and not oauth_ok:
                self._flash("OAuth sign-in is not available yet · use API URL + KEY", 3.0)
                return
            login.error = ""
            login.step = InitStep.AUTH_MODE  # back here after esc: start the answers again
            login.model_focus = 0 if item.key == "api_key" else 1
            login.confirm()
            if login.step == InitStep.API_URL:
                ask_url(login.saved_url)
            else:
                self._login_step(login)

        picker = Picker(
            title=self._login_title(login), items=items, on_pick=pick,
            on_close=self._close_login, render=self._render_picker,
            focus_key="oauth" if auth.mode == "oauth" else "api_key", hint=now)
        self._open_picker(picker)

    def _login_choice(self, login: InitController, choices: list[tuple[str, str]], *,
                      hint: str) -> None:
        """Two answers, as setup's ↑↓ lists: which OAuth provider, which kind of API."""
        keys = [key for key, _label in choices]

        def pick(item: PickerItem) -> None:
            login.error = ""
            login.model_focus = keys.index(item.key)
            login.confirm()
            self._login_step(login)

        self._open_picker(Picker(
            title=self._login_title(login),
            items=[PickerItem(key=key, label=label) for key, label in choices],
            on_pick=pick, on_close=self._close_login, render=self._render_picker,
            focus_key=keys[min(login.model_focus, len(keys) - 1)], hint=hint))

    def _login_probe(self, login: InitController) -> None:
        """Ask the endpoint for its models off the input thread: it can take seconds."""
        self._open_picker(Picker(
            title=self._login_title(login), items=[], on_pick=lambda _item: None,
            on_close=self._close_login, render=self._render_picker,
            empty=f"asking {_endpoint_name(login.base_url)} for its models…"))

        def run() -> None:
            login.run_probe()
            self._login_step(login)

        threading.Thread(target=run, name="circle-login-probe", daemon=True).start()

    def _login_models(self, login: InitController) -> None:
        def pick(item: PickerItem) -> None:
            login.error = ""
            login.model_focus = login.models.index(item.key)
            login.confirm()
            self._login_step(login)

        def typed(text: str) -> None:
            # An id the endpoint did not list, not checked. Not submit_line: it reads a bare
            # number as a row of setup's numbered list
            login.error = ""
            if text not in login.models:
                login.models.insert(0, text)
            login.model_focus = login.models.index(text)
            login.confirm()
            self._login_step(login)

        current = self.settings.auth.model
        self._open_picker(Picker(
            title=self._login_title(login),
            items=[PickerItem(key=m, label=m, current=m == current) for m in login.models],
            on_pick=pick, on_close=self._close_login, render=self._render_picker,
            focus_key=current, hint=login.status, free_text=typed,
            empty=("No model matches · enter uses what you typed" if login.models
                   else "Type the model id your endpoint uses")))

    def _cmd_logout(self, _args: str) -> None:
        clear_credentials(self.home)
        self.settings.auth = ModelAuth()
        self.settings.initialized = False
        self._saved_model = None
        self._save_settings("model")
        self._toast("Signed out · credentials cleared · /login or `circle --init` before the next turn")

    def _cmd_new(self, _args: str) -> None:
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._bridge = self._make_bridge()
        self._reset_turn_regions()
        self._session_tree = SessionTree()
        self._leaf_checkpoint = None
        self._session_title = "new"
        self._transcript.clear()
        self._show_welcome()
        self._toast(f"New session {self._thread_id}")

    def _cmd_resume(self, args: str) -> None:
        """Pick a conversation (no argument), or open one by number or the end of its id."""
        if not args.strip():
            self._open_session_picker()
            return
        self._archive_current()
        in_run = {rec.thread_id: rec for rec in self._archive}
        try:
            saved = session_index.for_workspace(self.home, self.workspace)
        except Exception:  # noqa: BLE001 - the list from this run still works
            logger.warning("session index unavailable", exc_info=True)
            saved = []
        listed = [(item.thread_id, item.title, session_index.age(item.updated)) for item in saved]
        known = {thread_id for thread_id, _title, _age in listed}
        listed[:0] = [(rec.thread_id, rec.title, "") for rec in self._archive
                      if rec.thread_id not in known]
        if not listed:
            self._flash("No earlier session in this folder")
            return
        target = args.strip()
        chosen: tuple[str, str] | None = None
        if target.isdigit() and 1 <= int(target) <= len(listed):
            chosen = listed[int(target) - 1][:2]
        else:
            chosen = next(((tid, title) for tid, title, _ago in listed
                           if tid == target or tid.endswith(target)), None)
        if chosen is None:
            self._fail(f"No session {target!r} in this folder · /resume lists them")
            return
        thread_id, title = chosen
        if thread_id == self._thread_id:
            self._flash("Already in that session")
            return
        if thread_id in in_run:
            rec = in_run[thread_id]
            self._switch_thread(thread_id, lines=rec.lines, bgs=rec.bgs)
            self._toast(f"Resumed {thread_id} · {rec.title[:40]}")
            return
        self._open_saved(thread_id, title)

    def _saved_messages(self, thread_id: str, checkpoint: str | None = None) -> list[Any]:
        config: dict[str, Any] = {"configurable": {"thread_id": thread_id}}
        if checkpoint:
            config["configurable"]["checkpoint_id"] = checkpoint
        try:
            state = self._agent.get_state(config)
        except Exception:  # noqa: BLE001 - an empty history is the safe answer
            logger.debug("no saved state for %s", thread_id, exc_info=True)
            return []
        return list((getattr(state, "values", None) or {}).get("messages") or [])

    def _open_session_picker(self, *, everywhere: bool = False) -> None:
        """Pick a conversation: type to search, tab for every folder's, ctrl+r renames,
        ctrl+d deletes. One from another folder is forked into this one."""
        if self._bridge.is_running or self._is_loading:
            self._flash("Busy · switch sessions when the turn has finished")
            return
        self._archive_current()
        state = {"everywhere": everywhere}

        def rows() -> list[PickerItem]:
            try:
                found = (session_index.everywhere(self.home) if state["everywhere"]
                         else session_index.for_workspace(self.home, self.workspace, limit=200))
            except Exception:  # noqa: BLE001 - the list from this run still works
                logger.warning("session index unavailable", exc_info=True)
                found = []
            here = str(self.workspace)
            items = []
            for saved in found:
                where = "" if saved.workspace == here else f" · {_path_tail(saved.workspace)}"
                items.append(PickerItem(
                    key=saved.thread_id, label=saved.title or "(untitled)",
                    meta=f"{session_index.age(saved.updated)}{where}",
                    search=f"{saved.thread_id} {saved.workspace}",
                    current=saved.thread_id == self._thread_id))
            known = {item.key for item in items}
            items[0:0] = [PickerItem(key=rec.thread_id, label=rec.title or rec.thread_id,
                                     meta="this run", current=rec.thread_id == self._thread_id)
                          for rec in self._archive if rec.thread_id not in known
                          and not state["everywhere"]]
            return items

        def title() -> str:
            return "Sessions · every folder" if state["everywhere"] else "Sessions · this folder"

        def pick(item: PickerItem) -> None:
            self._close_picker()
            found = session_index.find(self.home, item.key)
            if found is not None and found.workspace != str(self.workspace):
                self._fork_from_elsewhere(found)
                return
            if item.key != self._thread_id:
                self._cmd_resume(item.key)

        def scope(_item: PickerItem | None) -> None:
            state["everywhere"] = not state["everywhere"]
            picker.title = title()
            picker.set_items(rows())

        def rename(item: PickerItem | None) -> None:
            if item is None:
                return

            def done(text: str) -> None:
                if text.strip():
                    session_index.rename(self.home, item.key, text)
                    if item.key == self._thread_id:
                        self._session_title = " ".join(text.split())[:80]
                    picker.set_items(rows())

            picker.ask("New name", "" if item.label == "(untitled)" else item.label, done)

        def delete(item: PickerItem | None) -> None:
            if item is None:
                return
            if item.key == self._thread_id:
                self._flash("The session you are in cannot be deleted")
                return

            def done() -> None:
                session_index.forget(self.home, item.key)
                remover = getattr(self._checkpointer, "delete_thread", None)
                if callable(remover):
                    try:
                        remover(item.key)
                    except Exception:  # noqa: BLE001 - the list entry is gone either way
                        logger.warning("could not delete %s", item.key, exc_info=True)
                self._archive = [rec for rec in self._archive if rec.thread_id != item.key]
                picker.set_items(rows())
                self._flash(f"Deleted {item.label[:40]}")

            picker.confirm(f"Delete “{item.label[:40]}” and its messages?", done)

        picker = Picker(
            title=title(), items=rows(), on_pick=pick, on_close=self._close_picker,
            render=self._render_picker, focus_key=self._thread_id,
            keys={"tab": scope, "ctrl+r": rename, "ctrl+d": delete},
            hint="enter opens · tab every folder · ctrl+r renames · ctrl+d deletes",
            empty="No sessions here · tab shows every folder's")
        self._open_picker(picker)

    def _fork_from_elsewhere(self, saved: Any, *, into: str | None = None) -> None:
        """A conversation from another folder continues here as a new session: its messages
        are copied, the original stays where it was."""
        messages = self._saved_messages(saved.thread_id, getattr(saved, "leaf", "") or None)
        if not messages:
            self._fail(f"Session {saved.thread_id} has no saved messages")
            return
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = into or f"circle-{uuid.uuid4().hex[:8]}"
        self._leaf_checkpoint = None
        try:
            self._write_history(self._thread_id, messages)
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not copy the session: {exc}")
            return
        self._bridge = self._make_bridge()
        self._reset_turn_regions()
        self._transcript.clear()
        self._session_title = f"{saved.title or saved.thread_id} (from {_short_path(saved.workspace)})"
        self._replay(messages)
        self._remember_session()
        self._toast(f"Forked {saved.thread_id} from {_short_path(saved.workspace)} → {self._thread_id}")

    def _open_saved(self, thread_id: str, title: str = "") -> bool:
        """Reopen a conversation from an earlier run: its messages are in the checkpoint
        store, and the screen is drawn again from them."""
        found = session_index.find(self.home, thread_id)
        leaf = found.leaf if found is not None and found.leaf else None
        config: dict[str, Any] = {"configurable": {"thread_id": thread_id}}
        if leaf:
            config["configurable"]["checkpoint_id"] = leaf
        try:
            state = self._agent.get_state(config)
        except Exception as exc:  # noqa: BLE001 - shown, details in the log
            logger.warning("could not read session %s", thread_id, exc_info=True)
            self._fail(f"Could not open {thread_id}: {exc}")
            return False
        messages = list((getattr(state, "values", None) or {}).get("messages") or [])
        if not messages:
            self._fail(f"Session {thread_id} has no saved messages")
            return False
        if not title:
            title = found.title if found else ""
        self._switch_thread(thread_id, lines=[], bgs=[])
        self._leaf_checkpoint = leaf
        self._session_title = title or thread_id
        self._replay(messages)
        self._toast(f"Resumed {thread_id} · {self._session_title[:40]}")
        return True

    def _replay(self, messages: list[Any]) -> None:
        options = self._view_options()
        options.pending_calls = []
        last = None
        for text, snap in saved_turns(messages):
            self._transcript.ensure_block_gap()
            if text:  # a turn Circle started for finished jobs opens with their rows instead
                self._transcript.append_messages(_user_rows(text, self._view_options().width))
                self._transcript.ensure_block_gap()
            base = self._transcript.message_count()
            rows = render_turn_rows(snap, options)
            for row, bg in rows:
                self._transcript.append_messages([row], bg=bg)
            self._turns.append({"base": base, "entries": rows, "snap": snap})
            last = snap
        if last is not None:
            self._last_assistant_plain = final_text(last)
        self._session_tree = _tree_from(messages)
        used = next((extract_message_usage(m) for m in reversed(messages)
                     if getattr(m, "usage_metadata", None)), {})
        self._footer.update(context_input_tokens=int(used.get("input_tokens") or 0) or None)
        self._app.render()

    def _run_shell_from_prompt(self, text: str) -> None:
        """``!cmd`` runs a command yourself; its output goes into the conversation for the
        model to see with your next message. ``!!cmd`` runs it without telling the model.
        It is drawn like the model's own Bash calls, and esc stops it."""
        quiet = text.startswith("!!")
        command = text[2 if quiet else 1:].strip()
        if not command:
            self._flash("!command runs it and shows the model · !!command keeps it to you", 4.0)
            return
        backend = getattr(self._agent, "_circle_backend", None)
        if self._is_loading or backend is None:
            self._flash("Busy · run it when the turn has finished")
            return
        self._transcript.ensure_block_gap()
        self._transcript.append_messages(_user_rows(text, self._view_options().width))
        self._transcript.ensure_block_gap()
        call_id = f"shell-{uuid.uuid4().hex[:8]}"
        options = self._view_options()
        options.pending_calls = []
        rows = render_turn_rows(_shell_snapshot(call_id, command, None), options)
        base = self._transcript.message_count()
        for row, bg in rows:
            self._transcript.append_messages([row], bg=bg)
        stop = CancellationToken()
        self._shell_stop = stop
        self._call_started_at = time.time()
        self._enter_busy()
        self._app.render()
        thread_id = self._thread_id

        def work() -> None:
            try:
                result = backend.execute(command, stop=stop,
                                         owner=Owner(thread_id=thread_id, started_by="user"))
            except Exception as exc:  # noqa: BLE001 - shown as the command's output
                logger.warning("!command failed", exc_info=True)
                result = ExecuteResponse(output=f"Error: {type(exc).__name__}: {exc}", exit_code=1)
            with self._app.lock:
                snap = _shell_snapshot(call_id, command, result)
                done = render_turn_rows(snap, options)
                self._transcript.replace_range(base, len(rows), [r for r, _bg in done],
                                               bgs=[bg for _r, bg in done])
                # The row keeps its place (one entry, running or done). After esc a queued
                # message may have finished a turn below it already: keep _turns in order.
                at = next((i for i, turn in enumerate(self._turns) if turn["base"] > base),
                          len(self._turns))
                self._turns.insert(at, {"base": base, "entries": done, "snap": snap})
                job = getattr(result, "job", None)
                if job is not None:
                    # Moved to the background, its output is shared when it ends; processes
                    # it left running only get a line when they end
                    moved = result.exit_code is None
                    self._user_jobs[job.id] = (command, quiet or not moved, thread_id)
                if (not quiet and not stop.cancelled and thread_id == self._thread_id
                        and result.exit_code is not None):
                    self._share_shell_output(command, result)
                if self._shell_stop is stop:
                    self._shell_stop = None
                    self._leave_busy()
                    self._drain_message_queue()
                self._app.render()

        threading.Thread(target=work, name="circle-shell", daemon=True).start()

    def _settle_inbox(self) -> None:
        """The turn is over: what the model read mid-turn joins the message tree, and what
        it did not get to is sent next, ahead of the other queued messages."""
        inbox = getattr(self._bridge, "inbox", None)
        if inbox is None:
            return
        for shown in inbox.take_delivered():
            self._session_tree.add("user", shown)
            for full in [k for k, (s, _p) in self._shown_as.items() if s == shown]:
                self._shown_as.pop(full, None)
        self._msg_queue[0:0] = [("steering", full) for full, _shown in inbox.take()]

    def _dequeue_to_prompt(self) -> bool:
        """alt+up: messages that have not been sent yet come back to the input box."""
        inbox = getattr(self._bridge, "inbox", None)
        waiting = (inbox.take() if inbox is not None else [])
        texts = [self._shown_as.pop(full, (shown, {}))[0] for full, shown in waiting]
        texts += [self._shown_as.pop(full, (full, {}))[0] for _kind, full in self._msg_queue]
        self._msg_queue.clear()
        if not texts:
            return False
        current = self._prompt.value
        self._prompt.clear()
        self._prompt.handle_paste("\n\n".join([*texts, *([current] if current else [])]))
        self._flash(f"{len(texts)} queued message{'s' if len(texts) != 1 else ''} back in the box")
        return True

    def _stop_shell_command(self) -> None:
        """esc or ctrl+c: end a running ``!command``; its worker then leaves the screen be."""
        if self._shell_stop is not None:
            self._shell_stop.cancel()
            self._shell_stop = None

    def _share_shell_output(self, command: str, result: Any) -> None:
        """Put a command's output into the conversation without starting a turn."""
        message = HumanMessage(
            content=f"I ran this command myself:\n$ {command}\n{result.output}",
            additional_kwargs={"circle_shell": {"command": command, "output": result.output,
                                                "exit_code": result.exit_code}})
        try:
            self._inject(message)
        except Exception:  # noqa: BLE001 - shown, the output is still on screen
            logger.warning("could not add the command output to the conversation",
                           exc_info=True)
            self._fail("The output is on screen but could not be added to the conversation")
            return
        self._session_tree.add("user", f"!{command}")
        if self._session_title == "new":
            self._session_title = f"!{command}"[:60]
        self._remember_session()

    def _remember_session(self) -> None:
        """Keep this conversation in the folder's list so it can be reopened later."""
        if self._run_options.no_session:
            return
        try:
            session_index.record(self.home, self._thread_id, self.workspace,
                                 title="" if self._session_title == "new" else self._session_title,
                                 model=self.settings.auth.model)
        except Exception:  # noqa: BLE001 - never stop a turn for the list
            logger.warning("could not record the session", exc_info=True)

    def _cmd_continue(self, _args: str) -> None:
        prev = self._previous_thread_id
        if not prev or prev == self._thread_id:
            # fall back to last archive entry that isn't current
            for rec in reversed(self._archive):
                if rec.thread_id != self._thread_id:
                    prev = rec.thread_id
                    break
        if not prev or prev == self._thread_id:
            self._flash("No previous session")
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
        self._toast(f"Continued {prev} · {title[:40]}")

    def _cmd_models(self, args: str) -> None:
        name = args.strip()
        if not name:
            self._open_model_picker()
            return
        self._use_model(name, save=False)

    # ── pickers: models, thinking depth, sessions ───────────────────────────

    def _open_picker(self, picker: Picker) -> None:
        with self._app.lock:
            self._picker = picker
            self._render_picker()

    def _render_picker(self) -> None:
        with self._app.lock:
            if self._picker is None:
                self._ask_panel.clear()
            else:
                self._ask_panel.update(self._picker.render_lines(max(20, self._app.width or 80)))
            self._app.render()

    def _close_picker(self) -> None:
        with self._app.lock:
            self._picker = None
            self._ask_panel.clear()
            self._app.render()

    def _refresh_models(self) -> str:
        """Ask the endpoint for its models; returns what to say about the answer. A failed
        ask is a red line, and no model names are made up."""
        discovery = self._list_models()
        if isinstance(discovery, list):  # a list given directly (tests, extensions)
            self._model_list = list(discovery)
            return ""
        if getattr(discovery, "status", "") == "failed":
            self._model_list = []
            self._fail(discovery.summary())
            return discovery.summary()
        self._model_list = list(getattr(discovery, "models", []) or [])
        return discovery.summary()

    def _known_models(self) -> list[str]:
        """What the endpoint listed, asked once per run (ctrl+p uses it), with the model in
        use first when the endpoint does not list it."""
        if self._model_list is None:
            self._refresh_models()
        found = self._model_list or []
        current = self.settings.auth.model
        return found if not current or current in found else [current, *found]

    def _run_scope_only(self) -> bool:
        """``circle --models``: this run has its own list for ctrl+p, never saved, even
        when tab in /models has emptied it."""
        if getattr(self, "_run_scope", None) is None:
            self._run_scope = bool(self._run_options.models)
        return self._run_scope

    def _model_scope(self) -> list[str]:
        """The models ctrl+p goes through: the scope's patterns matched against what the
        endpoint lists (an id it does not list is kept as written), or every listed model."""
        import fnmatch

        patterns = (self._run_options.models if self._run_scope_only()
                    else self.settings.enabled_models)
        known = self._known_models()
        if not patterns:
            return known
        out: list[str] = []
        for pattern in patterns:
            glob = any(c in pattern for c in "*?[")
            hits = [m for m in known if fnmatch.fnmatch(m.lower(), pattern.lower())
                    or (not glob and pattern.lower() == m.lower())]
            for m in hits or ([] if glob else [pattern]):
                if m not in out:
                    out.append(m)
        return out or known

    def _open_model_picker(self) -> None:
        if self._bridge.is_running or self._is_loading:
            self._flash("Busy · switch models when the turn has finished")
            return
        current, saved = self.settings.auth.model, self._saved_model or self.settings.auth.model
        said = self._refresh_models()  # asked again each time the list opens

        def rows() -> list[PickerItem]:
            scoped = self._run_options.models if self._run_scope_only() \
                else self.settings.enabled_models
            scope = set(self._model_scope()) if scoped else set()
            return [PickerItem(key=m, label=m, current=m == current,
                               meta=" · ".join(x for x in ("default" if m == saved else "",
                                                          "in ctrl+p" if m in scope else "") if x))
                    for m in self._known_models()]

        def toggle(item: PickerItem | None) -> None:
            """tab: the model joins or leaves the ones ctrl+p goes through, as pi's
            /scoped-models. Saved in enabled_models, or for this run only with --models."""
            if item is None:
                return
            scoped = self._run_options.models if self._run_scope_only() \
                else self.settings.enabled_models
            chosen = list(self._model_scope()) if scoped else []
            if item.key in chosen:
                chosen.remove(item.key)
            else:
                chosen.append(item.key)
            if self._run_scope_only():
                self._run_options.models = chosen
            else:
                self.settings.enabled_models = chosen
                self._save_settings("enabled_models")
            picker.set_items(rows())
            self._flash(f"ctrl+p goes through {len(chosen)} model{'s' if len(chosen) != 1 else ''}"
                        if chosen else "ctrl+p goes through every listed model", 2.0)

        def pick(item: PickerItem) -> None:
            self._close_picker()
            self._use_model(item.key, save=False)

        def save(item: PickerItem | None) -> None:
            if item is not None:
                self._close_picker()
                self._use_model(item.key, save=True)

        picker = Picker(
            title="Model" + (f" · {said}" if said else ""), items=rows(), on_pick=pick,
            on_close=self._close_picker,
            render=self._render_picker, focus_key=current, keys={"ctrl+s": save, "tab": toggle},
            hint="enter uses it in this session · ctrl+s also makes it the default · "
                 "tab adds it to ctrl+p or takes it out",
            empty="No model matches · /models <id> uses an id the endpoint does not list")
        self._open_picker(picker)

    def _cycle_model(self) -> None:
        if self._bridge.is_running or self._is_loading:
            self._flash("Busy · switch models when the turn has finished")
            return
        scope = self._model_scope()
        if len(scope) < 2:
            self._flash("Only one model to cycle through · /models lists them, "
                        "enabled_models in settings sets which ctrl+p uses", 5.0)
            return
        current = self.settings.auth.model
        following = scope[(scope.index(current) + 1) % len(scope)] if current in scope else scope[0]
        self._use_model(following, save=False)

    def _current_thinking(self) -> str:
        return (reasoning_effort_of(self._chat_model)
                or os.environ.get("CIRCLE_REASONING_EFFORT", "")).strip()

    def _open_thinking_picker(self) -> None:
        if self._bridge.is_running or self._is_loading:
            self._flash("Busy · change the thinking depth when the turn has finished")
            return
        notes = {"minimal": "~1k tokens", "low": "~2k", "medium": "~8k", "high": "~16k",
                 "xhigh": "~32k", "max": "as much as the model allows"}
        current, saved = self._current_thinking(), self.settings.default_thinking
        items = [PickerItem(key=level, label=level, current=level == current,
                            meta=" · ".join(x for x in (notes.get(level, ""),
                                                       "default" if level == saved else "") if x))
                 for level in EFFORT_LEVELS]

        def pick(item: PickerItem) -> None:
            self._close_picker()
            self._set_thinking(item.key)

        def save(item: PickerItem | None) -> None:
            if item is not None:
                self._close_picker()
                self.settings.default_thinking = item.key
                self._save_settings("default_thinking")
                self._set_thinking(item.key, saved=True)

        self._open_picker(Picker(
            title="Thinking depth", items=items, on_pick=pick, on_close=self._close_picker,
            render=self._render_picker, focus_key=current or None, keys={"ctrl+s": save},
            hint="enter uses it in this session · ctrl+s also makes it the default · "
                 "shift+tab cycles"))

    def _cycle_thinking(self) -> None:
        if self._bridge.is_running or self._is_loading:
            self._flash("Busy · change the thinking depth when the turn has finished")
            return
        levels = list(EFFORT_LEVELS)
        current = self._current_thinking()
        following = levels[(levels.index(current) + 1) % len(levels)] if current in levels else levels[0]
        self._set_thinking(following)

    def _set_thinking(self, level: str, *, saved: bool = False) -> None:
        os.environ["CIRCLE_REASONING_EFFORT"] = level
        try:
            model = build_chat_model(self.settings, home=self.home)
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not change the thinking depth: {exc}")
            return
        self._rebuild_agent(model=model)
        shown = reasoning_effort_of(self._chat_model) or level
        note = "" if shown == level else f" (the closest this model supports to {level})"
        self._flash(f"Thinking depth → {shown}{note}" + (" · saved as the default" if saved else ""),
                    3.0)

    def _list_models(self):
        from circle.probe import resolve_endpoint

        creds = load_credentials(self.home)
        key = (
            creds.get(self.settings.auth.api_key_ref)
            or creds.get("api_key")
            or creds.get("oauth_access_token")
            or ""
        )
        base = self.settings.auth.base_url
        return resolve_endpoint(base, key, protocol=self.settings.auth.protocol)

    def _use_model(self, name: str, *, save: bool) -> None:
        """Switch the model for this session; ``save`` also makes it the default in
        settings.json (ctrl+s in the picker), as pi does."""
        if save:
            self._saved_model = None
            self.settings.auth.model = name
            self._save_settings("model")
        else:
            if self._saved_model is None:
                self._saved_model = self.settings.auth.model
            self.settings.auth.model = name
            if name == self._saved_model:
                self._saved_model = None
        apply_auth_to_environ(self.settings, self.home)
        # Explicit /models switch leaves the scripted/test override behind.
        self.model_override = None
        try:
            model = build_chat_model(self.settings, home=self.home)
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not switch model: {exc}")
            return
        self._rebuild_agent(model=model)
        self._footer.update(model=name)
        if save:
            self._toast(f"Model → {name} · saved as the default")
        else:
            self._flash(f"Model → {name} · this session (ctrl+s in /models saves it)", 4.0)

    def _cmd_effort(self, args: str) -> None:
        """How hard the model thinks, for this session: a picker, or a level."""
        level = args.strip().lower()
        if not level:
            self._open_thinking_picker()
            return
        if level not in EFFORT_LEVELS:
            self._fail(f"Unknown depth {level!r} · choose {', '.join(EFFORT_LEVELS)}")
            return
        self._set_thinking(level)
        self._toast(f"Thinking depth → {reasoning_effort_of(self._chat_model) or level}")

    def _cmd_compact(self, args: str) -> None:
        """Run deepagents ``compact_conversation`` in the current thread."""
        hint = args.strip()
        msgs = self._saved_messages(self._thread_id, self._leaf_checkpoint)
        if len(msgs) < 2:
            self._flash("Nothing to compact yet")
            return
        config = thread_config(self._thread_id)
        if self._leaf_checkpoint:
            # compacting what is on screen: a branch from the point /tree went back to
            config = {"configurable": {**config["configurable"],
                                       "checkpoint_id": self._leaf_checkpoint}}
            self._forget_leaf()
        # The progress row stands from the start: the model first has to call the tool
        self._compaction = CompactionProgress(trigger="tool", requested=True)
        self._enter_busy()
        self._app.render()
        # Its calls are billed like a compaction's summary: in ↑ ↓ and the cost, not in ctx
        config = {**config, "callbacks": [CompactionWatcher(self._on_compaction),
                                          UsageOnlyHandler(self._count_side_usage)]}

        def _work() -> None:
            summary = ""
            outcome = ""
            err: BaseException | None = None
            try:
                result = self._agent.invoke(
                    {"messages": [HumanMessage(
                        content=compact_prompt(hint=hint),
                        additional_kwargs={"circle_internal": "compact"},
                    )]},
                    config=config,
                )
                if result.get("__interrupt__"):
                    raise RuntimeError("A tool call needs approval · compacting stopped · handle it in the normal conversation")
                out_msgs = result.get("messages") or []
                # What the compaction tool itself said, not the model's account of it
                outcome = next((str(m.content) for m in reversed(out_msgs)
                                if getattr(m, "type", "") == "tool"
                                and getattr(m, "name", "") == "compact_conversation"), "")
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
                # The compaction's own line came with its done or failed step; a row still up
                # means it never got that far (no tool call, nothing to compact, an error)
                reported = self._compaction is None
                self._compaction = None
                self._footer.update(context_input_tokens=None)
                if err is not None:
                    self._leave_busy()
                    self._transcript.append_message(
                        _error_line(f"Compact failed: {_format_llm_error(err)}")
                    )
                    self._app.render()
                    return
                self._footer.set_toast(None)
                self._leave_busy()
                if outcome.startswith("Conversation compacted"):
                    done = outcome.removeprefix("Conversation compacted. ").rstrip(".")
                    head = [] if reported else [" " + _faint(f"— compacted · {done.lower()} —")]
                    self._notice(head + [f" {line}" for line in summary.splitlines() if summary])
                elif outcome.startswith("Nothing to compact"):
                    self._flash("Nothing to compact yet · the conversation fits in the context", 4.0)
                elif reported:
                    pass  # the compaction failed and said so already
                else:
                    self._fail("Not compacted: the model did not run the compaction"
                               + (f" · it said: {summary.splitlines()[0][:80]}" if summary else ""))
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
            self._flash("Usage: /plan [on|off]")
            return
        if want == self._plan_mode:
            self._flash(f"Read-only is already {'on' if want else 'off'}")
            return
        self._plan_mode = want
        try:
            self._rebuild_agent()
            self._inject(plan_boundary_message(enabled=want))
        except Exception as exc:  # noqa: BLE001
            self._plan_mode = not want
            self._fail(f"Could not switch read-only: {exc}")
            return
        if want:
            self._toast("Read-only on · writes and shell are blocked, /plan.md is allowed")
        else:
            self._toast("Read-only off")

    def _cmd_skill(self, args: str) -> None:
        from circle.skills import (
            discover_skills,
            format_skills_slash_list,
            load_skill_body,
        )

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
            self._fail(body)
            return
        try:
            self._inject(skill_boundary_message(name=name, body=body, args=skill_args))
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not load skill: {exc}")
            return
        suffix = f" args={skill_args!r}" if skill_args else ""
        self._toast(f"Loaded skill `{name}`{suffix}")

    def _cmd_tree(self, args: str) -> None:
        """/tree, or /tree <words> to open it searching for them."""
        self._open_tree((args or "").strip())

    def _cmd_fork(self, args: str) -> None:
        """A new session from a message. From a reply: everything up to it. From your own
        message: everything before it, with that message back in the box to change."""
        token = (args or "").strip()
        node = self._session_tree.nodes.get(token) if token else None
        if node is None:
            self._open_fork_picker(token)  # /fork <words> searches the picker
            return
        if node.role == "user":
            forked = (self._session_tree.fork_from(node.parent_id) if node.parent_id
                      else None) or SessionTree()
        else:
            forked = self._session_tree.fork_from(token) or SessionTree()
        turns = sum(1 for item in forked.path_to() if item.role == "user")
        messages = self._branch_into(forked, turns, "fork")
        if node.role == "user":
            # Your message comes back to change and send again, pastes and all
            sent = [m for m in messages if is_user_message(m)]
            text, pastes = draft_of(sent[turns]) if turns < len(sent) else (node.text, {})
            self._prompt.restore_draft(text.replace("\n", "↵"), pastes)
        self._toast(f"Forked from {token} → {self._thread_id}")

    def _cmd_clone(self, _args: str) -> None:
        self._branch_into(self._session_tree.clone_active(), None, "clone")
        self._toast(f"Cloned this branch → {self._thread_id}")

    # ── background agents' approvals and questions ────────────────────────────

    def _host_background_agents(self) -> None:
        """This session answers background agents that stop for approval or a question."""
        tasks = getattr(self._agent, "_circle_background_tasks", None)
        if tasks is not None:
            tasks.host = self
            tasks.on_usage = self._add_job_usage

    def _add_job_usage(self, usage: dict[str, Any], cost: dict[str, Any]) -> None:
        """A background agent's model use counts in the session's meters (and its cost)."""
        self._footer.add_job_usage(usage, cost)
        if self._connected:
            self._app.render()

    def ask(self, job: Any, interrupts: list[Any], answer: Callable[[Any], None]) -> None:
        """A background agent stopped for approval or a question (from its own thread)."""
        approvals: list[tuple[str, dict[str, Any]]] = []
        asks: list[tuple[str, dict[str, Any]]] = []
        order: list[str] = []
        for item in interrupts:
            iid = str(getattr(item, "id", "") or "")
            value = getattr(item, "value", item)
            order.append(iid)
            if isinstance(value, dict) and isinstance(value.get("action_requests"), list):
                approvals.extend((iid, dict(r)) for r in value["action_requests"]
                                 if isinstance(r, dict))
            elif isinstance(value, dict) and value.get("kind") == "ask_user":
                asks.append((iid, value))
            else:
                asks.append((iid, {"questions": []}))
        label = f"{job.id} {job.title.split(' · ', 1)[0]}"
        with self._app.lock:
            self._job_rounds.append(_JobRound(
                job=job, label=label, answer=answer, order=order, approvals=approvals,
                asks=asks, decisions={iid: [] for iid in order}, replies={}))
            self._pump_job_rounds()
            self._app.render()

    def withdraw(self, job: Any) -> None:
        """A background agent waiting for an answer was stopped: its card goes."""
        with self._app.lock:
            self._job_rounds = [r for r in self._job_rounds if r.job.id != job.id]
            current = self._job_card
            if current is not None and current.job.id == job.id:
                self._exec_approval = None
                self._ask_session = None
                self._prompt.clear()
                self._after_job_card()
            self._app.render()

    def _pump_job_rounds(self) -> None:
        """Show a background agent's next question once no card is up and the turn's own
        cards are answered; answer the agent when its round is complete."""
        with self._app.lock:
            if (self._job_card is not None or self._exec_approval is not None
                    or self._ask_session is not None or self._approval_queue
                    or self._ask_queue or self._gate is not None):
                return
            while self._job_rounds:
                rnd = self._job_rounds[0]
                if rnd.approvals:
                    iid, req = rnd.approvals[0]
                    name = str(req.get("name") or "tool")
                    args = req.get("args") or {}
                    if self._approvals.yolo_enabled(rnd.job.thread_id):
                        rnd.approvals.pop(0)
                        rnd.decisions[iid].append({"type": "approve"})
                        continue
                    if self._plan_mode and name in _PLAN_BLOCKED_TOOLS:
                        path = str(args.get("file_path") or args.get("path") or "")
                        if name != "write_file" or Path(path).name.lower() not in {"plan.md", "plan"}:
                            rnd.approvals.pop(0)
                            rnd.decisions[iid].append({"type": "reject", "message": (
                                "Plan mode is active: the user's session is read-only.")})
                            continue
                    if self._defer_card_while_typing(self._pump_job_rounds):
                        return
                    review = self._approvals.review(name, args)
                    backend = getattr(self._agent, "_circle_backend", None)
                    resolve = getattr(backend, "_resolve_path", None)
                    self._job_card = rnd
                    self._park_draft()
                    self._exec_approval = ExecApprovalSession({
                        "tool": name,
                        "title": name,
                        "origin": rnd.label,
                        "body": _approval_body(name, args),
                        "preview": approval_preview(name, args,
                                                    resolve if callable(resolve) else None),
                        "policy": review.reason,
                        "allow_always": review.allow_always,
                        "warn_delete": review.warn_delete,
                        "scope": review.scope,
                        "prefix_scope": review.prefix_scope,
                        "more": len(rnd.approvals) - 1,
                        "tint": tool_type_bg_sgr(name),
                    }, render=self._render_exec_approval, on_finish=self._finish_exec_approval)
                    self._render_exec_approval()
                    return
                if rnd.asks:
                    iid, value = rnd.asks[0]
                    questions = [q for q in value.get("questions") or () if isinstance(q, dict)]
                    if not questions:
                        rnd.asks.pop(0)
                        rnd.replies[iid] = {"answers": []}
                        continue
                    if self._defer_card_while_typing(self._pump_job_rounds):
                        return
                    self._job_card = rnd
                    self._park_draft()
                    self._ask_session = AskUserSession(questions, render=self._render_ask_user,
                                                       on_answer=self._finish_job_question,
                                                       origin=rnd.label)
                    self._render_ask_user()
                    return
                self._job_rounds.pop(0)
                self._answer_round(rnd)

    def _answer_round(self, rnd: _JobRound) -> None:
        replies = {iid: rnd.replies.get(iid, {"decisions": rnd.decisions.get(iid, [])})
                   for iid in rnd.order}
        value = replies[rnd.order[0]] if len(rnd.order) == 1 else replies
        try:
            rnd.answer(value)
        except Exception:  # noqa: BLE001 - the agent has ended meanwhile
            logger.debug("could not answer %s", rnd.job.id, exc_info=True)

    def _finish_job_approval(self, decision: dict) -> None:
        """A background agent's approval card was answered: the rule goes to its
        conversation, a rejection (and why) back to the agent."""
        rnd = self._job_card
        if rnd is not None and rnd.approvals:
            iid, req = rnd.approvals.pop(0)
            key = str(decision.get("decision") or "reject")
            message = str(decision.get("message") or "")
            name = str(req.get("name") or "tool")
            approved = self._approvals.remember(rnd.job.thread_id, name, req.get("args") or {},
                                                key)
            reason = REJECTED_BY_USER + (f" The user said: {message}" if message else "")
            rnd.decisions[iid].append({"type": "approve"} if approved
                                      else {"type": "reject", "message": reason})
        self._after_job_card()

    def _finish_job_question(self, answers: list[list[str]] | None) -> None:
        with self._app.lock:
            session, self._ask_session = self._ask_session, None
            self._prompt.clear()
            rnd = self._job_card
            if session is not None:
                self._toast(_strip_ansi(session.result_summary()).strip())
            if rnd is not None and rnd.asks:
                iid, _value = rnd.asks.pop(0)
                rnd.replies[iid] = {"answers": answers} if answers is not None else {"cancelled": True}
            self._after_job_card()

    def _after_job_card(self) -> None:
        """The turn's own cards go first, then the next background question; with no card
        left the draft comes back."""
        with self._app.lock:
            self._job_card = None
            if self._approval_queue:
                self._next_approval()
            elif self._ask_queue and self._ask_session is None:
                self._begin_ask_user(self._ask_queue)
            else:
                self._pump_job_rounds()
            if (self._job_card is None and self._exec_approval is None
                    and self._ask_session is None):
                self._restore_draft()
            self._app.render()

    # ── background jobs ─────────────────────────────────────────────────────

    def _can_wake_for_jobs(self) -> bool:
        """Nothing runs and nothing waits for you: a finished job may start a turn."""
        return (self._connected and self._agent is not None and self._gate is None
                and not self._is_loading and not self._bridge.is_running
                and not self._msg_queue and not self._jobs_hold
                and self._exec_approval is None and not self._approval_queue
                and self._ask_session is None and not self._ask_queue
                and self._secret_entry is None and self._login is None
                and not self._leaf_checkpoint and self._notice_streak < _NOTICE_STREAK_MAX)

    def _maybe_wake_for_jobs(self) -> None:
        """Called by the run loop: a job the model started has ended while nothing runs,
        so a turn starts with its notice; output of a !command that ended in the background
        joins the conversation."""
        if self._shell_shares:
            self._flush_shell_shares()
        if not self._jobs.has_notices(self._thread_id):
            return
        with self._app.lock:
            if not self._can_wake_for_jobs() or not self._jobs.notice_ready(self._thread_id):
                return
            notices = self._jobs.take_notices(self._thread_id)
            if notices:
                self._start_notice_turn(notices)

    def _start_notice_turn(self, notices: list[Any]) -> None:
        """A turn that starts with Circle's notice of finished jobs, shown as one row per
        job instead of a message of yours."""
        message = notice_message(notices)
        self._notice_streak += 1
        self._push_undo_checkpoint()
        self._transcript.ensure_block_gap()
        self._transcript.append_messages(notice_rows(message.additional_kwargs[NOTICE_MARKER]))
        self._transcript.ensure_block_gap()
        self._open_turn_region()
        self._turn_elapsed = 0.0
        self._turn_started_at = time.time()
        self._enter_busy()
        self._call_started_at = time.time()
        self._app.render()
        self._extensions.emit("turn_start", {"text": "",
                                             "job_notice": [n.job.id for n in notices]})
        self._bridge.start_notice(message)

    def _on_job_event(self, event: str, job: Any) -> None:
        """A background job started, changed or ended (on the registry's thread)."""
        if event == "started":
            self._ensure_job_ticker()
        self._refresh_jobs_picker()
        if event != "ended" or job.reason == "circle exited":
            if self._connected:
                self._app.render()
            return
        with self._app.lock:
            outcome = (f"{job.id} {outcome_words(job.status, job.exit_code, job.reason)}"
                       f" · {format_elapsed(job.elapsed())}")
            if job.started_by == "user":
                command, quiet, thread = self._user_jobs.pop(job.id, (job.title, True, ""))
                self._toast(outcome)
                if not quiet and job.output_path and job.status != "stopped":
                    output, _cut = read_head(job.output_path, 100_000)
                    result = ExecuteResponse(output=output or "<no output>",
                                             exit_code=job.exit_code)
                    self._shell_shares.append((thread, command, result))
            elif job.reason == "stopped by user":
                self._toast(f"{job.id} stopped")
            elif job.thread_id != self._thread_id and job.reason != "stopped by model":
                self._toast(f"{outcome} · {job.title} · in another conversation")
            self._app.render()

    def _ensure_job_ticker(self) -> None:
        """While jobs run, repaint twice a second: their lamps blink and their clocks go on
        when nothing else is drawing."""
        if self._job_ticker is not None and self._job_ticker.is_alive():
            return

        def tick() -> None:
            while self._app._running and self._jobs.live():
                if self._detail_active and str(self._detail_uuid or "").startswith("job:"):
                    with self._app.lock:
                        self._render_agent_detail(force=True)
                self._app.render()
                time.sleep(0.5)
            if self._app._running:
                self._app.render()

        self._job_ticker = threading.Thread(target=tick, name="circle-job-ticker", daemon=True)
        self._job_ticker.start()

    def _move_to_background(self) -> None:
        """ctrl+b: every command being waited on goes on as a background job."""
        moved = self._jobs.detach_foreground()
        if moved:
            self._flash("Moved to the background" if moved == 1
                        else f"{moved} commands moved to the background")
        elif self._is_loading and running_cards(self._last_snap):
            self._flash("Subagents can't move to the background")
        else:
            self._flash("Nothing to move")

    def _cmd_jobs(self, args: str) -> None:
        """/jobs — this session's background jobs: enter opens one, ctrl+d stops a running
        one (after a question) or forgets one that has ended."""
        def rows() -> list[PickerItem]:
            items = []
            jobs = self._jobs.list()
            for job in [j for j in jobs if j.running] + [j for j in reversed(jobs)
                                                           if not j.running]:
                if job.running:
                    state = ("waiting for you" if job.status == "waiting"
                             else f"running · {format_elapsed(job.elapsed())}")
                else:
                    state = (f"{outcome_words(job.status, job.exit_code, job.reason)}"
                             f" · {format_elapsed(job.elapsed())}")
                if job.thread_id and job.thread_id != self._thread_id:
                    state += " · other session"
                items.append(PickerItem(key=job.id, label=f"{job.id} {job.title}", meta=state,
                                        search=f"{job.kind} {job.source}"))
            return items

        def pick(item: PickerItem) -> None:
            self._close_picker()
            self._enter_job_page(item.key)

        def stop(item: PickerItem | None) -> None:
            job = self._jobs.get(item.key) if item is not None else None
            if job is None:
                return
            if not job.running:
                self._jobs.forget(job.id)
                picker.set_items(rows())
                return

            def done() -> None:
                self._jobs.stop(job.id, by="user")
                picker.set_items(rows())

            picker.confirm(f"Stop {job.id} {job.title[:40]}?", done)

        def close() -> None:
            self._jobs_picker = None
            self._close_picker()

        picker = Picker(title="Background jobs", items=rows(), on_pick=pick, on_close=close,
                        render=self._render_picker, keys={"ctrl+d": stop},
                        hint="enter opens · ctrl+d stops", empty="No jobs")
        self._jobs_picker = (picker, rows)
        self._open_picker(picker)

    def _refresh_jobs_picker(self) -> None:
        open_list = self._jobs_picker
        if open_list is None or self._picker is not open_list[0]:
            return
        picker, rows = open_list
        with self._app.lock:
            if not picker.asking:
                picker.set_items(rows())
        self._render_picker()

    def _enter_job_page(self, job_id: str) -> None:
        """A job's page in place of the transcript: its band and the end of its output,
        refreshed while it runs; esc goes back."""
        if self._jobs.get(job_id) is None:
            return
        target = f"job:{job_id}"
        self._detail_active = True
        self._detail_ids = [target]
        self._detail_uuid = target
        self._strip_selecting = False
        self._strip_selected = None
        self._set_view_visible(self._transcript.node, False)
        self._set_view_visible(self._agent_detail.node, True)
        self._set_view_visible(self._agent_detail_band, True)
        self._agent_detail.clear()
        self._detail_drawn = None
        self._render_agent_detail(force=True)
        self._sync_agent_strip()
        self._app.render()

    def _render_job_page(self) -> None:
        job = self._jobs.get(str(self._detail_uuid)[4:])
        view = self._agent_detail
        self._detail_buttons = []
        if job is None:
            self._agent_detail_band.style.height = 0
            self._agent_detail_band_text.set_value("")
            view.clear()
            view.append_message(" " + _faint("This job is no longer listed."))
            return
        band = render_job_band(job, width=max(20, self._app.width or 80))
        self._agent_detail_band.style.height = len(band)
        self._agent_detail_band_text.set_value("\n".join(band))
        rows = job_log_rows(job)
        sticky, top = view.node.sticky_scroll, view.node.scroll_top
        view.restore(rows, [None] * len(rows))
        if not sticky:
            view.node.sticky_scroll = False
            view.node.scroll_top = min(top, view.max_top())

    def _flush_shell_shares(self) -> None:
        """Output of !commands that ended in the background goes into their conversation
        once no turn runs there."""
        with self._app.lock:
            if self._is_loading or self._bridge.is_running:
                return
            shares, self._shell_shares = self._shell_shares, []
            for thread, command, result in shares:
                if thread == self._thread_id:
                    self._share_shell_output(command, result)
                else:
                    self._shell_shares.append((thread, command, result))

    def _stop_jobs_at_exit(self) -> int:
        """Circle is leaving: stop every job, and tell each conversation that had some, so
        the model knows when the conversation is opened again."""
        live = [job for job in self._jobs.list() if job.running]
        if not live and not self._jobs.notice_threads():
            return 0
        stopped = self._jobs.stop_all()
        threads = {job.thread_id for job in live if job.started_by == "model"}
        threads |= set(self._jobs.notice_threads())
        for thread in sorted(t for t in threads if t):
            ended = [job for job in live if job.thread_id == thread and job.started_by == "model"]
            pending = self._jobs.take_notices(thread)
            if thread == self._thread_id and self._leaf_checkpoint:
                continue
            lines = []
            if ended:
                lines.append("Circle exited and stopped these background jobs:")
                lines.extend(f"{job.id} · {job.kind} · {job.title}" for job in ended)
            lines.extend(n.text for n in pending)
            text = ('<system-reminder data-source="circle-jobs">\n' + "\n".join(lines)
                    + "\nThis notice comes from Circle, not from the user.\n</system-reminder>")
            try:
                append_messages(self._agent, {"configurable": {"thread_id": thread}},
                                [HumanMessage(content=text,
                                              additional_kwargs={"circle_internal": "job_exit"})])
            except Exception:  # noqa: BLE001 - leaving must not fail on this
                logger.debug("could not note stopped jobs in %s", thread, exc_info=True)
        return stopped

    # ── the conversation tree ───────────────────────────────────────────────

    def _inject(self, message: Any) -> None:
        """Add a message to the conversation without a turn (a skill, a mode change, a
        !command's output), after the point /tree went back to when there is one."""
        config: dict[str, Any] = {"configurable": {"thread_id": self._thread_id}}
        if self._leaf_checkpoint:
            config["configurable"]["checkpoint_id"] = self._leaf_checkpoint
        append_messages(self._agent, config, [message])
        self._forget_leaf()

    def _write_history(self, thread_id: str, messages: list[Any]) -> None:
        write_history(self._agent, thread_id, messages)

    def _forget_leaf(self) -> None:
        self._leaf_checkpoint = None
        try:
            session_index.set_leaf(self.home, self._thread_id, None)
        except Exception:  # noqa: BLE001
            logger.debug("could not clear the leaf", exc_info=True)

    def _conversation_tree(self):
        """The tree of this conversation; what was read before is kept, per conversation,
        so /tree and esc esc stay quick in a long session."""
        from circle.tui.conversation_tree import TreeBuilder

        builders = getattr(self, "_tree_builders", None)
        if builders is None:
            builders = self._tree_builders = {}
        builder = builders.setdefault(self._thread_id, TreeBuilder())
        builder.update(self._agent, self._thread_id)
        return builder.tree(self._agent, self._thread_id, self._leaf_checkpoint)

    def _open_tree(self, search: str = "") -> None:
        """/tree (or esc esc): every message of this session, all branches. enter goes back
        to the chosen point; your next message then starts a branch from there."""
        try:
            tree = self._conversation_tree()
        except Exception as exc:  # noqa: BLE001
            logger.warning("could not read the tree", exc_info=True)
            self._fail(f"Could not read this session's history: {exc}")
            return
        if not tree.entries:
            self._flash("Nothing in this session yet")
            return
        state = {"mine_only": False}
        marks = session_index.labels(self.home, self._thread_id)

        def rows() -> list[PickerItem]:
            on_path = set(tree.path_to(tree.leaf))
            items = []
            for key, depth in tree.walk():
                entry = tree.entries[key]
                if state["mine_only"] and entry.role != "user":
                    continue
                parent = tree.entries.get(entry.parent)
                fork = parent is not None and len(parent.children) > 1
                lead = "  " * max(0, depth - (1 if fork else 0)) + ("├ " if fork else "")
                mark = "›" if entry.role == "user" else "⏺"
                text = row_text(entry.text)
                label = f"[{marks[key]}] " if key in marks else ""
                items.append(PickerItem(
                    key=key, label=f"{lead}{mark} {label}{text}",
                    meta="here" if key == tree.leaf else ("·" if key in on_path else ""),
                    search=marks.get(key, ""), current=key == tree.leaf))
            return items

        def pick(item: PickerItem) -> None:
            self._close_picker()
            self._go_back_to(tree, tree.entries[item.key])

        def mine(_item: PickerItem | None) -> None:
            state["mine_only"] = not state["mine_only"]
            picker.set_items(rows())

        def label(item: PickerItem | None) -> None:
            if item is None:
                return

            def done(text: str) -> None:
                session_index.set_label(self.home, self._thread_id, item.key, text)
                marks.clear()
                marks.update(session_index.labels(self.home, self._thread_id))
                picker.set_items(rows())

            picker.ask("Label (empty removes it)", marks.get(item.key, ""), done)

        picker = Picker(
            title="Session tree", items=rows(), on_pick=pick, on_close=self._close_picker,
            render=self._render_picker, focus_key=tree.leaf,
            keys={"ctrl+u": mine, "L": label}, rows=14,
            hint="enter goes back there · L labels · ctrl+u only your messages")
        if search:
            picker.search(search)
        self._open_picker(picker)

    def _go_back_to(self, tree: Any, entry: Any) -> None:
        if self._bridge.is_running or self._is_loading:
            self._cmd_stop_for_tree()
        if entry.key == tree.leaf and entry.role != "user":
            self._flash("Already here")
            return
        draft, pastes = "", {}
        if entry.role == "user":
            sent = next((m for m in self._saved_messages(self._thread_id, entry.resume_from or None)
                         if str(getattr(m, "id", "")) == entry.key), None)
            message = sent or self._find_message(entry.key)
            draft, pastes = draft_of(message) if message is not None else (entry.text, {})
        if entry.resume_from == "":
            self._flash("This point cannot be returned to (a turn stopped there on a card)")
            return
        if entry.resume_from is None:
            # Before the first message: a fresh branch, the original stays in /resume
            self._branch_into(SessionTree(), 0, "branch")
        else:
            self._leaf_checkpoint = entry.resume_from
            try:
                session_index.set_leaf(self.home, self._thread_id, entry.resume_from)
            except Exception:  # noqa: BLE001
                logger.debug("could not save the leaf", exc_info=True)
            messages = self._saved_messages(self._thread_id, entry.resume_from)
            self._reset_turn_regions()
            self._transcript.clear()
            self._show_welcome()
            self._replay(messages)
        if draft:
            self._prompt.restore_draft(draft.replace("\n", "↵"), pastes)
        what = "before your message" if entry.role == "user" else "after that answer"
        self._toast(f"Back {what} · your next message starts a new branch · "
                    "/tree shows them all")
        self._app.render()

    def _find_message(self, message_id: str) -> Any:
        for snap in self._agent.get_state_history({"configurable": {"thread_id": self._thread_id}}):
            for msg in (snap.values or {}).get("messages") or []:
                if str(getattr(msg, "id", "")) == message_id:
                    return msg
        return None

    def _cmd_stop_for_tree(self) -> None:
        """Going back stops the running turn first, as esc would."""
        with self._app.lock:
            self._stop_shell_command()
            self._bridge.cancel()
            self._settle_inbox()
            self._dismiss_user_panels()
            self._notice([_stop_line()])
            self._leave_busy()

    def _open_fork_picker(self, search: str = "") -> None:
        """/fork: pick one of your messages; a new session gets everything before it, and
        the message comes back to the box."""
        try:
            tree = self._conversation_tree()
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not read this session's history: {exc}")
            return
        mine = [(key, tree.entries[key]) for key, _depth in tree.walk()
                if tree.entries[key].role == "user"]
        if not mine:
            self._flash("No message to fork from yet")
            return
        items = [PickerItem(key=key, label=row_text(entry.text), meta=f"{i}/{len(mine)}")
                 for i, (key, entry) in enumerate(mine, 1)]

        def pick(item: PickerItem) -> None:
            self._close_picker()
            entry = tree.entries[item.key]
            if entry.resume_from == "":
                self._flash("This message cannot be forked from (a turn stopped there on a card)")
                return
            message = self._find_message(entry.key)
            before = (self._saved_messages(self._thread_id, entry.resume_from)
                      if entry.resume_from else [])
            self._branch_into(SessionTree(), None, "fork", messages=before)
            if message is not None:
                text, pastes = draft_of(message)
                self._prompt.restore_draft(text.replace("\n", "↵"), pastes)
            self._toast(f"Forked → {self._thread_id} · your message is back in the box")

        picker = Picker(
            title="Fork from a message", items=items, on_pick=pick, on_close=self._close_picker,
            render=self._render_picker, focus_key=mine[-1][0],
            hint="a new session with everything before it; the message comes back to edit")
        if search:
            picker.search(search)
        self._open_picker(picker)

    def _branch_into(self, tree: SessionTree, turns: int | None, kind: str,
                     messages: list[Any] | None = None) -> list[Any]:
        """Start a new session that carries the model's history of the first ``turns``
        turns (all of them when None), and draw it. Returns the old session's messages."""
        self._archive_current()
        old_thread = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._session_tree = tree
        carried: list[Any] = []
        given = messages is not None
        if messages is None:
            messages = self._saved_messages(old_thread, self._leaf_checkpoint)
        self._leaf_checkpoint = None
        try:
            carried = messages if (turns is None or given) else first_turns(messages, turns)
            if carried:
                self._write_history(self._thread_id, carried)
        except Exception:  # noqa: BLE001 - the new session still works, only without history
            logger.warning("could not carry the history into the %s", kind, exc_info=True)
            self._fail(f"The {kind} starts without the earlier messages · see logs/circle.log")
            carried = []
        self._bridge = self._make_bridge()
        self._session_title = (self._session_title or "session") + f" ({kind})"
        self._reset_turn_regions()
        self._transcript.clear()
        self._show_welcome()
        if carried:
            self._replay(carried)
            self._remember_session()
        self._app.render()
        return messages

    def _cmd_thinking(self, args: str) -> None:
        if args.strip():
            self._cmd_effort(args)  # /thinking high, as in pi
            return
        self._show_thinking = not self._show_thinking
        self._rerender_turns()
        state = "shown" if self._show_thinking else "hidden"
        self._flash(f"Thinking {state}", 1.2)

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
            self._flash("Nothing to undo")
            return
        self._redo_stack.append(self._snapshot_record())
        rec = self._undo_stack.pop()
        self._restore_record(rec)
        self._toast("Undid the last turn")

    def _cmd_redo(self, _args: str) -> None:
        if not self._redo_stack:
            self._flash("Nothing to redo")
            return
        self._undo_stack.append(self._snapshot_record())
        rec = self._redo_stack.pop()
        self._restore_record(rec)
        self._toast("Redid the turn")

    def _cmd_init(self, args: str) -> None:
        """Send the initialize template to the agent to write AGENTS.md."""
        from circle.system_prompt import load_command_prompt

        tmpl = load_command_prompt("initialize")
        if not tmpl:
            self._fail("Missing prompts/commands/initialize.md")
            return
        focus = (args or "").strip() or "(none)"
        prompt = tmpl.replace("$ARGUMENTS", focus)
        # Feed as a normal user turn so the agent writes AGENTS.md via tools.
        self._on_submit(prompt)

    def _cmd_trust(self, _args: str) -> None:
        from circle.trust import accept_trust

        if is_folder_trusted(self.settings, self.workspace):
            self._toast(f"Trusted {self.workspace}")
            return
        auth = self.settings.auth
        self.settings = accept_trust(self._settings_to_save(), self.workspace, home=self.home)
        self.settings.auth = auth
        self._toast(f"Trusted {self.workspace}")

    def _cmd_settings(self, _args: str) -> None:
        """A list of the settings, as pi's /settings: enter changes the marked one, and the
        change is saved at once. Rows that open their own list say so."""
        from circle.settings import DOUBLE_ESCAPE_ACTIONS

        def following(options: tuple[str, ...], current: str) -> str:
            return options[(options.index(current) + 1) % len(options)] if current in options \
                else options[0]

        def rows() -> list[PickerItem]:
            auth = self.settings.auth
            depth = self._current_thinking() or "default"
            return [
                PickerItem("theme", "theme", self.settings.theme),
                PickerItem("thinking", "show thinking", "on" if self._show_thinking else "off"),
                PickerItem("double_escape", "esc esc opens", self.settings.double_escape),
                PickerItem("model", "model", f"{auth.model} · /models"),
                PickerItem("depth", "thinking depth", f"{depth} · /effort"),
                PickerItem("endpoint", "endpoint", f"{auth.protocol} · {auth.base_url or '—'}"),
                PickerItem("trusted", "trusted folders", str(len(self.settings.trusted_folders))),
                PickerItem("mcp", "mcp servers", f"{len(self.settings.mcp_servers)} · /mcp"),
                PickerItem("home", "data folder", _short_path(str(self.home))),
            ]

        def change(item: PickerItem) -> None:
            key = item.key
            if key == "theme":
                self._cmd_themes(following(THEME_CHOICES, self.settings.theme))
            elif key == "thinking":
                self._show_thinking = not self._show_thinking
                self.settings.hide_thinking = not self._show_thinking
                self._save_settings("hide_thinking")
                self._rerender_turns()
            elif key == "double_escape":
                self.settings.double_escape = following(DOUBLE_ESCAPE_ACTIONS,
                                                        self.settings.double_escape)
                self._save_settings("double_escape")
            elif key == "model":
                self._close_picker()
                self._open_model_picker()
                return
            elif key == "depth":
                self._close_picker()
                self._open_thinking_picker()
                return
            elif key == "mcp":
                self._close_picker()
                self._dispatch_slash("mcp", "")
                return
            elif key == "endpoint":
                self._close_picker()
                self._open_login_picker()
                return
            else:
                return
            picker.set_items(rows())
            self._render_picker()

        picker = Picker(title="Settings", items=rows(), on_pick=change,
                        on_close=self._close_picker, render=self._render_picker,
                        hint="enter changes it, saved at once · esc closes")
        self._open_picker(picker)

    def _cmd_themes(self, args: str) -> None:
        name = args.strip().lower()
        if name == "terminal":  # the old name of auto
            name = "auto"
        if not name:
            self._toast(f"Theme: {self.settings.theme} · available: {', '.join(THEME_CHOICES)}")
            return
        if name not in THEME_CHOICES:
            self._fail(f"Unknown theme {name!r} · available: {', '.join(THEME_CHOICES)}")
            return
        self.settings.theme = name
        self._save_settings("theme")
        pal = self._apply_theme()
        shown = "dark" if pal.is_dark else "light"
        self._toast(f"Theme → {name}" if name != "auto" else f"Theme → auto ({shown})")

    def _apply_theme(self):
        """Make the palette follow ``settings.theme``: repaint, and listen to the terminal only
        while the theme is ``auto``."""
        pal = self._repaint_theme()
        auto = normalize_theme(self.settings.theme) == "auto"
        self._theme_watch.set_mode(self.settings.theme)
        self._app.set_color_scheme_reports(auto)
        return pal

    def _repaint_theme(self):
        pal = apply_theme(self.settings.theme)
        self._app.style_pool.set_selection_bg([pal.sel_bg])
        self._footer.apply_palette()
        if self._picker is not None:  # its rows carry the colours they were drawn in
            self._ask_panel.update(self._picker.render_lines(max(20, self._app.width or 80)))
        self._app._force_full_render()
        return pal

    def _on_terminal_theme_change(self) -> None:
        """The terminal switched between dark and light (or changed its colours) under us."""
        was_dark = palette().is_dark
        pal = self._repaint_theme()
        logger.info("terminal colours changed: %s background %s",
                    "dark" if pal.is_dark else "light", pal.bg_hex)
        if pal.is_dark != was_dark:
            self._flash(f"Theme → {'dark' if pal.is_dark else 'light'}")

    def _cmd_mcp(self, args: str) -> None:
        token = (args or "").strip().lower()
        if token in {"reload", "refresh", "connect"}:
            if self._bridge.is_running or self._is_loading:
                self._footer.set_toast("Busy · reload MCP after the current turn")
                return
            try:
                self._rebuild_agent()
            except Exception as exc:  # noqa: BLE001
                self._fail(f"MCP reload failed: {exc}")
                return
            self._toast(f"MCP reloaded · {len(self._mcp_tools)} tools")
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
                self._flash("Usage: /approvals revoke <number>")
                return
            rule = store.revoke(self._thread_id, int(parts[1]) - 1)
            if rule is None:
                self._flash(f"No rule number {parts[1]}")
                return
            self._toast(f"Revoked · {rule.get('tool')} · {rule.get('label')}")
        rules = store.rules(self._thread_id)
        lines = ["Always-allow rules this session:" if rules else "No always-allow rules this session."]
        for i, rule in enumerate(rules, 1):
            lines.append(f"  {i}. {rule.get('tool')} · {rule.get('label') or rule.get('pattern')}")
        recent = store.log(self._thread_id)[-5:]
        if recent:
            names = {"once": "allowed once", "always": "allowed for session", "reject": "rejected",
                     "revoke": "revoked"}
            lines.append("Recent approvals:")
            for entry in recent:
                lines.append(f"  {names.get(str(entry.get('kind')), entry.get('kind'))} · "
                             f"{entry.get('tool')}")
        if rules:
            lines.append("Revoke one: /approvals revoke <number>")
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
                self._fail(f"Extension reload failed: {exc}")
                return
            self._toast(f"Extensions reloaded · {len(self._extensions.tool_specs())} tools")
        for line in self._extensions.describe():
            self._transcript.append_message(f" {_faint(line)}")
        self._app.render()

    def _cmd_name(self, args: str) -> None:
        title = args.strip()
        if not title:
            self._toast(f"Session name: {self._session_title}")
            self._flash("/name <title> renames it", 4.0)
            return
        self._session_title = title[:80]
        self._remember_session()
        self._toast(f"Session name → {self._session_title}")

    def _cmd_session(self, _args: str) -> None:
        """What this session is and holds: its id and title, where it is kept, its
        messages, and the tokens this run has used."""
        from langchain_core.messages import AIMessage, ToolMessage

        messages = self._saved_messages(self._thread_id, self._leaf_checkpoint)
        mine = sum(1 for m in messages if is_user_message(m))
        answers = [m for m in messages if isinstance(m, AIMessage)]
        calls = sum(len(m.tool_calls or []) for m in answers)
        results = sum(1 for m in messages if isinstance(m, ToolMessage))
        depth = reasoning_effort_of(getattr(self, "_chat_model", None))
        model = self.settings.auth.model + (f" • {depth}" if depth in EFFORT_LEVELS else "")
        kept = ("in memory only (--no-session)" if self._run_options.no_session
                else f"{_short_path(str(self.home / 'checkpoints.sqlite'))}")
        if self._leaf_checkpoint:
            kept += " · at a point /tree went back to"
        used = self._footer.usage_totals()
        cached = (f" · {used['cached'] / used['input']:.0%} cached"
                  if used["input"] and used["cached"] else "")
        rows = [
            f"session  {self._thread_id}"
            + ("" if self._session_title == "new" else f" · {self._session_title}"),
            f"folder   {_short_path(str(self.workspace))}",
            f"model    {model}",
            f"kept     {kept}",
            f"messages {len(messages)} · {mine} yours · {len(answers)} from the model · "
            f"{calls} tool calls · {results} results",
            f"tokens   ↑ {used['input']:,}{cached} · ↓ {used['output']:,} in this run",
        ]
        if self._share_path:
            rows.append(f"shared   {self._share_path}")
        self._notice([f" {_faint(row)}" for row in rows])
        self._app.render()

    def _clipboard_set(self, text: str) -> bool:
        import shutil
        import subprocess

        if sys.platform == "win32":
            from circle.ink.termio import winconsole

            return winconsole.set_clipboard(text)
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
                if plain and not plain.startswith((">", "›")) and "Circle ·" not in plain:
                    text = plain
                    break
        if not text:
            self._flash("No assistant message to copy")
            return
        if self._clipboard_set(text):
            self._flash(f"Copied {len(text)} chars")
        else:
            path = self.home / "exports" / "last-copy.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text + "\n", encoding="utf-8")
            self._toast(f"No clipboard tool · wrote {path}")

    def _write_markdown_export(self, path: Path) -> None:
        stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
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
        """/export [html|jsonl|md|path]: Markdown of the screen by default; HTML to read in
        a browser; JSONL with every message, for /import."""
        from circle.session_export import SessionMeta, export_kind, to_html, to_jsonl

        ensure_home(self.home)
        stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        raw = args.strip()
        kind = export_kind(raw) if raw else "md"
        if raw and raw.lower() != kind:
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = self.workspace / path
        else:
            path = self.home / "exports" / f"circle-{self._thread_id}-{stamp}.{kind}"
        if kind == "md":
            try:
                self._write_markdown_export(path)
            except OSError as exc:
                self._fail(f"Could not write {path}: {exc.strerror or exc}")
                return
        else:
            messages = self._saved_messages(self._thread_id, self._leaf_checkpoint)
            if not messages:
                self._flash("Nothing to export yet")
                return
            meta = SessionMeta(thread_id=self._thread_id,
                               title="" if self._session_title == "new" else self._session_title,
                               workspace=str(self.workspace), model=self.settings.auth.model)
            text = to_html(messages, meta) if kind == "html" else to_jsonl(messages, meta)
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
            except OSError as exc:
                self._fail(f"Could not write {path}: {exc.strerror or exc}")
                return
        self._toast(f"Exported {path}")

    def _cmd_import(self, args: str) -> None:
        raw = args.strip()
        if not raw:
            self._flash("Usage: /import <file.jsonl or file.md>")
            return
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = self.workspace / path
        if not path.is_file():
            alt = self.home / "exports" / raw
            path = alt if alt.is_file() else path
        if not path.is_file():
            self._fail(f"No such file: {raw}")
            return
        try:
            body = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            self._fail(f"{path.name} is not a text file")
            return
        except OSError as exc:
            self._fail(f"Could not read {path}: {exc.strerror or exc}")
            return
        if path.suffix.lower() == ".jsonl":
            self._import_jsonl(path, body)
            return
        self._push_undo_checkpoint()
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._leaf_checkpoint = None
        self._bridge = self._make_bridge()
        self._session_title = path.stem[:60]
        lines = [f" {ln}" if ln else "" for ln in body.splitlines()]
        self._reset_turn_regions()
        self._transcript.restore(lines)
        try:
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
            self._fail(f"Imported for display, but saving to the checkpointer failed: {exc}")
            return
        self._toast(f"Imported {path}")

    def _import_jsonl(self, path: Path, body: str) -> None:
        """A JSONL export comes back as a new session with every message, so the model
        remembers it exactly and /tree, /fork and ctrl+o work on it."""
        from circle.session_export import from_jsonl

        try:
            header, messages = from_jsonl(body)
        except ValueError as exc:
            self._fail(f"{path.name} is not a Circle JSONL export: {exc}")
            return
        self._archive_current()
        self._previous_thread_id = self._thread_id
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._leaf_checkpoint = None
        self._session_tree = SessionTree()
        try:
            write_history(self._agent, self._thread_id, messages)
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Could not import {path.name}: {exc}")
            return
        self._bridge = self._make_bridge()
        self._session_title = str(header.get("title") or path.stem)[:60]
        self._reset_turn_regions()
        self._transcript.clear()
        self._show_welcome()
        self._replay(messages)
        self._remember_session()
        self._toast(f"Imported {path} → {self._thread_id}")

    def _cmd_share(self, _args: str) -> None:
        ensure_home(self.home)
        share_dir = self.home / "shares"
        share_dir.mkdir(parents=True, exist_ok=True)
        path = share_dir / f"{self._thread_id}.md"
        self._write_markdown_export(path)
        self._share_path = path
        copied = self._clipboard_set(str(path))
        extra = " · path copied" if copied else ""
        self._toast(f"Local share copy: {path}{extra}")

    def _cmd_unshare(self, _args: str) -> None:
        path = self._share_path
        if path is None:
            candidate = self.home / "shares" / f"{self._thread_id}.md"
            path = candidate if candidate.is_file() else None
        if path is None or not path.is_file():
            self._flash("No active share file")
            return
        try:
            path.unlink()
        except OSError as exc:
            self._fail(f"Delete failed: {exc}")
            return
        self._share_path = None
        self._toast(f"Unshared {path}")

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
            or ("notepad" if sys.platform == "win32" else "")
        )
        if not editor:
            self._fail("No $VISUAL / $EDITOR set, and no nvim, vim or nano found")
            return
        command = _editor_command(editor)
        # The editor gets the draft in full: real line breaks, pastes written out
        initial = self._prompt.model_text(self._prompt.value)
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
                subprocess.run([*command, str(tmp_path)], check=False)
            finally:
                self._app.resume_from_external()
            text = tmp_path.read_text(encoding="utf-8")
        except OSError as exc:
            self._fail(f"Could not open the editor: {exc}")
            return
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
        # Back in the box like a paste: line breaks as ↵, a long text folded again
        self._prompt.clear()
        self._prompt.handle_paste(text.rstrip("\n"))
        self._flash("Loaded from the editor · enter sends")
        self._app.render()

    def _cmd_reload(self, _args: str) -> None:
        from circle.keybindings import load_remap

        self.settings = load_settings(self.home)
        apply_auth_to_environ(self.settings, self.home)
        self._key_remap, self._keybinding_problems = load_remap(self.home)
        for problem in self._keybinding_problems:
            self._fail(problem)
        self._apply_theme()
        self._extensions = self._load_extensions()
        try:
            self._rebuild_agent()
        except Exception as exc:  # noqa: BLE001
            self._fail(f"Reload partly failed: {exc}")
            return
        self._footer.update(model=self.settings.auth.model)
        self._refresh_welcome_data()
        self._toast("Reloaded settings and the model")

    # ── busy / footer ──────────────────────────────────────────────────

    def _sync_model_meter(self) -> None:
        """The footer's ``ctx`` uses the window the compaction uses: the live model's
        ``profile["max_input_tokens"]`` (circle.model.apply_context_window). A model built
        elsewhere (a test's) has none, and the footer looks the name up itself."""
        name = self.settings.auth.model
        chat = getattr(self, "_chat_model", None)
        window = (getattr(chat, "profile", None) or {}).get("max_input_tokens")
        kwargs: dict[str, Any] = {"model": name, "reasoning_effort": reasoning_effort_of(chat)}
        if isinstance(window, int) and not isinstance(window, bool) and window > 0:
            kwargs["tokens_budget"] = window
            kwargs["tokens_budget_known"] = model_catalog.facts(name).window_known
        self._footer.update(**kwargs)

    def _on_models_refreshed(self) -> None:
        """New models.dev data: the live model gets the new window, and the footer with it."""
        with self._app.lock:
            chat = getattr(self, "_chat_model", None)
            if chat is not None and self.model_override is None:
                apply_context_window(chat, self.settings, self.settings.auth.model)
            self._sync_model_meter()
        self._app.render()

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
        if "context_input_tokens" in usage:
            kwargs["context_input_tokens"] = int(usage["context_input_tokens"] or 0)
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
        self._flush_held_notes()

    def _on_status(self, status: str) -> None:
        with self._app.lock:
            if self._bridge._cancelled and status not in {"ready", "cancelled"}:
                return
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
        self._plan_panel.follow()
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
        width = max(20, self._app.width or 80)
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
            previous = self._last_snap
            self._last_snap = snap
            if (previous is None or previous.usage_cost != snap.usage_cost
                    or previous.fork_usage != snap.fork_usage
                    or previous.fork_usage_cost != snap.fork_usage_cost):
                self._sync_usage(snap)
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

    def _sync_usage(self, snap: MessageSnapshot) -> None:
        """The session's totals as the reducer keeps them: the footer's cost, and ↑ ↓ for the
        work outside the main conversation."""
        fork = snap.fork_usage
        self._footer.update(
            main_costs=dict(snap.usage_cost),
            fork_costs=dict(snap.fork_usage_cost),
            fork_input=int(fork.get("input_tokens") or 0),
            fork_output=int(fork.get("output_tokens") or 0),
            fork_cache_hit=int(fork.get("prompt_cache_hit_tokens") or 0),
            fork_cache_write=int(fork.get("prompt_cache_write_tokens") or 0),
            fork_cache_write_1h=int(fork.get("prompt_cache_write_1h_tokens") or 0),
        )

    def _count_side_usage(self, usage: dict, cost: dict, call_id: str) -> None:
        """A /compact call, from its worker thread: into the session's totals and onto the
        footer now, since no turn is drawn to bring a snapshot."""
        reducer = getattr(getattr(self, "_bridge", None), "reducer", None)
        if reducer is None:
            return
        reducer.add_internal_usage(usage, cost, usage_id=call_id)
        with self._app.lock:
            self._sync_usage(reducer.snapshot())
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
            self._settle_inbox()
            self._session_tree.add("assistant", visible)
            cooked = self._cooked_lines(answered=bool(shown or said))
            self._close_turn_region()
            for line in cooked:
                self._transcript.append_message(line)
            self._leave_busy()
            self._app.render()
            self._extensions.emit("turn_end", {"text": visible})
            self._drain_after_worker()

    def _on_error(self, exc: BaseException) -> None:
        with self._app.lock:
            self._pending_calls = []
            self._render_turn_region()
            cooked = self._cooked_lines(answered=True)
            self._close_turn_region()
            for line in cooked:
                self._transcript.append_message(line)
            said = _format_llm_error(exc)
            if _refused_the_key(exc):
                said += " · /login to change the key"
            if any(kind == "fail" for kind, _text in self._held_notes):
                # the compaction's failure is what ended the turn: one red line says both
                self._held_notes = [n for n in self._held_notes if n[0] != "fail"]
                said = f"Compaction failed: {said}"
            self._flush_held_notes()
            self._transcript.append_message(_error_line(said))
            self._settle_inbox()
            self._leave_busy()
            self._app.render()
            self._extensions.emit("turn_end", {"error": _format_llm_error(exc)})
            self._drain_after_worker()

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
        """One usage line (``12s · ↑ 1.2k · ↓ 340``) per user turn (not per approval pause),
        and a red line when the model gave nothing at all."""
        if not self._turn_started_at and not self._turn_elapsed:
            return []
        elapsed, tokens_in, tokens_out = self._turn_totals()
        self._turn_started_at = 0.0
        self._turn_elapsed = 0.0
        pal = palette()
        lines = [(f"   {pal.dim}{format_elapsed(elapsed)} · ↑ {format_tokens(tokens_in)}"
                  f" · ↓ {format_tokens(tokens_out)}{pal.reset}")]
        snap = self._last_snap
        quiet = not answered and (snap is None or not turn_had_output(snap))
        if quiet and tokens_in == 0 and tokens_out == 0:
            lines.append(_error_line("The model returned nothing (0 tokens) · turn not completed. "
                                     "Check account quota and endpoint status, then retry."))
        return lines

    def _on_interrupt(self, interrupts: Any) -> None:
        with self._app.lock:
            if self._bridge._cancelled:
                return
            self._handle_interrupt(interrupts)

    def _handle_interrupt(self, interrupts: Any) -> None:
        # 停下等用户：这段时间不计入本回合耗时
        if self._turn_started_at:
            self._turn_elapsed += time.time() - self._turn_started_at
            self._turn_started_at = 0.0
        items = list(interrupts) if isinstance(interrupts, (list, tuple)) else [interrupts]
        pending = [(getattr(item, "id", None), getattr(item, "value", item)) for item in items]
        ids = [iid for iid, _value in pending]
        if len(items) > 1 and (any(not isinstance(iid, str) or not iid for iid in ids)
                               or len(set(ids)) != len(ids)):
            self._show_unhandled_interrupt("missing or duplicate interrupt id")
            return
        asks: list[tuple[str | None, dict[str, Any]]] = []
        approvals: list[tuple[str | None, dict[str, Any]]] = []
        for iid, value in pending:
            if not isinstance(value, dict):
                self._show_unhandled_interrupt(type(value).__name__)
                return
            if "action_requests" in value:
                requests = value["action_requests"]
                if not isinstance(requests, (list, tuple)) or not requests or not all(
                        isinstance(request, dict) for request in requests):
                    self._show_unhandled_interrupt("invalid action_requests")
                    return
                approvals.extend((iid, request) for request in requests)
            elif value.get("kind") == "ask_user":
                asks.append((iid, value))
            else:
                kind = str(value.get("kind") or "")
                handler = self._interrupt_handlers.get(kind) if len(items) == 1 else None
                if handler is not None:
                    handler(value)
                    return
                self._show_unhandled_interrupt(kind or "unknown")
                return
        self._interrupt_order = ids
        self._interrupt_replies = {}
        self._ask_queue = asks
        self._ask_replies = []
        if approvals:
            self._begin_approvals(approvals)
        elif asks:
            self._begin_ask_user(asks)
        else:
            self._show_unhandled_interrupt("empty")

    def _show_unhandled_interrupt(self, kind: str) -> None:
        # 不认识的中断形态：不能替用户作答，如实说明、停在这里
        with self._app.lock:
            self._transcript.append_message(
                _warn_line(f"Unhandled interrupt ({kind}) · the turn is paused."))
            self._leave_busy()
            self._app.render()

    def _begin_approvals(self, requests: list[tuple[str | None, dict[str, Any]]]) -> None:
        with self._app.lock:
            self._pending_calls = [dict(request) for _iid, request in requests]
            self._render_turn_region()
            self._app.render()
        self._approval_queue = list(requests)
        self._approval_decisions = {iid: [] for iid, _request in requests}
        if self._approvals.yolo_enabled(self._thread_id):  # 新中断按当前 /yolo 状态处理
            for iid, _request in requests:
                self._approval_decisions[iid].append({"type": "approve"})
            self._complete_approvals()
            return
        self._next_approval()

    def _record_approval(self, key: str, message: str = "") -> None:
        iid, req = self._approval_queue.pop(0)
        name = str(req.get("name") or "tool")
        approved = self._approvals.remember(self._thread_id, name, req.get("args") or {}, key)
        # 拒绝时用户可以说明原因：原因随拒绝一起交给模型，让它知道该怎么改
        reason = REJECTED_BY_USER + (f" The user said: {message}" if message else "")
        self._approval_decisions[iid].append(
            {"type": "approve"} if approved
            else {"type": "reject", "message": reason})
        if not approved:
            # 被拒的调用不会执行、也就没有工具回调；补一行让它留在本回合里
            self._bridge.announce_blocked({"name": name, "args": req.get("args") or {}}, reason)

    def _next_approval(self) -> None:
        with self._app.lock:
            if self._job_card is not None:
                return  # a background agent's card is up: this one follows it
            while self._approval_queue:
                _iid, req = self._approval_queue[0]
                name = str(req.get("name") or "tool")
                args = req.get("args") or {}
                if self._approvals.yolo_enabled(self._thread_id):
                    # /yolo may have been turned on while this question waited (or while the card
                    # was held back for typing): the rest of the queue is approved, not asked
                    self._approval_decisions[self._approval_queue.pop(0)[0]].append({"type": "approve"})
                    continue
                if self._plan_mode and name in _PLAN_BLOCKED_TOOLS:
                    path = str(args.get("file_path") or args.get("path") or "")
                    if name != "write_file" or Path(path).name.lower() not in {"plan.md", "plan"}:
                        self._toast(f"read-only: rejected {name}")
                        self._record_approval("reject")
                        continue
                if self._defer_card_while_typing(self._next_approval):
                    return
                review = self._approvals.review(name, args)
                backend = getattr(self._agent, "_circle_backend", None)
                resolve = getattr(backend, "_resolve_path", None)
                self._begin_exec_approval({
                    "tool": name,
                    "title": name,
                    "body": _approval_body(name, args),
                    "preview": approval_preview(name, args,
                                                resolve if callable(resolve) else None),
                    "policy": review.reason,
                    "allow_always": review.allow_always,
                    "warn_delete": review.warn_delete,
                    "scope": review.scope,
                    "prefix_scope": review.prefix_scope,
                    "more": len(self._approval_queue) - 1,
                    "tint": tool_type_bg_sgr(name),
                })
                return
        self._complete_approvals()

    def _complete_approvals(self) -> None:
        for iid, decisions in self._approval_decisions.items():
            self._interrupt_replies[iid] = {"decisions": decisions}
        self._approval_decisions = {}
        if self._ask_queue:
            self._begin_ask_user(self._ask_queue)
        else:
            self._resume_interrupts()

    def _resume_interrupts(self) -> None:
        order = self._interrupt_order
        if not order or any(iid not in self._interrupt_replies for iid in order):
            self._show_unhandled_interrupt("incomplete replies")
            return
        value = (self._interrupt_replies[order[0]] if len(order) == 1 else
                 {iid: self._interrupt_replies[iid] for iid in order})
        self._interrupt_order = []
        self._interrupt_replies = {}
        self._resume_with(value)

    def _resume_with(self, value: Any) -> None:
        with self._app.lock:
            if self._job_rounds and self._job_card is None:
                self._pump_job_rounds()
            if self._job_card is None:
                self._restore_draft()
            self._turn_started_at = time.time()
            self._enter_busy()
            self._pending_calls = []
            self._render_turn_region()
            self._app.render()
        self._bridge.resume(value)

    # ── question panel (ask_user interrupts) ────────────────────────────

    def _begin_ask_user(self, asks: list[tuple[str | None, dict[str, Any]]]) -> None:
        with self._app.lock:
            if self._job_card is not None:
                self._ask_queue = list(asks)
                return  # a background agent's card is up: these follow it
            if self._defer_card_while_typing(lambda: self._begin_ask_user(asks)):
                return
            self._ask_queue = list(asks)
            self._ask_replies = []
            self._park_draft()
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
        self._interrupt_replies.update(replies)
        self._resume_interrupts()

    def _render_ask_user(self) -> None:
        with self._app.lock:
            self._app.render()

    def _finish_ask_user(self, answers: list[list[str]] | None) -> None:
        with self._app.lock:
            session, self._ask_session = self._ask_session, None
            self._prompt.clear()
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
        self._card_defer = None
        self._ask_session = None
        self._ask_queue = []
        self._ask_replies = []
        self._exec_approval = None
        self._approval_queue = []
        self._approval_decisions = {}
        self._interrupt_order = []
        self._interrupt_replies = {}
        self._pending_calls = []
        self._close_popup()
        if self._job_card is not None or self._job_rounds:
            # the turn's cards are gone (and a held-back card with them): a background
            # agent's question still waits
            self._job_card = None
            self._pump_job_rounds()
        if self._job_card is None:
            self._restore_draft()

    # ── /approvals page ──────────────────────────────────────────────────

    def _begin_approvals_page(self) -> None:
        store = self._approvals.store
        rules = store.rules(self._thread_id)
        lines: list[str] = []
        options: list[dict[str, str]] = []
        if not rules:
            lines.append("No always-allow rules this session.")
        for i, rule in enumerate(rules):
            label = str(rule.get("label") or rule.get("pattern") or "")
            lines.append(f"[always] {rule.get('tool')} · {label}")
            options.append({"key": f"revoke:{i}", "label": f"Revoke: {label[:40]}"})
        names = {"once": "allowed once", "always": "allowed for session", "reject": "rejected",
                 "revoke": "revoked"}
        recent = store.log(self._thread_id)[-5:]
        if recent:
            lines.append("Recent approvals:")
            lines += [f"[{names.get(str(e.get('kind')), e.get('kind'))}] {e.get('tool')}"
                      for e in recent]
        options.append({"key": "close", "label": "Close"})
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
                self._ask_panel.update(self._approvals_page.render_lines(max(20, self._app.width or 80)))
            self._app.render()

    def _finish_approvals_page(self, choice: str) -> None:
        with self._app.lock:
            self._approvals_page = None
            self._ask_panel.clear()
            if choice.startswith("revoke:"):
                rule = self._approvals.store.revoke(self._thread_id, int(choice.split(":", 1)[1]))
                if rule is not None:
                    self._toast(f"Revoked · {rule.get('tool')} · {rule.get('label') or rule.get('pattern')}"
                                " · the next call like it will ask again")
            self._app.render()

    def _park_draft(self) -> None:
        """A card takes the frame: keep what the user was typing (and the long pastes its
        placeholders stand for), empty the composer, and close any popup that would compete
        for the keyboard."""
        if not self._draft_parked:
            self._ask_saved_prompt = self._prompt.value
            self._ask_saved_pastes = self._prompt.pasted_snapshot()
            self._draft_parked = True
        self._prompt.clear()
        self._close_popup()

    def _restore_draft(self) -> None:
        """The card is gone: whatever was typed under it (a rejection reason) goes, and the
        parked draft comes back whole."""
        if not self._draft_parked:
            return  # nothing was parked (the card never appeared): the live draft is the user's
        self._prompt.clear()
        if self._ask_saved_prompt:
            self._prompt.restore_draft(self._ask_saved_prompt, self._ask_saved_pastes)
        self._ask_saved_prompt = ""
        self._ask_saved_pastes = {}
        self._draft_parked = False

    def _close_popup(self) -> None:
        """``/approvals`` is a popup, not a card: it must not keep (or take) the keys while a
        card holds the frame, nor outlive a cancelled turn."""
        self._approvals_page = None
        self._picker = None
        self._ask_panel.clear()

    def _defer_card_while_typing(self, begin: Callable[[], None]) -> bool:
        """Hold a card back while the user is typing a draft; ``begin`` runs once they have
        been idle for ``_CARD_TYPING_IDLE_S``. The pending row already says *waiting for you*."""
        idle = time.monotonic() - self._last_key_at
        if not self._prompt.value or idle >= _CARD_TYPING_IDLE_S:
            return False
        token = self._card_defer = object()

        def later() -> None:
            # RLock: begin() may take it again. Holding it across begin() closes the gap in which
            # ctrl+c could cancel the turn between the token check and the card appearing.
            with self._app.lock:
                if self._card_defer is not token:
                    return  # cancelled or replaced meanwhile
                self._card_defer = None
                begin()  # re-checks: more typing defers again

        timer = threading.Timer(_CARD_TYPING_IDLE_S - idle + 0.05, later)
        timer.daemon = True
        timer.start()
        return True

    def _begin_exec_approval(self, payload: dict) -> None:
        self._park_draft()
        self._exec_approval = ExecApprovalSession(
            payload,
            render=self._render_exec_approval,
            on_finish=self._finish_exec_approval,
        )
        self._render_exec_approval()

    def _render_exec_approval(self) -> None:
        # 卡片由 _sync_dialog_frame 画进框里；这里只要求重绘
        self._app.render()

    def _finish_exec_approval(self, decision: dict) -> None:
        self._exec_approval = None
        self._prompt.clear()
        if self._job_card is not None:
            self._finish_job_approval(decision)
            return
        if self._approval_queue:
            self._record_approval(str(decision.get("decision") or "reject"),
                                  str(decision.get("message") or ""))
        self._next_approval()

    def _handle_exec_approval_key(self, kp: KeyPress) -> bool:
        session = self._exec_approval
        if session is None:
            return False
        if session.in_input:
            # 「Reject and explain」：字符进输入行，enter 发送（空＝纯拒绝），esc 回到选项
            if kp.key in ("enter", "return"):
                text = self._prompt.value
                self._prompt.clear()
                session.submit_reason(text)
                return True
            if kp.key == "escape":
                self._prompt.clear()
                session.cancel_input()
                return True
            if kp.key in ("ctrl+c", "ctrl+d"):
                return False
            if self._prompt.handle_key(kp.key if kp.key else "char",
                                       kp.char if len(kp.char) == 1 else ""):
                self._app.render()
            return True
        return session.handle_key(kp.key, kp.char)


def _shell_word(text: str) -> str:
    """``text`` as one word of a command typed into your shell: cmd or PowerShell on
    Windows, a POSIX shell elsewhere."""
    if os.name == "nt":
        import subprocess

        return subprocess.list2cmdline([text])
    import shlex

    return shlex.quote(text)


def _editor_command(editor: str) -> list[str]:
    """$VISUAL / $EDITOR as a command. A program that exists as written is one word (a
    path with spaces, or a Windows path with backslashes); otherwise the words are split
    like a shell's, so ``code -w`` works."""
    import shlex
    import shutil

    if shutil.which(editor) or os.path.isfile(editor):
        return [editor]
    try:
        if os.name == "nt":  # posix rules would eat the backslashes of C:\path
            return [part[1:-1] if len(part) > 1 and part[0] == part[-1] == '"' else part
                    for part in shlex.split(editor, posix=False)]
        return shlex.split(editor)
    except ValueError:
        return [editor]


def _faint(text: str) -> str:
    pal = palette()
    return f"{pal.faint}{text}{pal.reset}"


def _error_line(text: str) -> str:
    pal = palette()
    return f" {pal.red}{GLYPH_ERROR}{pal.reset} {text}"


def _warn_line(text: str) -> str:
    pal = palette()
    return f" {pal.yellow}{GLYPH_ERROR}{pal.reset} {text}"


def _tree_from(messages: list[Any]) -> SessionTree:
    """The message tree of a saved conversation: each user message and its answer."""
    tree = SessionTree()
    for text, snap in saved_turns(messages):
        if text:
            tree.add("user", text)
        answer = final_text(snap)
        if answer:
            tree.add("assistant", answer)
    return tree


def _shell_snapshot(call_id: str, command: str, result: Any) -> MessageSnapshot:
    """A ``!command`` as a Bash call: running while ``result`` is None, then its output."""
    blocks = [make_tool_use_block(tool_use_id=call_id, name="execute",
                                  input={"command": command},
                                  status="running" if result is None else "done")]
    if result is not None:
        job = getattr(result, "job", None)
        payload = ({"job": {"id": job.id, "how": getattr(result, "how", ""),
                            "path": job.virtual_path}} if job is not None else None)
        blocks.append(make_tool_result_block(tool_use_id=call_id, output=result.output,
                                             is_error=result.exit_code not in (0, None),
                                             name="execute", payload=payload))
    return MessageSnapshot(messages=(make_assistant_message(uuid=call_id, content=blocks),),
                           status="idle")


_user_rows = user_rows


def _path_tail(path: str) -> str:
    """The end of a path, which is what tells folders apart: ``…/code/app``."""
    parts = [p for p in Path(path).parts if p not in ("/", "")]
    return path if len(parts) <= 2 else "…/" + "/".join(parts[-2:])


def _short_path(path: str) -> str:
    home = str(Path.home())
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


def _mark_text(row: str, query: str) -> str:
    """``row`` with each place ``query`` appears shown in reverse video, for find. The
    colour codes already in the row are kept; matching ignores case."""
    pal = palette()
    needle = query.lower()
    if not needle:
        return row
    plain_chars: list[tuple[int, str]] = []  # (index in row, character) of what is seen
    index = 0
    while index < len(row):
        match = _SGR_ANY.match(row, index)
        if match:
            index = match.end()
            continue
        plain_chars.append((index, row[index]))
        index += 1
    seen = "".join(ch for _i, ch in plain_chars).lower()
    marks: list[tuple[int, int]] = []
    start = seen.find(needle)
    while start >= 0:
        marks.append((plain_chars[start][0], plain_chars[start + len(needle) - 1][0] + 1))
        start = seen.find(needle, start + len(needle))
    for begin, end in reversed(marks):
        row = f"{row[:begin]}{pal.reverse}{row[begin:end]}{pal.reset}{row[end:]}"
    return row


_SGR_ANY = re.compile(r"\x1b\[[0-9;]*m")


def _cut_end(text: str, room: int) -> str:
    """Keep the start of ``text`` within ``room`` columns, ``…`` where it was cut."""
    if string_width(text) <= room:
        return text
    out, used = [], 0
    for ch in text:
        w = string_width(ch)
        if used + w > room - 1:
            break
        out.append(ch)
        used += w
    return "".join(out) + "…"


def _cut_start(text: str, room: int) -> str:
    """Keep the end of ``text`` within ``room`` columns (a path's tail identifies it)."""
    if string_width(text) <= room:
        return text
    out, used = [], 0
    for ch in reversed(text):
        w = string_width(ch)
        if used + w > room - 1:
            break
        out.append(ch)
        used += w
    return "…" + "".join(reversed(out))


# Turns started by job notices in a row before Circle waits for you
_NOTICE_STREAK_MAX = 10


@dataclass
class _JobRound:
    """A background agent waiting on its approvals and questions; it is answered once every
    one of them is (by interrupt id when there are several)."""

    job: Any
    label: str
    answer: Callable[[Any], None]
    order: list[str]
    approvals: list[tuple[str, dict[str, Any]]]
    asks: list[tuple[str, dict[str, Any]]]
    decisions: dict[str, list[dict[str, Any]]]
    replies: dict[str, Any]


def _stop_line() -> str:
    """A stopped turn: a dim ✖ (the same glyph as a failure, told apart by colour)."""
    pal = palette()
    return f" {pal.dim}{GLYPH_ERROR} Interrupted{pal.reset}"


_PLAN_BLOCKED_TOOLS = frozenset({"execute", "write_file", "edit_file", "apply_patch", "delete"})


def _approval_body(name: str, args: dict[str, Any]) -> str:
    """The card's first lines: the command, the file, or the files a patch changes (its
    diff follows from ``approval_preview``); other tools list their arguments."""
    if name == "execute":
        body = "$ " + str(args.get("command") or "")
        # it does not end with the call: say so before it is allowed
        background = is_true(args.get("background"))
        return body + "\nruns in the background as a job" if background else body
    if name == "apply_patch":
        files = [line.split(":", 1)[1].strip()
                 for line in str(args.get("patchText") or "").splitlines()
                 if line.startswith(("*** Add File:", "*** Update File:", "*** Delete File:"))]
        more = f" and {len(files) - 6} more" if len(files) > 6 else ""
        return ", ".join(files[:6]) + more if files else "(a patch with no files)"
    if name in {"write_file", "edit_file", "delete"}:
        return str(args.get("file_path") or args.get("path") or "")
    return "\n".join(f"{k}={v!r}"[:200] for k, v in list(args.items())[:8])


def run_circle_session(
    workspace: str | Path = ".",
    *,
    home: Path | None = None,
    force_init: bool = False,
    model_override=None,
    **start: Any,
) -> int:
    """Entry used by the CLI. One screen from the first frame: setup (when Circle is not set
    up yet, or ``force_init``) and trust (when the folder is new) are cards in the session's
    own frame, under the welcome block, and the session connects once they are answered.
    ``start`` is passed on to the session: ``resume`` (the thread id ``circle -c`` /
    ``--session`` opens), ``pick_session``, ``fork``, ``thread_id``, ``initial`` messages and
    the ``run_options``."""
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Circle needs an interactive terminal.", file=sys.stderr)
        return 2

    home = home or circle_home()
    # 日志进文件：无处理器时 WARNING 以上会经 lastResort 写到 stderr，直接画进全屏界面
    from circle.log_setup import configure_file_logging

    configure_file_logging(home)
    workspace = normalize_workspace(workspace)
    settings = load_settings(home)
    return CircleSessionApp(
        settings, workspace, home=home, model_override=model_override, connect=False,
        setup=force_init, **start,
    ).run()
