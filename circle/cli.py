"""circle CLI — ink TUI gate (init → trust → main) with line-mode fallback."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from circle import __version__
from circle.paths import circle_home, normalize_workspace
from circle.settings import is_folder_trusted, load_settings


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="circle",
        description="Circle — compile harness",
    )
    parser.add_argument(
        "workspace",
        nargs="?",
        default=".",
        help="工作区目录（默认当前目录）",
    )
    parser.add_argument("--version", action="store_true", help="打印版本后退出")
    parser.add_argument("-p", "--print", dest="prompt", help="非交互执行一次任务")
    parser.add_argument("--mode", choices=("text", "json", "rpc"), default="text")
    parser.add_argument("--session", help="持久会话 ID")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--file", action="append", default=[], help="附加文件或图片")
    parser.add_argument("--extension-flag", action="append", default=[], metavar="NAME=VALUE")
    parser.add_argument("--connection", help="命名模型连接")
    parser.add_argument("--list-models", action="store_true")
    parser.add_argument(
        "--init",
        action="store_true",
        help="强制重跑用户初始化",
    )
    parser.add_argument(
        "--print-home",
        action="store_true",
        help="打印 CIRCLE_HOME 后退出",
    )
    parser.add_argument(
        "--line",
        action="store_true",
        help="强制行模式（跳过全屏 ink TUI）",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    supplied = list(argv if argv is not None else sys.argv[1:])
    if supplied and supplied[0] in {"plugins", "auth"}:
        from circle.management import run_management
        return run_management(supplied, home=circle_home())
    args = _build_parser().parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.print_home:
        print(circle_home())
        return 0

    home = circle_home()
    workspace = normalize_workspace(args.workspace)
    settings = load_settings(home)
    if args.connection:
        from circle.model_registry import ModelRegistry
        ModelRegistry(settings, home).select_connection(args.connection)
    if args.extension_flag:
        from circle.extensions import ExtensionHost
        host = ExtensionHost(home=home, workspace=workspace, trusted=is_folder_trusted(settings, workspace),
                             settings=settings.extensions).load()
        registered = host.flags()
        for item in args.extension_flag:
            name, separator, value = item.partition("=")
            if not separator or name not in registered:
                raise ValueError("Extension flag must be registered and use NAME=VALUE")
            settings.extension_flags[name] = value
    if args.list_models:
        import json
        from circle.model_registry import ModelRegistry
        print(json.dumps(ModelRegistry(load_settings(home), home).catalog(), ensure_ascii=False))
        return 0
    automated = args.prompt is not None or args.mode != "text"
    use_tui = (
        not automated and not args.line
        and sys.stdin.isatty()
        and sys.stdout.isatty()
        and not (os_environ_no_tui())
    )
    if use_tui:
        from circle.tui.session_app import run_circle_session

        return run_circle_session(workspace, home=home, force_init=args.init, settings_override=settings)

    # Line-mode fallback (CI / pipes)
    from circle.init_flow import run_init
    from circle.trust_flow import run_trust_prompt

    if args.init or not settings.is_ready():
        if not sys.stdin.isatty():
            print(
                "Circle 尚未初始化。请在交互终端运行 `circle`。",
                file=sys.stderr,
            )
            return 2
        settings = run_init(home=home)

    if not workspace.is_dir():
        print(f"工作区不存在: {workspace}", file=sys.stderr)
        return 2

    if not is_folder_trusted(settings, workspace):
        if not sys.stdin.isatty():
            print(f"工作区尚未 trust: {workspace}", file=sys.stderr)
            return 2
        trusted = run_trust_prompt(settings, workspace, home=home)
        if trusted is None:
            return 1
        settings = trusted

    from circle.main_session import run_main

    if args.mode == "rpc":
        import asyncio
        from circle.acp_server import serve_acp
        asyncio.run(serve_acp(settings, home=home))
        return 0
    if automated:
        from circle.headless import run_headless
        return run_headless(settings, workspace, home=home, prompt=args.prompt or sys.stdin.read(),
                            mode=args.mode, session_id=args.session, plan_mode=args.plan, files=args.file)

    return run_main(settings, workspace, home=home)


def os_environ_no_tui() -> bool:
    import os

    return os.environ.get("CIRCLE_NO_TUI", "").strip() in {"1", "true", "yes"}


if __name__ == "__main__":
    raise SystemExit(main())
