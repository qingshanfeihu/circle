"""Named connections and upstream catalog discovery without provider guessing."""
from __future__ import annotations

from dataclasses import fields
from pathlib import Path

from circle.provider_bridge import bridge_call
from circle.settings import CircleSettings, ModelAuth


class ModelRegistry:
    def __init__(self, settings: CircleSettings, home: Path):
        self.settings, self.home = settings, home

    def select_connection(self, name: str) -> ModelAuth:
        data = self.settings.connections[name]
        allowed = {field.name for field in fields(ModelAuth)}
        if set(data) - allowed:
            raise ValueError(f"Unknown connection fields: {sorted(set(data) - allowed)}")
        auth = ModelAuth(**data)
        if auth.engine not in {"langchain", "pi"} or not auth.model:
            raise ValueError("Connection needs an engine and model")
        self.settings.auth = auth
        self.settings.initialized = True
        return auth

    def catalog(self) -> list[dict]:
        return bridge_call("catalog", {}, home=self.home)
