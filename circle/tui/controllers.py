"""Init / OAuth / Trust screen controllers — shared by ink TUI and selftest."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable

from circle.oauth import OAuthNotConfiguredError, start_oauth_login
from circle.paths import normalize_workspace
from circle.probe import ProbeResult, fallback_model_list, resolve_endpoint
from circle.settings import (
    CircleSettings,
    ModelAuth,
    is_folder_trusted,
    save_credentials,
    save_settings,
)
from circle.trust import accept_trust


class InitStep(Enum):
    AUTH_MODE = auto()
    API_URL = auto()
    API_KEY = auto()
    OAUTH_PROVIDER = auto()
    OAUTH_WAIT = auto()
    PROBING = auto()
    PICK_MODEL = auto()
    DONE = auto()


@dataclass
class InitController:
    home: Path | None = None
    probe: Callable[[str, str], ProbeResult | None] = field(default=None)  # type: ignore[assignment]
    oauth_login: Callable[[str], object] = field(default=start_oauth_login)
    step: InitStep = InitStep.AUTH_MODE
    mode: str = ""  # api_key | oauth
    base_url: str = ""
    api_key: str = ""
    oauth_provider: str = ""
    protocol: str = "openai"
    models: list[str] = field(default_factory=list)
    model_focus: int = 0
    status: str = ""
    error: str = ""
    settings: CircleSettings | None = None
    _oauth_token: str = ""

    def __post_init__(self) -> None:
        if self.probe is None:
            # Default: full resolve (probe + URL hint). Tests may inject probe_endpoint.
            self.probe = resolve_endpoint  # type: ignore[assignment]

    def title(self) -> str:
        return "Circle 初始化"

    def body_lines(self) -> list[str]:
        lines: list[str] = []
        if self.error:
            lines.append(f"✖ {self.error}")
        if self.step == InitStep.AUTH_MODE:
            lines += [
                "接入方式（↑↓ 选择，Enter 确认）:",
                f"  {'▸' if self.model_focus == 0 else ' '} [1] API URL + KEY",
                f"  {'▸' if self.model_focus == 1 else ' '} [2] OAuth 登录",
            ]
        elif self.step == InitStep.API_URL:
            lines.append("填写 API URL（OpenAI 兼容或 Anthropic 网关根）")
            lines.append(f"  当前: {self.base_url or '（空）'}")
        elif self.step == InitStep.API_KEY:
            lines.append("填写 API KEY（输入后 Enter；界面以掩码显示）")
            masked = ("*" * min(8, len(self.api_key))) if self.api_key else "（空）"
            lines.append(f"  KEY: {masked}")
        elif self.step == InitStep.OAUTH_PROVIDER:
            lines += [
                "OAuth 提供方:",
                f"  {'▸' if self.model_focus == 0 else ' '} anthropic",
                f"  {'▸' if self.model_focus == 1 else ' '} openai",
            ]
        elif self.step == InitStep.OAUTH_WAIT:
            lines.append(f"正在完成 {self.oauth_provider} OAuth…")
            lines.append(self.status or "等待授权回调")
        elif self.step == InitStep.PROBING:
            lines.append(self.status or "正在探测协议…")
        elif self.step == InitStep.PICK_MODEL:
            label = "OpenAI 兼容" if self.protocol == "openai" else "Anthropic Messages"
            lines.append(f"检测到 {label}。选择主模型:")
            for i, m in enumerate(self.models):
                mark = "▸" if i == self.model_focus else " "
                lines.append(f"  {mark} {m}")
        elif self.step == InitStep.DONE:
            lines.append("初始化完成。")
            if self.settings:
                lines.append(f"  协议: {self.settings.auth.protocol}")
                lines.append(f"  模型: {self.settings.auth.model}")
        return lines

    def prompt_label(self) -> str:
        if self.step == InitStep.API_URL:
            return "URL"
        if self.step == InitStep.API_KEY:
            return "KEY"
        return ""

    def move(self, delta: int) -> None:
        if self.step == InitStep.AUTH_MODE:
            self.model_focus = 0 if (self.model_focus + delta) % 2 == 0 else 1
        elif self.step == InitStep.OAUTH_PROVIDER:
            self.model_focus = 0 if (self.model_focus + delta) % 2 == 0 else 1
        elif self.step == InitStep.PICK_MODEL and self.models:
            self.model_focus = (self.model_focus + delta) % len(self.models)

    def submit_line(self, text: str) -> None:
        text = text.strip()
        self.error = ""
        if self.step == InitStep.AUTH_MODE:
            if text in {"1", "2"}:
                self.model_focus = 0 if text == "1" else 1
            self._confirm_auth_mode()
        elif self.step == InitStep.API_URL:
            if not text:
                self.error = "URL 不能为空"
                return
            self.base_url = text.rstrip("/")
            self.step = InitStep.API_KEY
        elif self.step == InitStep.API_KEY:
            if not text:
                self.error = "KEY 不能为空"
                return
            self.api_key = text
            self._start_probe()
        elif self.step == InitStep.OAUTH_PROVIDER:
            if text in {"1", "2", "anthropic", "openai"}:
                if text in {"1", "anthropic"}:
                    self.model_focus = 0
                elif text in {"2", "openai"}:
                    self.model_focus = 1
            self._confirm_oauth_provider()
        elif self.step == InitStep.PICK_MODEL:
            if text.isdigit() and 1 <= int(text) <= len(self.models):
                self.model_focus = int(text) - 1
            self._confirm_model()

    def confirm(self) -> None:
        """Enter with no new text — confirm current focus."""
        self.error = ""
        if self.step == InitStep.AUTH_MODE:
            self._confirm_auth_mode()
        elif self.step == InitStep.OAUTH_PROVIDER:
            self._confirm_oauth_provider()
        elif self.step == InitStep.PICK_MODEL:
            self._confirm_model()

    def _confirm_auth_mode(self) -> None:
        if self.model_focus == 0:
            self.mode = "api_key"
            self.step = InitStep.API_URL
        else:
            self.mode = "oauth"
            self.model_focus = 0
            self.step = InitStep.OAUTH_PROVIDER

    def _confirm_oauth_provider(self) -> None:
        self.oauth_provider = "anthropic" if self.model_focus == 0 else "openai"
        self.step = InitStep.OAUTH_WAIT
        self.status = f"启动 {self.oauth_provider} OAuth…"
        try:
            session = self.oauth_login(self.oauth_provider)
        except OAuthNotConfiguredError as exc:
            self.error = str(exc)
            self.step = InitStep.AUTH_MODE
            self.model_focus = 0
            return
        self._oauth_token = getattr(session, "access_token", "") or ""
        self.base_url = getattr(session, "base_url", "") or ""
        self.protocol = "anthropic" if self.oauth_provider == "anthropic" else "openai"
        self.models = list(getattr(session, "models", None) or fallback_model_list())
        self.model_focus = 0
        self.step = InitStep.PICK_MODEL
        self.status = "OAuth 完成"

    def _start_probe(self) -> None:
        self.step = InitStep.PROBING
        self.status = "正在探测 OpenAI /models → Anthropic /v1/models…"
        probed = self.probe(self.base_url, self.api_key)
        if probed is None:
            self.protocol = "openai"
            self.models = fallback_model_list()
            self.status = "探测失败，按 OpenAI 兼容 + 内置列表"
        else:
            self.protocol = probed.protocol
            self.models = probed.models or fallback_model_list()
            if getattr(probed, "inferred", False):
                self.status = f"探测未命中，按 URL 推断: {self.protocol}"
            else:
                self.status = f"探测成功: {self.protocol}"
        self.model_focus = 0
        self.step = InitStep.PICK_MODEL

    def _confirm_model(self) -> None:
        if not self.models:
            self.error = "没有可选模型"
            return
        model = self.models[self.model_focus]
        if self.mode == "oauth":
            settings = CircleSettings(
                initialized=True,
                auth=ModelAuth(
                    mode="oauth",
                    protocol=self.protocol,
                    base_url=self.base_url,
                    model=model,
                    oauth_provider=self.oauth_provider,
                    api_key_ref="oauth_access_token",
                ),
            )
            save_credentials(
                {
                    "oauth_access_token": self._oauth_token or "mock-token",
                    "oauth_refresh_token": "",
                },
                self.home,
            )
        else:
            settings = CircleSettings(
                initialized=True,
                auth=ModelAuth(
                    mode="api_key",
                    protocol=self.protocol,
                    base_url=self.base_url,
                    model=model,
                ),
            )
            save_credentials({"api_key": self.api_key}, self.home)
        save_settings(settings, self.home)
        self.settings = settings
        self.step = InitStep.DONE

    @property
    def done(self) -> bool:
        return self.step == InitStep.DONE and self.settings is not None


@dataclass
class TrustController:
    settings: CircleSettings
    workspace: Path
    home: Path | None = None
    focus: int = 0  # 0 trust, 1 decline
    finished: bool = False
    accepted: bool = False
    result: CircleSettings | None = None

    def __post_init__(self) -> None:
        self.workspace = normalize_workspace(self.workspace)

    def body_lines(self) -> list[str]:
        return [
            "Circle 工作区信任",
            f"路径: {self.workspace}",
            "Trust 后将写入 ~/.circle/settings.json，并创建 .agent/",
            f"  {'▸' if self.focus == 0 else ' '} Trust 此文件夹",
            f"  {'▸' if self.focus == 1 else ' '} 拒绝并退出",
        ]

    def move(self, delta: int) -> None:
        self.focus = 0 if (self.focus + delta) % 2 == 0 else 1

    def confirm(self) -> None:
        if self.focus == 0:
            self.result = accept_trust(self.settings, self.workspace, home=self.home)
            self.accepted = True
        else:
            self.accepted = False
        self.finished = True

    def submit_line(self, text: str) -> None:
        t = text.strip().lower()
        if t in {"y", "yes", "trust", "1"}:
            self.focus = 0
            self.confirm()
        elif t in {"n", "no", "2"}:
            self.focus = 1
            self.confirm()
