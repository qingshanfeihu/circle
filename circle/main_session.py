"""Minimal main session shell after init + trust."""

from __future__ import annotations

from pathlib import Path

from circle.harness import create_harness
from circle.model import build_chat_model
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

    agent = create_harness(
        build_chat_model(settings, home=home),
        root_dir=workspace,
    )
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
                config={"configurable": {"thread_id": "circle-main"}},
            )
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
