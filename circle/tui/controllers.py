"""Init / OAuth / Trust screen controllers — shared by ink TUI and selftest."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable

from circle.oauth import OAuthNotConfiguredError, start_oauth_login
from circle.paths import normalize_workspace
from circle.probe import ProbeResult, normalize_base_url, resolve_endpoint
from circle.settings import (
    CircleSettings,
    ModelAuth,
    load_credentials,
    load_settings,
    save_credentials,
    save_settings,
    with_connection,
)
from circle.trust import accept_trust


class InitStep(Enum):
    AUTH_MODE = auto()
    API_URL = auto()
    API_KEY = auto()
    OAUTH_PROVIDER = auto()
    OAUTH_WAIT = auto()
    PROBING = auto()
    MANUAL_PROTOCOL = auto()
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
    # Setting up again (circle --init): an empty enter keeps the saved URL and key
    saved_url: str = ""
    _saved_key: str = ""

    def __post_init__(self) -> None:
        if self.probe is None:
            # Default: full resolve (probe + URL hint). Tests may inject probe_endpoint.
            self.probe = resolve_endpoint  # type: ignore[assignment]
        try:
            previous = load_settings(self.home)
            if previous.initialized and previous.auth.mode == "api_key":
                self.saved_url = previous.auth.base_url
                self._saved_key = load_credentials(self.home).get(
                    previous.auth.api_key_ref or "api_key", "")
        except (OSError, ValueError):
            pass

    def title(self) -> str:
        return "Set up Circle"

    def body_lines(self) -> list[str]:
        lines: list[str] = []
        if self.error:
            lines.append(f"✖ {self.error}")
        if self.step == InitStep.AUTH_MODE:
            lines += [
                "How does Circle reach your model?",
                f"  {'▸' if self.model_focus == 0 else ' '} 1  API URL + KEY",
                f"  {'▸' if self.model_focus == 1 else ' '} 2  OAuth sign-in (not available yet)",
            ]
        elif self.step == InitStep.API_URL:
            lines.append("The base URL of an OpenAI-style or Anthropic-style API,")
            lines.append("for example https://api.openai.com/v1")
            if self.saved_url:
                lines.append(f"enter keeps {self.saved_url}")
        elif self.step == InitStep.API_KEY:
            lines.append(f"The key for {self.base_url}")
            lines.append("It is saved in credentials.json in the data folder, readable only by you.")
            if self._saved_key:
                lines.append("enter keeps the saved key")
        elif self.step == InitStep.OAUTH_PROVIDER:
            lines += [
                "Sign in with OAuth:",
                f"  {'▸' if self.model_focus == 0 else ' '} anthropic",
                f"  {'▸' if self.model_focus == 1 else ' '} openai",
            ]
        elif self.step == InitStep.OAUTH_WAIT:
            lines.append(f"Signing in to {self.oauth_provider}…")
            lines.append(self.status or "waiting for the browser")
        elif self.step == InitStep.PROBING:
            lines.append(self.status or "discovering models…")
        elif self.step == InitStep.MANUAL_PROTOCOL:
            lines.append(self.status)
            lines.append("select protocol for manual configuration:")
            for i, protocol in enumerate(("openai", "anthropic")):
                lines.append(f"  {'▸' if i == self.model_focus else ' '} {protocol}")
        elif self.step == InitStep.PICK_MODEL:
            lines.append(self.status or "Pick a model:")
            for i, m in enumerate(self.models):
                mark = "▸" if i == self.model_focus else " "
                lines.append(f"  {mark} {m}")
            lines.append("")
            lines.append("enter picks the marked one · or type a model id" if self.models
                         else "type the model id your endpoint uses")
        elif self.step == InitStep.DONE:
            lines.append("Set up.")
            if self.settings:
                lines.append(f"  protocol: {self.settings.auth.protocol}")
                lines.append(f"  model: {self.settings.auth.model}")
        return lines

    def prompt_label(self) -> str:
        if self.step == InitStep.API_URL:
            return "base url"
        if self.step == InitStep.API_KEY:
            return "api key"
        if self.step == InitStep.PICK_MODEL and not self.models:
            return "model id"
        return ""

    def move(self, delta: int) -> None:
        if self.step == InitStep.AUTH_MODE:
            self.model_focus = 0 if (self.model_focus + delta) % 2 == 0 else 1
        elif self.step in {InitStep.OAUTH_PROVIDER, InitStep.MANUAL_PROTOCOL}:
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
            text = text or self.saved_url
            if not text:
                self.error = "Enter a URL"
                return
            try:
                self.base_url = normalize_base_url(text, "openai")
            except ValueError as exc:
                self.error = str(exc)
                return
            self.step = InitStep.API_KEY
        elif self.step == InitStep.API_KEY:
            text = text or self._saved_key
            if not text:
                self.error = "Enter a key"
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
        elif self.step == InitStep.MANUAL_PROTOCOL:
            if text in {"1", "openai", "2", "anthropic"}:
                self.model_focus = 0 if text in {"1", "openai"} else 1
                self._confirm_manual_protocol()
            else:
                self.error = "select openai or anthropic"
        elif self.step == InitStep.PICK_MODEL:
            if text.isdigit() and self.models:
                if not 1 <= int(text) <= len(self.models):
                    self.error = "invalid model selection"
                    return
                self.model_focus = int(text) - 1
            elif text:
                # A model the endpoint did not list (or could not be asked about)
                if text not in self.models:
                    self.models.insert(0, text)
                self.model_focus = self.models.index(text)
            self._confirm_model()

    def confirm(self) -> None:
        """Enter with no new text — confirm current focus."""
        self.error = ""
        if self.step == InitStep.AUTH_MODE:
            self._confirm_auth_mode()
        elif self.step == InitStep.OAUTH_PROVIDER:
            self._confirm_oauth_provider()
        elif self.step == InitStep.MANUAL_PROTOCOL:
            self._confirm_manual_protocol()
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
        self.status = f"Starting {self.oauth_provider} sign-in…"
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
        self.models = list(getattr(session, "models", None) or [])
        self.model_focus = 0
        self.step = InitStep.PICK_MODEL
        self.status = "Signed in · pick a model:"

    def _start_probe(self) -> None:
        self.step = InitStep.PROBING
        self.status = "discovering models…"
        probed = self.probe(self.base_url, self.api_key)
        if probed is None:
            probed = ProbeResult("openai", [], inferred=True, status="failed")
        self.protocol = probed.protocol
        self.models = list(probed.models)
        self.base_url = probed.base_url or self.base_url
        self.status = probed.summary()
        self.model_focus = 0
        if probed.inferred or probed.status == "failed":
            self.model_focus = 1 if self.protocol == "anthropic" else 0
            self.step = InitStep.MANUAL_PROTOCOL
        else:
            self.step = InitStep.PICK_MODEL

    def _confirm_manual_protocol(self) -> None:
        self.protocol = "openai" if self.model_focus == 0 else "anthropic"
        self.base_url = normalize_base_url(self.base_url, self.protocol)
        self.status = f"manual configuration ({self.protocol}); model is unverified"
        self.model_focus = 0
        self.step = InitStep.PICK_MODEL

    def _confirm_model(self) -> None:
        if not self.models:
            self.error = "enter a model id; no models were discovered"
            return
        model = self.models[self.model_focus]
        if self.mode == "oauth":
            settings = with_connection(ModelAuth(
                mode="oauth",
                protocol=self.protocol,
                base_url=self.base_url,
                model=model,
                oauth_provider=self.oauth_provider,
                api_key_ref="oauth_access_token",
            ), self.home)
            save_credentials(
                {
                    "oauth_access_token": self._oauth_token or "mock-token",
                    "oauth_refresh_token": "",
                },
                self.home,
            )
        else:
            settings = with_connection(ModelAuth(
                mode="api_key",
                protocol=self.protocol,
                base_url=self.base_url,
                model=model,
            ), self.home)
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
        from circle.paths import circle_home

        home = self.home or circle_home()
        return [
            "Trust this folder?",
            f"  {self.workspace}",
            "",
            "Circle reads, edits and runs commands here, asking first for anything that",
            "changes files. Trusting also loads the folder's own commands, skills and",
            f"extensions, and is saved in {home / 'settings.json'}.",
            "",
            f"  {'▸' if self.focus == 0 else ' '} Trust and continue",
            f"  {'▸' if self.focus == 1 else ' '} Quit",
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
