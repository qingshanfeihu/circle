"""Explicit user commands for credentials, installed plugins and sessions."""
from __future__ import annotations

import argparse
import getpass
import json
from pathlib import Path

from circle.plugins import PluginManager
from circle.settings import ModelAuth, load_settings, save_settings


def run_management(argv, *, home: Path):
    parser = argparse.ArgumentParser(prog="circle " + argv[0])
    if argv[0] == "plugins":
        parser.add_argument("action", choices=("list", "install", "remove", "update", "enable", "disable"))
        parser.add_argument("source", nargs="?")
        args = parser.parse_args(argv[1:])
        if args.action not in {"list", "update"} and not args.source:
            parser.error("source is required")
        manager = PluginManager(home)
        if args.action == "list":
            print(json.dumps(manager.list(), ensure_ascii=False, indent=2))
        elif args.action == "update":
            manager.reconcile(manager.read()["sources"])
        elif args.action in {"enable", "disable"}:
            settings = load_settings(home)
            settings.extensions[args.source] = {"enabled": args.action == "enable"}
            save_settings(settings, home)
        elif not args.source:
            parser.error("source is required")
        elif args.action == "install":
            manager.install(args.source)
        else:
            manager.remove(args.source)
        return 0
    if argv[0] == "auth":
        from circle.oauth import start_oauth_login
        from circle.provider_bridge import bridge_call
        parser.add_argument("action", choices=("login", "logout"))
        parser.add_argument("provider")
        args = parser.parse_args(argv[1:])
        if args.action == "logout":
            bridge_call("logout", {"provider": "openai-codex" if args.provider == "openai" else args.provider}, home=home)
        else:
            session = start_oauth_login(args.provider, home=home,
                on_prompt=lambda q: getpass.getpass(q["message"] + ": ") if q["type"] == "secret" else input(q["message"] + ": "),
                on_event=lambda event: print(event.get("message") or event.get("url") or event.get("verificationUri") or "授权处理中"))
            if not session.models:
                raise ValueError("Provider returned no selectable model")
            settings = load_settings(home)
            settings.auth = ModelAuth(mode="oauth", engine=session.engine, provider=session.provider_id,
                                      model=session.models[0], oauth_provider=args.provider)
            settings.initialized = True
            save_settings(settings, home)
            print("登录完成；凭据由 provider SDK 独立保存")
        return 0
    raise ValueError("Unknown management command")
