"""Minimal main session shell after init + trust."""

from __future__ import annotations

import uuid
from pathlib import Path

from langgraph.types import Command

from circle.paths import circle_home
from circle.runtime import create_session_runtime
from circle.settings import CircleSettings, apply_auth_to_environ
from circle.tui.slash_commands import help_text, parse_slash


def run_main(
    settings: CircleSettings,
    workspace: Path,
    *,
    home: Path | None = None,
) -> int:
    apply_auth_to_environ(settings, home)
    model_name = settings.auth.model
    print(f"Circle · {workspace}")
    print(f"模型: {model_name} · 协议: {settings.auth.protocol}")
    print("输入消息后回车；/help 查看命令；空行或 /exit 离开。")
    print("（行模式；全屏 ink TUI 请直接运行 circle）")

    agent = create_session_runtime(settings, workspace, home=home or circle_home())
    thread_id = "circle-" + uuid.uuid4().hex[:12]
    config = {"configurable": {"thread_id": thread_id}}
    while True:
        try:
            line = input("you> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if not line:
            return 0
        parsed = parse_slash(line)
        if parsed is not None:
            if parsed.name == "exit":
                return 0
            if parsed.name == "help":
                print(help_text())
                continue
            print(
                f"（行模式仅支持 /help /exit；/{parsed.raw_name} 请用全屏 TUI）"
            )
            continue
        try:
            result = agent.invoke(
                {"messages": [{"role": "user", "content": line}]},
                config=config,
            )
            while agent.get_state(config).interrupts:
                decisions = []
                for interrupted in agent.get_state(config).interrupts:
                    for request in interrupted.value.get("action_requests", []):
                        from circle.middleware.redact import redact
                        print(redact(f"审批: {request['name']} {request.get('args', {})}"))
                        choice = input("approve / reject> ").strip().lower()
                        decisions.append({"type": "approve" if choice == "approve" else "reject"})
                if not decisions:
                    print("该中断需要 TUI 或 ACP 客户端回答。")
                    break
                result = agent.invoke(Command(resume={"decisions": decisions}), config=config)
        except Exception as exc:  # noqa: BLE001 — surface to user in shell
            print(f"错误: {exc}")
            continue
        messages = result.get("messages") or []
        if messages:
            last = messages[-1]
            content = getattr(last, "content", None) or (
                last.get("content") if isinstance(last, dict) else last
            )
            print(f"circle> {content}")
        else:
            print("circle> （无输出）")
    return 0
