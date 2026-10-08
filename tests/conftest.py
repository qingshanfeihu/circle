"""Suite-wide defaults."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_update_check(monkeypatch):
    """Starting a session asks GitHub for the newest release. Tests never go to the network;
    the ones about the check clear this again."""
    monkeypatch.setenv("CIRCLE_NO_UPDATE_CHECK", "1")


@pytest.fixture(autouse=True)
def _models_dev_offline(monkeypatch):
    """No models.dev fetch at session start, and each test begins with the shipped snapshot
    and no bound endpoint (circle.model_catalog keeps both process-wide)."""
    from circle import model_catalog

    monkeypatch.setenv("CIRCLE_NO_MODELS_REFRESH", "1")
    model_catalog.set_catalog(None)
    model_catalog.bind_endpoint()
    yield
    model_catalog.set_catalog(None)
    model_catalog.bind_endpoint()
