"""Circle session shell — IstInkApp session ring without compile/KMS.

Layout matches InfoTest: transcript · ask panel · thinking · divider ·
prompt · divider · footer. Streaming + exec approval via HarnessBridge.
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

from langgraph.checkpoint.memory import MemorySaver

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
from circle.paths import circle_home, ensure_home, normalize_workspace
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
from circle.tui.content_blocks import assistant_block, render_thinking_line
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.harness_bridge import HarnessBridge, StreamUpdate
from circle.tui.slash_commands import help_text, hotkeys_text, parse_slash

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
            placeholder="输入消息（/ 命令 · /help）",
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
        self._show_thinking = True
        self._show_details = True
        self._call_started_at = 0.0
        self._exec_approval: ExecApprovalSession | None = None
        self._ask_saved_prompt = ""
        self._last_ctrl_c = 0.0
        self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
        self._checkpointer = MemorySaver()
        self._archive: list[_SessionRecord] = []
        self._previous_thread_id: str | None = None
        self._context_prefix = ""
        self._session_title = "new"
        self._undo_stack: list[_SessionRecord] = []
        self._redo_stack: list[_SessionRecord] = []
        self._share_path: Path | None = None
        self._last_assistant_plain = ""

        model = build_chat_model(
            settings, home=self.home, model_override=model_override
        )
        self._agent = create_harness(
            model, root_dir=self.workspace, checkpointer=self._checkpointer
        )
        self._bridge = self._make_bridge()

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
            self._show_thinking = True
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
        parsed = parse_slash(text)
        if parsed is not None:
            self._dispatch_slash(parsed.name, parsed.args)
            return
        if self._bridge.is_running or self._is_loading:
            self._transcript.append_message(" \x1b[2m(busy — 等待当前回合完成)\x1b[0m")
            self._app.render()
            return

        self._push_undo_checkpoint()

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
        payload = text
        if self._context_prefix:
            payload = f"{self._context_prefix}\n\n---\n\n{text}"
            self._context_prefix = ""
        self._bridge.start(payload)

    def _toast(self, msg: str) -> None:
        self._transcript.append_message(f" \x1b[2m{msg}\x1b[0m")
        self._app.render()

    def _dispatch_slash(self, name: str, args: str) -> None:
        if name == "exit":
            self._app._running = False  # noqa: SLF001
            return
        if name == "help":
            for line in help_text().splitlines():
                self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
            self._app.render()
            return
        if name == "hotkeys":
            for line in hotkeys_text().splitlines():
                self._transcript.append_message(f" \x1b[2m{line}\x1b[0m")
            self._app.render()
            return
        if self._bridge.is_running or self._is_loading:
            self._toast("(busy — 等待当前回合完成)")
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
        self._context_prefix = ""
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
        """Pi /login · OpenCode /connect — OAuth provider auth."""
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
            self._agent = create_harness(
                chat, root_dir=self.workspace, checkpointer=self._checkpointer
            )
            self._bridge = self._make_bridge()
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
        self._context_prefix = ""
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
        self._agent = create_harness(
            model, root_dir=self.workspace, checkpointer=self._checkpointer
        )
        self._bridge = self._make_bridge()
        self._footer.update(model=name)
        self._toast(f"模型 → {name}")

    def _session_chat_model(self):
        """Model for one-shot helpers (/compact, …) — honor session override."""
        return build_chat_model(
            self.settings, home=self.home, model_override=self.model_override
        )

    def _cmd_compact(self, args: str) -> None:
        hint = args.strip() or "Summarize the conversation for continuity. Keep decisions, paths, and open tasks."
        plain_lines = [
            _strip_ansi(m).strip()
            for m in self._transcript.snapshot()
            if _strip_ansi(m).strip()
        ]
        if len(plain_lines) < 2:
            self._toast("对话太短，无需压缩")
            return
        body = "\n".join(plain_lines[-200:])
        self._toast("正在压缩上下文…")
        self._enter_busy()
        self._app.render()

        def _work() -> None:
            summary = ""
            err: BaseException | None = None
            try:
                model = self._session_chat_model()
                result = model.invoke(
                    [
                        {
                            "role": "user",
                            "content": (
                                f"{hint}\n\n---\n\nTranscript:\n{body}\n\n"
                                "Reply with the summary only."
                            ),
                        }
                    ]
                )
                content = getattr(result, "content", result)
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
                self._archive_current()
                self._previous_thread_id = self._thread_id
                self._thread_id = f"circle-{uuid.uuid4().hex[:8]}"
                self._bridge = self._make_bridge()
                self._context_prefix = (
                    "Prior conversation was compacted. Summary:\n" + summary
                )
                self._session_title = (self._session_title or "session") + " (compacted)"
                self._transcript.clear()
                self._show_welcome()
                self._transcript.append_message(" \x1b[2m— compacted —\x1b[0m")
                for line in summary.splitlines() or ["(empty summary)"]:
                    self._transcript.append_message(f" {line}")
                self._transcript.append_message("")
                self._leave_busy()
                self._app.render()

        threading.Thread(target=_work, name="circle-compact", daemon=True).start()

    def _cmd_thinking(self, _args: str) -> None:
        self._show_thinking = not self._show_thinking
        self._thinking_expanded = self._show_thinking
        if self._thinking_body:
            self._refresh_thinking_row()
        state = "显示" if self._show_thinking else "隐藏"
        self._toast(f"思考块 → {state}")

    def _cmd_details(self, _args: str) -> None:
        self._show_details = not self._show_details
        self._footer.update(status="ready" if not self._is_loading else "running")
        self._toast(f"工具细节 → {'开' if self._show_details else '关'}")

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
        self._context_prefix = ""
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

    def _cmd_init(self, _args: str) -> None:
        path = self.workspace / "AGENTS.md"
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        block = (
            f"# AGENTS.md\n\n"
            f"Generated by Circle `/init` on {stamp}.\n\n"
            f"## Project\n\n"
            f"- Workspace: `{self.workspace}`\n\n"
            f"## Conventions\n\n"
            f"- Prefer small, reviewable changes.\n"
            f"- Do not commit secrets; credentials stay in `~/.circle/`.\n"
        )
        if path.is_file():
            existing = path.read_text(encoding="utf-8")
            if "Generated by Circle `/init`" in existing or existing.strip():
                path.write_text(
                    existing.rstrip() + "\n\n---\n\n" + block,
                    encoding="utf-8",
                )
                self._toast(f"已追加更新 {path}")
                return
        path.write_text(block, encoding="utf-8")
        self._toast(f"已创建 {path}")

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

    def _cmd_mcp(self, _args: str) -> None:
        servers = self.settings.mcp_servers
        if not servers:
            self._toast(
                "未配置 MCP。在 ~/.circle/settings.json 添加 mcp_servers: "
                '[{ "name": "...", "command": "..." }]'
            )
            return
        self._toast(f"MCP servers ({len(servers)}):")
        for item in servers:
            name = str(item.get("name") or item.get("id") or "?")
            cmd = str(item.get("command") or item.get("url") or "")
            self._transcript.append_message(f" \x1b[2m  · {name}  {cmd}\x1b[0m")
        self._toast("（当前构建仅列出配置，不建立连接）")
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
        self._context_prefix = (
            "Imported prior transcript for continuity.\n" + body[:8000]
        )
        self._toast(f"已导入 {path}（下一轮会带上摘要上下文）")

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
        try:
            model = build_chat_model(
                self.settings, home=self.home, model_override=self.model_override
            )
            self._agent = create_harness(
                model, root_dir=self.workspace, checkpointer=self._checkpointer
            )
            self._bridge = self._make_bridge()
        except Exception as exc:  # noqa: BLE001
            self._toast(f"reload 部分失败: {exc}")
            return
        self._footer.update(model=self.settings.auth.model)
        self._toast("已重新加载 settings / 模型")

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
        else:
            self._transcript.update_message_at(self._thinking_idx, line)

    def _on_done(self, text: str) -> None:
        with self._app.lock:
            visible = (text or "").strip() or "（无输出）"
            self._last_assistant_plain = visible
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
