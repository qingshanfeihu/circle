"""Circle fullscreen TUI on vendored InfoTest ink."""

from __future__ import annotations

import sys
from pathlib import Path

from circle.ink.app import InkApp
from circle.ink.components.footer import FooterPane
from circle.ink.components.prompt_input import PromptInput
from circle.ink.dom import NodeType, create_element, create_text
from circle.ink.parse_keypress import InputEvent
from circle.ink.theme import init_palette_from_terminal
from circle.paths import circle_home, normalize_workspace
from circle.settings import is_folder_trusted, load_settings
from circle.tui.controllers import InitController, InitStep, TrustController
from circle.tui.session import MainController


class CircleApp:
    """Init → Trust → Main, rendered with InkApp."""

    def __init__(
        self,
        workspace: str | Path = ".",
        *,
        home: Path | None = None,
        force_init: bool = False,
        model_override=None,
    ) -> None:
        self.home = home or circle_home()
        self.workspace = normalize_workspace(workspace)
        self.force_init = force_init
        self.model_override = model_override
        self._ink = InkApp(alt_screen=True, mouse=False)
        self._body = create_element(NodeType.BOX)
        self._body.style.flex_grow = 1
        self._body.style.overflow_y = "scroll"
        self._footer = FooterPane()
        self._prompt = PromptInput(
            cursor_manager=self._ink.cursor,
            on_submit=self._on_submit,
            placeholder="输入消息（/ 命令）",
        )
        self._ink.root.append_child(self._body)
        self._ink.root.append_child(self._footer.node)
        self._ink.root.append_child(self._prompt.node)
        self._ink.on_input = self._on_input

        self.init: InitController | None = None
        self.trust: TrustController | None = None
        self.main: MainController | None = None
        self._stage = "boot"

    def run(self) -> int:
        init_palette_from_terminal()
        settings = load_settings(self.home)
        if self.force_init or not settings.is_ready():
            self.init = InitController(home=self.home)
            self._stage = "init"
        elif not is_folder_trusted(settings, self.workspace):
            self.trust = TrustController(settings, self.workspace, home=self.home)
            self._stage = "trust"
        else:
            self.main = self._make_main(settings)
            self._stage = "main"
        self._rebuild()
        self._ink.start()
        try:
            import time

            while self._ink._running:  # noqa: SLF001 — ink loop
                if self._stage == "done":
                    break
                if self.main and self.main.phase == "exited":
                    break
                time.sleep(0.05)
                if self.init and self.init.done:
                    settings = self.init.settings
                    assert settings is not None
                    if not is_folder_trusted(settings, self.workspace):
                        self.trust = TrustController(settings, self.workspace, home=self.home)
                        self.init = None
                        self._stage = "trust"
                        self._rebuild()
                    else:
                        self.main = self._make_main(settings)
                        self.init = None
                        self._stage = "main"
                        self._rebuild()
                if self.trust and self.trust.finished:
                    if not self.trust.accepted:
                        self._stage = "done"
                        break
                    assert self.trust.result is not None
                    self.main = self._make_main(self.trust.result)
                    self.trust = None
                    self._stage = "main"
                    self._rebuild()
        finally:
            self._ink.stop()
        return 0

    def _make_main(self, settings) -> MainController:
        return MainController(
            settings,
            self.workspace,
            home=self.home,
            model_override=self.model_override,
            on_change=self._rebuild,
        )

    def _on_input(self, event: InputEvent) -> None:
        from circle.ink.parse_keypress import KeyPress, PasteEvent

        if isinstance(event, PasteEvent):
            self._prompt.handle_paste(event.text)
            self._rebuild()
            return
        if not isinstance(event, KeyPress):
            return

        key = (event.key or "").lower()
        char = event.char or ""

        if key in {"up", "arrowup"}:
            self._move(-1)
            return
        if key in {"down", "arrowdown"}:
            self._move(1)
            return
        if key in {"escape"} or (event.ctrl and key == "c"):
            self._ink._running = False  # noqa: SLF001
            return

        # Menu confirm without typing into the prompt
        if key in {"return", "enter"} and not self._prompt.value.strip():
            if self.init and self.init.step in {
                InitStep.AUTH_MODE,
                InitStep.OAUTH_PROVIDER,
                InitStep.PICK_MODEL,
            }:
                self.init.confirm()
                self._rebuild()
                return
            if self.trust and not self.trust.finished:
                self.trust.confirm()
                self._rebuild()
                return
            if self.main and self.main.approval is not None:
                self.main.confirm_approval()
                self._rebuild()
                return

        if self._prompt.handle_key(key if key else "char", char if len(char) == 1 else ""):
            self._rebuild()

    def _move(self, delta: int) -> None:
        if self.init and not self.init.done:
            self.init.move(delta)
        elif self.trust and not self.trust.finished:
            self.trust.move(delta)
        elif self.main and self.main.approval is not None:
            self.main.move_approval(delta)
        self._rebuild()

    def _on_submit(self, text: str) -> None:
        if self.init and not self.init.done:
            self.init.submit_line(text)
        elif self.trust and not self.trust.finished:
            self.trust.submit_line(text)
        elif self.main is not None:
            self.main.submit_user(text)
        self._rebuild()

    def _rebuild(self) -> None:
        lines: list[str] = []
        model = ""
        phase = ""
        if self.init is not None:
            lines.append(self.init.title())
            lines.append("")
            lines.extend(self.init.body_lines())
            phase = self.init.step.name.lower()
            self._prompt.placeholder = (
                f"{self.init.prompt_label()}" if self.init.prompt_label() else "选择后 Enter"
            )
        elif self.trust is not None:
            lines.extend(self.trust.body_lines())
            phase = "trust"
            self._prompt.placeholder = "y trust / n 拒绝"
        elif self.main is not None:
            lines.extend(self.main.body_lines())
            phase = self.main.phase
            model = self.main.settings.auth.model
            self._prompt.placeholder = "输入消息（/exit 离开）"
        self._body.clear_children()
        for ln in lines:
            self._body.append_child(create_text(ln if ln else " "))
        self._footer.set_status(phase=phase, model=model)
        if self._ink._running:  # noqa: SLF001
            self._ink.render()


def run_circle_tui(
    workspace: str | Path = ".",
    *,
    home: Path | None = None,
    force_init: bool = False,
    model_override=None,
) -> int:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Circle TUI 需要交互式终端。", file=sys.stderr)
        return 2
    return CircleApp(
        workspace,
        home=home,
        force_init=force_init,
        model_override=model_override,
    ).run()
