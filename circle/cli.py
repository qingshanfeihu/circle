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
    args = _build_parser().parse_args(argv)
    if args.version:
        print(__version__)
        return 0
    if args.print_home:
        print(circle_home())
        return 0

    home = circle_home()
    workspace = normalize_workspace(args.workspace)
    use_tui = (
        not args.line
        and sys.stdin.isatty()
        and sys.stdout.isatty()
        and not (os_environ_no_tui())
    )
    if use_tui:
        from circle.tui.session_app import run_circle_session

        return run_circle_session(workspace, home=home, force_init=args.init)

    # Line-mode fallback (CI / pipes)
    from circle.init_flow import run_init
    from circle.trust_flow import run_trust_prompt

    settings = load_settings(home)
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

    return run_main(settings, workspace, home=home)


def os_environ_no_tui() -> bool:
    import os

    return os.environ.get("CIRCLE_NO_TUI", "").strip() in {"1", "true", "yes"}


if __name__ == "__main__":
    raise SystemExit(main())
