"""Suite-wide defaults."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _no_update_check(monkeypatch):
    """Starting a session asks GitHub for the newest release. Tests never go to the network;
    the ones about the check clear this again."""
    monkeypatch.setenv("CIRCLE_NO_UPDATE_CHECK", "1")
