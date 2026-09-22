#!/usr/bin/env python3
"""Print headless TUI screen snapshots for OAuth + API Key + Trust + Permission.

Usage:
  CIRCLE_OAUTH_MOCK=1 python3 scripts/selftest_tui_demo.py
  CIRCLE_OAUTH_MOCK=1 .venv311/bin/python scripts/selftest_tui_demo.py
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from langchain_core.messages import AIMessage

from circle.probe import ProbeResult
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.session import MainController


def banner(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


def show(lines: list[str]) -> None:
    for ln in lines:
        print(ln)


def main() -> int:
    os.environ["CIRCLE_OAUTH_MOCK"] = "1"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        home = root / "home"
        ws = root / "project"
        ws.mkdir()

        banner("1) API URL + KEY 初始化屏")
        api = InitController(
            home=home / "api",
            probe=lambda u, k: ProbeResult(protocol="anthropic", models=["claude-demo", "claude-flash"]),
        )
        show(api.body_lines())
        api.submit_line("1")
        api.submit_line("https://api.example.com")
        api.submit_line("sk-demo")
        show(api.body_lines())
        api.confirm()
        show(api.body_lines())

        banner("2) OAuth 初始化屏")
        oauth = InitController(home=home / "oauth")
        show(oauth.body_lines())
        oauth.submit_line("2")
        show(oauth.body_lines())
        oauth.confirm()
        show(oauth.body_lines())
        oauth.confirm()
        show(oauth.body_lines())

        banner("3) Trust 工作区屏")
        assert oauth.settings is not None
        trust = TrustController(oauth.settings, ws, home=home / "oauth")
        show(trust.body_lines())
        trust.confirm()
        print(f".agent created: {(ws / '.agent').is_dir()}")

        banner("4) 主会话 + 权限沙箱（write_file 需批准）")
        tool_call = {
            "name": "write_file",
            "args": {"file_path": "/demo.txt", "content": "from-selftest"},
            "id": "call_1",
            "type": "tool_call",
        }
        model = ScriptedModel(
            responses=[
                AIMessage(content="", tool_calls=[tool_call]),
                AIMessage(content="file written"),
            ]
        )
        main_ctl = MainController(
            oauth.settings, ws, home=home / "oauth", model_override=model
        )
        show(main_ctl.body_lines())
        main_ctl.submit_user("write demo.txt")
        show(main_ctl.body_lines())
        print(f"phase={main_ctl.phase}")
        main_ctl.confirm_approval()
        show(main_ctl.body_lines())
        print(f"demo.txt => {(ws / 'demo.txt').read_text(encoding='utf-8')}")
        print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
