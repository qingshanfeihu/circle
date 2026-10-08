"""User-level ~/.circle/settings.json (Claude-style) + credentials side file."""

from __future__ import annotations

import json
import os
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from circle.paths import (
    credentials_path,
    ensure_home,
    normalize_workspace,
    settings_path,
)


SETTINGS_VERSION = 1


@dataclass
class ModelAuth:
    """One completed model connection. Secrets live in credentials.json."""

    mode: str = "api_key"  # api_key | oauth
    protocol: str = "openai"  # openai | anthropic
    base_url: str = ""
    model: str = ""
    # credential file keys; never store raw secrets here
    api_key_ref: str = "api_key"
    oauth_provider: str = ""  # anthropic | openai when mode=oauth


@dataclass
class CircleSettings:
    version: int = SETTINGS_VERSION
    initialized: bool = False
    auth: ModelAuth = field(default_factory=ModelAuth)
    trusted_folders: list[str] = field(default_factory=list)
    theme: str = "auto"
    # MCP server stubs: [{name, command|url, ...}]
    mcp_servers: list[dict[str, Any]] = field(default_factory=list)
    # 扩展开关：{name: {"enabled": bool}}；没写的扩展默认启用（circle/extensions.py）
    extensions: dict[str, dict[str, Any]] = field(default_factory=dict)
    # shell 命令点名这些文件（basename 通配）即拒绝执行；为空时用 circle.approvals 的默认表
    credential_files: list[str] = field(default_factory=list)
    # Once a day at start, ask GitHub for a newer release and say so in one line
    # (circle/update.py)
    update_check: bool = True
    # The thinking depth a session starts with ("" = Circle's default for the protocol)
    default_thinking: str = ""
    # Models ctrl+p cycles through: ids or patterns ("*" "?" globs); empty = all listed
    enabled_models: list[str] = field(default_factory=list)
    # What esc twice on an empty box opens: "tree", "fork" or "none"
    double_escape: str = "tree"
    # Start sessions with the model's thinking rows hidden (/thinking shows them)
    hide_thinking: bool = False
    # Per model: {"glm-5.3": {"context_window": 1000000}}. The window replaces the one from
    # models.dev for the footer and the automatic compaction (circle/model_catalog.py)
    models: dict[str, dict[str, Any]] = field(default_factory=dict)

    def is_ready(self) -> bool:
        if not self.initialized:
            return False
        if self.auth.mode == "api_key":
            return bool(self.auth.base_url and self.auth.model)
        if self.auth.mode == "oauth":
            return bool(self.auth.oauth_provider and self.auth.model)
        return False


def _default_dict() -> dict[str, Any]:
    return asdict(CircleSettings())


def _theme_name(value: object) -> str:
    """``auto`` follows the terminal, ``dark`` and ``light`` override it. Older files say
    ``terminal`` for what is now ``auto``; anything unknown also means ``auto``."""
    name = str(value or "").strip().lower()
    return name if name in ("dark", "light") else "auto"


def load_settings(home: Path | None = None) -> CircleSettings:
    path = settings_path(home)
    if not path.is_file():
        return CircleSettings()
    return load_settings_from_dict(json.loads(path.read_text(encoding="utf-8")))


def load_settings_from_dict(raw: dict[str, Any]) -> CircleSettings:
    """Settings from their JSON form, with defaults for what is missing or malformed."""
    auth_raw = raw.get("auth") or {}
    auth = ModelAuth(
        mode=str(auth_raw.get("mode") or "api_key"),
        protocol=str(auth_raw.get("protocol") or "openai"),
        base_url=str(auth_raw.get("base_url") or ""),
        model=str(auth_raw.get("model") or ""),
        api_key_ref=str(auth_raw.get("api_key_ref") or "api_key"),
        oauth_provider=str(auth_raw.get("oauth_provider") or ""),
    )
    folders = [str(p) for p in (raw.get("trusted_folders") or []) if str(p).strip()]
    mcp_raw = raw.get("mcp_servers") or []
    mcp_servers: list[dict[str, Any]] = [
        dict(item) for item in mcp_raw if isinstance(item, dict)
    ]
    ext_raw = raw.get("extensions") or {}
    extensions: dict[str, dict[str, Any]] = {
        str(name): dict(cfg) for name, cfg in ext_raw.items() if isinstance(cfg, dict)
    } if isinstance(ext_raw, dict) else {}
    cred_raw = raw.get("credential_files") or []
    credential_files = [str(p) for p in cred_raw if str(p).strip()] if isinstance(
        cred_raw, list) else []
    enabled_raw = raw.get("enabled_models") or []
    enabled_models = [str(p) for p in enabled_raw if str(p).strip()] if isinstance(
        enabled_raw, list) else []
    models_raw = raw.get("models") or {}
    models = {str(name): dict(entry) for name, entry in models_raw.items()
              if str(name).strip() and isinstance(entry, dict)} if isinstance(
        models_raw, dict) else {}
    return CircleSettings(
        version=int(raw.get("version") or SETTINGS_VERSION),
        initialized=bool(raw.get("initialized")),
        auth=auth,
        trusted_folders=folders,
        theme=_theme_name(raw.get("theme")),
        mcp_servers=mcp_servers,
        extensions=extensions,
        credential_files=credential_files,
        update_check=bool(raw.get("update_check", True)),
        default_thinking=str(raw.get("default_thinking") or "").strip().lower(),
        enabled_models=enabled_models,
        double_escape=_double_escape(raw.get("double_escape")),
        hide_thinking=bool(raw.get("hide_thinking")),
        models=models,
    )


DOUBLE_ESCAPE_ACTIONS = ("tree", "fork", "none")


def _double_escape(value: Any) -> str:
    name = str(value or "").strip().lower()
    return name if name in DOUBLE_ESCAPE_ACTIONS else "tree"


# What a project's .circle/settings.json may set for that folder. The endpoint, the key,
# MCP servers, extensions and trusted folders stay yours: a repository cannot change them.
PROJECT_KEYS = ("model", "default_thinking", "enabled_models", "double_escape",
                "hide_thinking", "theme", "credential_files")


def project_settings_path(workspace: str | Path) -> Path:
    return Path(workspace) / ".circle" / "settings.json"


def apply_project_settings(settings: CircleSettings, workspace: str | Path
                           ) -> tuple[dict[str, tuple[Any, Any]], list[str]]:
    """Put a project's own settings over yours, in memory. Returns, for each key set,
    ``(your value, the project's)`` so a save can write yours back, and the problems found
    (unknown or refused keys). ``credential_files`` is added to yours, never narrowed."""
    path = project_settings_path(workspace)
    if not path.is_file():
        return {}, []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return {}, [f"{path} could not be read: {exc}"]
    if not isinstance(raw, dict):
        return {}, [f"{path} should be a JSON object"]
    problems = [f"{path}: {key!r} is not a project setting (allowed: {', '.join(PROJECT_KEYS)})"
                for key in raw if key not in PROJECT_KEYS]
    project = load_settings_from_dict({**asdict(settings), **{
        key: value for key, value in raw.items() if key in PROJECT_KEYS and key != "model"}})
    changed: dict[str, tuple[Any, Any]] = {}
    model = raw.get("model")
    if isinstance(model, str) and model.strip() and model.strip() != settings.auth.model:
        changed["model"] = (settings.auth.model, model.strip())
        settings.auth.model = model.strip()
    for key in PROJECT_KEYS:
        if key == "model" or key not in raw:
            continue
        mine, theirs = getattr(settings, key), getattr(project, key)
        if key == "credential_files":
            theirs = list(dict.fromkeys([*mine, *theirs]))
        if theirs != mine:
            changed[key] = (deepcopy(mine), deepcopy(theirs))
            setattr(settings, key, theirs)
    return changed, problems


def without_project_settings(settings: CircleSettings,
                             changed: dict[str, tuple[Any, Any]]) -> CircleSettings:
    """``settings`` as they belong in your settings.json: each key a project set, and that
    still has the project's value, back to yours. A key changed since stays changed."""
    if not changed:
        return settings
    out = deepcopy(settings)
    for key, (mine, theirs) in changed.items():
        if key == "model":
            if out.auth.model == theirs:
                out.auth.model = mine
        elif getattr(out, key) == theirs:
            setattr(out, key, deepcopy(mine))
    return out


def with_connection(auth: ModelAuth, home: Path | None = None) -> CircleSettings:
    """Your settings with a new model connection. Setup, ``circle --init`` included, replaces
    the endpoint and the model and keeps everything else; the models ctrl+p goes through
    were the old endpoint's, so they are cleared when the endpoint changes."""
    try:
        out = load_settings(home)
    except (OSError, ValueError):
        out = CircleSettings()  # a file that cannot be read is what setup is there to fix
    if out.auth.base_url.rstrip("/") != auth.base_url.rstrip("/"):
        out.enabled_models = []
    out.initialized = True
    out.auth = auth
    return out


def save_settings(settings: CircleSettings, home: Path | None = None) -> Path:
    root = ensure_home(home)
    path = settings_path(root)
    payload = asdict(settings)
    # Keys Circle does not know (your own, or a newer version's) stay in the file
    try:
        previous = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        previous = {}
    if isinstance(previous, dict):
        payload.update({key: value for key, value in previous.items() if key not in payload})
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def load_credentials(home: Path | None = None) -> dict[str, str]:
    path = credentials_path(home)
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {str(k): str(v) for k, v in raw.items()}


def save_credentials(creds: dict[str, str], home: Path | None = None) -> Path:
    root = ensure_home(home)
    path = credentials_path(root)
    existing = load_credentials(root)
    existing.update(creds)
    path.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return path


def clear_credentials(home: Path | None = None) -> Path:
    """Wipe ~/.circle/credentials.json (logout)."""
    root = ensure_home(home)
    path = credentials_path(root)
    path.write_text("{}\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    for key in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_BASE_URL",
        "CIRCLE_MODEL",
    ):
        os.environ.pop(key, None)
    return path


def is_folder_trusted(settings: CircleSettings, workspace: str | Path) -> bool:
    target = str(normalize_workspace(workspace))
    trusted = {str(normalize_workspace(p)) for p in settings.trusted_folders}
    return target in trusted


def trust_folder(settings: CircleSettings, workspace: str | Path) -> CircleSettings:
    target = str(normalize_workspace(workspace))
    updated = deepcopy(settings)
    if target not in updated.trusted_folders:
        updated.trusted_folders.append(target)
    return updated


def apply_auth_to_environ(settings: CircleSettings, home: Path | None = None) -> None:
    """Export process env for the harness from saved settings + credentials."""
    creds = load_credentials(home)
    auth = settings.auth
    key = creds.get(auth.api_key_ref) or creds.get("api_key") or ""
    if auth.protocol == "anthropic":
        if auth.base_url:
            os.environ["ANTHROPIC_BASE_URL"] = auth.base_url
        if key:
            os.environ["ANTHROPIC_API_KEY"] = key
    else:
        if auth.base_url:
            os.environ["OPENAI_BASE_URL"] = auth.base_url
        if key:
            os.environ["OPENAI_API_KEY"] = key
    if auth.model:
        os.environ["CIRCLE_MODEL"] = auth.model
