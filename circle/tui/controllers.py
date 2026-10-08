"""Init / OAuth / Trust screen controllers — shared by ink TUI and selftest."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
from pathlib import Path
from typing import Callable

from circle.ink.components.dialog_card import CardLine, CardOption, CardSpec
from circle.oauth import OAuthNotConfiguredError, oauth_available, start_oauth_login
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
from circle.trust import FolderItem, accept_trust, folder_inventory

# The longest body line of a gate card, in columns
CARD_MEASURE = 76
# How many models the list shows at once
MODEL_ROWS = 8


def _home_path(path: Path) -> str:
    """``path`` with your home folder written as ``~``."""
    text = str(path)
    user = str(Path.home())
    return "~" + text[len(user):] if text == user or text.startswith(user + "/") else text


def _sentence(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


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
    # /login in a session: the key moves the flow to PROBING and the caller runs run_probe()
    # off the input thread; the session saves the connection itself (auth, credentials)
    defer_probe: bool = False
    persist: bool = True
    auth: ModelAuth | None = None
    credentials: dict[str, str] = field(default_factory=dict)
    # What is typed under the model list: it keeps the models with every word in them
    query: str = ""

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

    @property
    def has_saved_key(self) -> bool:
        return bool(self._saved_key)

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
            if not oauth_available():
                self.model_focus = 0  # the only way in that works
                return
            self.model_focus = 0 if (self.model_focus + delta) % 2 == 0 else 1
        elif self.step in {InitStep.OAUTH_PROVIDER, InitStep.MANUAL_PROTOCOL}:
            self.model_focus = 0 if (self.model_focus + delta) % 2 == 0 else 1
        elif self.step == InitStep.PICK_MODEL and self.models:
            self.model_focus = (self.model_focus + delta) % len(self.models)

    def submit_line(self, text: str) -> None:
        text = text.strip()
        self.error = ""
        if self.step == InitStep.AUTH_MODE:
            if text == "2" and not oauth_available():
                return  # listed so you know it is coming, but it cannot be chosen yet
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
        if self.model_focus != 0 and not oauth_available():
            return
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
        if not self.defer_probe:
            self.run_probe()

    def run_probe(self) -> None:
        """Ask the endpoint for its models; it can take seconds (2.5 s per request)."""
        self.apply_probe(self.probe(self.base_url, self.api_key))

    def apply_probe(self, probed: ProbeResult | None) -> None:
        """Move on with what the endpoint answered (None: it could not be asked)."""
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
            self.auth = ModelAuth(
                mode="oauth",
                protocol=self.protocol,
                base_url=self.base_url,
                model=model,
                oauth_provider=self.oauth_provider,
                api_key_ref="oauth_access_token",
            )
            self.credentials = {
                "oauth_access_token": self._oauth_token or "mock-token",
                "oauth_refresh_token": "",
            }
        else:
            self.auth = ModelAuth(
                mode="api_key",
                protocol=self.protocol,
                base_url=self.base_url,
                model=model,
            )
            self.credentials = {"api_key": self.api_key}
        if self.persist:
            settings = with_connection(self.auth, self.home)
            save_credentials(self.credentials, self.home)
            save_settings(settings, self.home)
            self.settings = settings
        self.step = InitStep.DONE

    @property
    def done(self) -> bool:
        return self.step == InitStep.DONE and self.auth is not None

    # ── the card a full-screen session shows for each step ─────────────────

    def matches(self) -> list[str]:
        """The models with every word of ``query`` in them, in the endpoint's order."""
        words = self.query.lower().split()
        return [m for m in self.models if all(w in m.lower() for w in words)]

    def _choices(self) -> list[str]:
        """The model list's rows: the matches, then the typed id when it is not one of them."""
        found = self.matches()
        typed = self.query.strip()
        return found + ([f"use:{typed}"] if typed and typed not in self.models else [])

    def set_query(self, text: str) -> None:
        if text != self.query:
            self.query = text
            self.model_focus = 0

    def move_choice(self, delta: int) -> None:
        rows = self._choices()
        if rows:
            self.model_focus = (self.model_focus + delta) % len(rows)

    def pick_choice(self) -> None:
        """Enter on the model list: the marked row, or the typed id."""
        self.error = ""
        rows = self._choices()
        if not rows:
            self.error = ("enter a model id: the endpoint listed none" if not self.models
                          else "no model has that name")
            return
        chosen = rows[min(self.model_focus, len(rows) - 1)]
        model = chosen.removeprefix("use:")
        if model not in self.models:
            self.models.insert(0, model)
        self.model_focus = self.models.index(model)
        self.query = ""
        self._confirm_model()

    def input_step(self) -> bool:
        """Whether this step reads a line of text (the card shows the input row)."""
        return self.step in {InitStep.API_URL, InitStep.API_KEY, InitStep.PICK_MODEL}

    def placeholder(self) -> str:
        if self.step == InitStep.API_URL and self.saved_url:
            return f"enter keeps {self.saved_url}"
        if self.step == InitStep.API_KEY and self._saved_key:
            return "enter keeps the saved key"
        if self.step == InitStep.PICK_MODEL:
            return "type to search" if self.models else "model id"
        return ""

    def card_spec(self) -> CardSpec | None:
        """The step as a card for the session's frame; None once there is nothing to ask."""
        from circle.paths import circle_home

        problem = [CardLine("", segments=(("✖ ", "warn"), (_sentence(self.error), "text")))] if self.error else []
        if self.step == InitStep.AUTH_MODE:
            oauth = oauth_available()
            return CardSpec("How does Circle reach your model?", body=problem, options=[
                CardOption("API URL + KEY"),
                CardOption("OAuth sign-in", note="" if oauth else "not available yet", enabled=oauth)],
                focus=self.model_focus, measure=CARD_MEASURE)
        if self.step == InitStep.API_URL:
            return CardSpec("What is the API's base URL?", body=problem + [
                CardLine("An OpenAI-style or Anthropic-style API, such as https://api.openai.com/v1", "dim")],
                input_row=True, measure=CARD_MEASURE)
        if self.step == InitStep.API_KEY:
            where = _home_path((self.home or circle_home()) / "credentials.json")
            return CardSpec("What is the API key?", body=problem + [
                CardLine("", segments=(("for ", "dim"), (self.base_url, "text"))),
                CardLine(f"Saved in {where}, readable only by you.", "dim")],
                input_row=True, measure=CARD_MEASURE)
        if self.step == InitStep.OAUTH_PROVIDER:
            return CardSpec("Sign in with OAuth", body=problem, options=[
                CardOption("anthropic"), CardOption("openai")], focus=self.model_focus, measure=CARD_MEASURE)
        if self.step == InitStep.OAUTH_WAIT:
            return CardSpec(f"Signing in to {self.oauth_provider}…", lamp="running",
                            body=[CardLine(self.status or "waiting for the browser", "dim")], measure=CARD_MEASURE)
        if self.step == InitStep.PROBING:
            return CardSpec("Looking for models…", lamp="running", body=[
                CardLine("", segments=(("asking ", "dim"), (self.base_url, "text")))], measure=CARD_MEASURE)
        if self.step == InitStep.MANUAL_PROTOCOL:
            return CardSpec("Which kind of API is it?", body=problem + [
                CardLine("", segments=(("✖ ", "warn"), (_sentence(self.status), "text"))),
                CardLine("Pick the kind, then type the model id.", "dim")],
                options=[CardOption("OpenAI-style API"), CardOption("Anthropic-style API")],
                focus=self.model_focus, measure=CARD_MEASURE)
        if self.step == InitStep.PICK_MODEL:
            return self._model_card(problem)
        return None

    def _model_card(self, problem: list[CardLine]) -> CardSpec:
        from urllib.parse import urlparse

        if self.models and self.status.startswith("discovered"):
            host = urlparse(self.base_url).hostname or self.base_url
            about = CardLine("", segments=((f"{len(self.models)} models at ", "dim"), (host, "text")))
        elif self.models:
            about = CardLine(_sentence(self.status), "dim")
        else:
            about = CardLine(_sentence(self.status or "no models were listed") + ". Type the model id your "
                             "endpoint uses.", "dim")
        rows = self._choices()
        focus = min(self.model_focus, max(0, len(rows) - 1))
        top = min(max(0, focus - MODEL_ROWS + 1), max(0, len(rows) - MODEL_ROWS))
        window = rows[top:top + MODEL_ROWS]
        options = [CardOption(f'use "{row.removeprefix("use:")}"', note="not listed") if row.startswith("use:")
                   else CardOption(row)
                   for row in window]
        position = f"({focus + 1}/{len(rows)})" if len(rows) > MODEL_ROWS else ""
        return CardSpec("Which model?", body=problem + [about], options=options, focus=focus - top,
                        keys=False, position=position, input_row=True, measure=CARD_MEASURE)


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

    def inventory(self) -> list[FolderItem]:
        """What trusting loads from the folder, looked up once."""
        found = getattr(self, "_inventory", None)
        if found is None:
            try:
                found = folder_inventory(self.workspace, self.home)
            except OSError:
                found = []
            self._inventory = found
        return found

    def card_spec(self) -> CardSpec:
        from circle.paths import circle_home

        items = self.inventory()
        body = [CardLine(_home_path(self.workspace)), CardLine(""),
                CardLine("Circle reads, edits and runs commands here."),
                CardLine("It asks before anything that changes files."), CardLine("")]
        if items:
            body.append(CardLine(f"Trusting also loads {loads_summary(items)}.", "dim"))
            extensions = next((item.count for item in items if item.kind == "extensions"), 0)
            if extensions:
                body.append(CardLine("The extension runs its own code when circle starts." if extensions == 1
                                     else "The extensions run their own code when circle starts.", "warn"))
        else:
            body.append(CardLine("The folder brings no instructions, skills, commands or extensions.", "dim"))
        saved = _home_path((self.home or circle_home()) / "settings.json")
        return CardSpec("Trust this folder?", body=body, options=[
            CardOption("Trust and continue", note=f"saved in {saved}"), CardOption("Quit")],
            focus=self.focus, measure=CARD_MEASURE)

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


def loads_summary(items: list[FolderItem]) -> str:
    """``its AGENTS.md, 3 skills, 2 commands and 1 extension``."""
    parts: list[str] = []
    for item in items:
        if item.kind == "instructions":
            parts.append("its " + " and ".join(item.names) if len(item.names) <= 2
                         else f"its {item.count} instruction files")
        elif item.kind == "settings":
            parts.append("its settings")
        else:
            noun = item.kind if item.count != 1 else item.kind[:-1]
            parts.append(f"{item.count} {noun}")
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]
