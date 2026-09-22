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
    theme: str = "terminal"

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


def load_settings(home: Path | None = None) -> CircleSettings:
    path = settings_path(home)
    if not path.is_file():
        return CircleSettings()
    raw = json.loads(path.read_text(encoding="utf-8"))
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
    return CircleSettings(
        version=int(raw.get("version") or SETTINGS_VERSION),
        initialized=bool(raw.get("initialized")),
        auth=auth,
        trusted_folders=folders,
        theme=str(raw.get("theme") or "terminal"),
    )


def save_settings(settings: CircleSettings, home: Path | None = None) -> Path:
    root = ensure_home(home)
    path = settings_path(root)
    payload = asdict(settings)
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
