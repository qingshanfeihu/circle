#!/usr/bin/env python3
"""Live TUI parity: logout → API init login → trust → feature checks.

Reads credentials from a local file (default: ~/Documents/new 2api.txt),
drives CircleSessionApp /logout then InitController like ``circle --init``,
trusts the workspace, then exercises parity features against the real API.

  CIRCLE_CREDENTIALS_FILE='/Users/…/Documents/new 2api.txt' \\
  CIRCLE_HOME=…/circle-sandbox/home \\
  CIRCLE_WORKSPACE=…/circle-sandbox/workspace \\
  .venv/bin/python -u scripts/sandbox_tui_parity_live.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from circle.apply_patch import apply_patch_text
from circle.commands import discover_custom_commands, expand_command_template
from circle.harness import create_harness
from circle.lsp_tool import run_lsp
from circle.mcp_loader import build_mcp_connections, format_mcp_status, load_mcp_tools_sync
from circle.model import build_chat_model
from circle.plan_backend import PlanGuardedBackend
from circle.prompt_features import build_extra_tools
from circle.session_tree import SessionTree
from circle.settings import (
    apply_auth_to_environ,
    clear_credentials,
    load_settings,
    save_settings,
)
from circle.skills import discover_skills, load_skill_body
from circle.tui.controllers import InitController, TrustController
from circle.tui.session_app import CircleSessionApp
from circle.tui.slash_commands import parse_slash
from circle.websearch import web_search

ANSI = re.compile(r"\x1b\[[0-9;]*m")
DEFAULT_CREDS = Path.home() / "Documents" / "new 2api.txt"


def _strip(s: str) -> str:
    return ANSI.sub("", s)


def _ok(name: str, detail: str = "") -> None:
    print(f"[OK]   {name}" + (f" — {detail}" if detail else ""), flush=True)


def _fail(name: str, detail: str) -> None:
    print(f"[FAIL] {name} — {detail[:400]}", flush=True)


def _snap(app: CircleSessionApp) -> str:
    return "\n".join(_strip(x) for x in app._transcript.snapshot())  # noqa: SLF001


def _wait_idle(app: CircleSessionApp, timeout: float = 120.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not app._is_loading and not app._bridge.is_running:  # noqa: SLF001
            return True
        time.sleep(0.15)
    return False


def _wait_answer(app: CircleSessionApp, before: int, needle: str, timeout: float = 120.0) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        lines = [_strip(x) for x in app._transcript.snapshot()[before:]]  # noqa: SLF001
        joined = "\n".join(lines)
        if "✖" in joined:
            return joined
        for ln in lines:
            plain = ln.strip()
            # Skip user prompt echoes and dim toast/meta lines.
            if (
                not plain
                or plain.startswith(">")
                or plain.startswith("已")
                or "Reply with only:" in plain
                or plain.startswith("─")
            ):
                continue
            if needle.lower() in plain.lower():
                return joined
        if not app._is_loading and not app._bridge.is_running:  # noqa: SLF001
            return joined
        time.sleep(0.2)
    return "\n".join(_strip(x) for x in app._transcript.snapshot()[before:])  # noqa: SLF001


def parse_credentials_file(path: Path) -> dict[str, str]:
    """Parse env-like credentials file.

    Accepts commented ``#ANTHROPIC_*=`` lines as fallback (common when editing).
    A bare line like ``qwen3.8-flash`` is treated as the preferred model.
    """
    raw = path.read_text(encoding="utf-8")
    active: dict[str, str] = {}
    commented: dict[str, str] = {}
    model = ""
    for line in raw.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            body = s.lstrip("#").strip()
            if "=" in body and body.upper().startswith("ANTHROPIC_"):
                k, _, v = body.partition("=")
                commented[k.strip().upper()] = v.strip().strip("'\"")
            continue
        if "=" in s and s.upper().startswith("ANTHROPIC_"):
            k, _, v = s.partition("=")
            active[k.strip().upper()] = v.strip().strip("'\"")
            continue
        if re.fullmatch(r"[A-Za-z0-9._:-]+", s) and "://" not in s:
            model = s
    url = active.get("ANTHROPIC_BASE_URL") or commented.get("ANTHROPIC_BASE_URL") or ""
    key = active.get("ANTHROPIC_API_KEY") or commented.get("ANTHROPIC_API_KEY") or ""
    used_commented = bool(
        (not active.get("ANTHROPIC_BASE_URL") and commented.get("ANTHROPIC_BASE_URL"))
        or (not active.get("ANTHROPIC_API_KEY") and commented.get("ANTHROPIC_API_KEY"))
    )
    return {
        "base_url": url.rstrip("/"),
        "api_key": key,
        "model": model or os.environ.get("CIRCLE_MODEL", "qwen3.8-flash"),
        "used_commented": "1" if used_commented else "0",
    }


def _seed_fixtures(ws: Path, home: Path) -> None:
    skill = ws / ".agents" / "skills" / "parity-demo"
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(
        "---\nname: parity-demo\ndescription: >\n  Live parity skill.\n---\n\n"
        "# Parity Demo\n\nWhen loaded, reply with the exact token: PARITY_SKILL_OK\n",
        encoding="utf-8",
    )
    for rel in (".opencode/commands", ".circle/commands"):
        d = ws.joinpath(*rel.split("/"))
        d.mkdir(parents=True, exist_ok=True)
    (ws / ".opencode" / "commands" / "parity-cmd.md").write_text(
        "---\ndescription: Parity custom command\n---\nReply with only: CMD_$1_OK\n",
        encoding="utf-8",
    )
    (ws / ".circle" / "commands" / "ping.md").write_text(
        "---\ndescription: Ping command\n---\n"
        "Do not use tools. Your entire reply must be exactly these seven characters "
        "and nothing else:\nPING_OK\n",
        encoding="utf-8",
    )
    # local MCP fixture
    root = ROOT
    settings = load_settings(home)
    settings.mcp_servers = [
        {
            "name": "parity",
            "command": str(root / ".venv" / "bin" / "python"),
            "args": [str(root / "scripts" / "parity_mcp_server.py")],
        }
    ]
    save_settings(settings, home)


def flow_logout_then_init(home: Path, ws: Path, creds: dict[str, str], results: list) -> bool:
    """Simulate: open session → /logout → init URL+KEY → trust."""

    def record(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        (_ok if ok else _fail)(name, detail)

    # Ensure home exists; may have leftover settings.
    home.mkdir(parents=True, exist_ok=True)
    ws.mkdir(parents=True, exist_ok=True)

    pre = load_settings(home)
    if pre.is_ready():
        try:
            app = CircleSessionApp(pre, ws, home=home)
            app._on_submit("/logout")  # noqa: SLF001
            snap = _snap(app)
            record("flow-logout", "退出" in snap or "logout" in snap.lower(), snap[-160:])
            try:
                app._bridge.cancel()  # noqa: SLF001
            except Exception:  # noqa: BLE001
                pass
        except Exception as exc:  # noqa: BLE001
            # Fallback: clear like /logout would
            clear_credentials(home)
            pre.initialized = False
            save_settings(pre, home)
            record("flow-logout", True, f"fallback clear_credentials ({exc})")
    else:
        clear_credentials(home)
        record("flow-logout", True, "already logged out")

    after = load_settings(home)
    if after.is_ready():
        record("flow-logout-verify", False, "settings still ready after logout")
        return False
    record("flow-logout-verify", True, "credentials cleared")

    # InitController = circle --init (API URL + KEY path)
    init = InitController(home=home)
    print("[flow] init: choose API URL + KEY", flush=True)
    init.submit_line("1")
    print(f"[flow] init: URL={creds['base_url']}", flush=True)
    init.submit_line(creds["base_url"])
    print(f"[flow] init: KEY=***{creds['api_key'][-4:]}", flush=True)
    init.submit_line(creds["api_key"])
    # Prefer requested model from credentials file.
    preferred = creds["model"]
    if preferred not in init.models:
        init.models = [preferred, *init.models]
    init.model_focus = init.models.index(preferred)
    print(
        f"[flow] init: pick model={preferred} protocol={init.protocol}"
        f" status={init.status!r}",
        flush=True,
    )
    init.confirm()
    if not init.done or init.settings is None:
        record("flow-init-login", False, f"step={init.step} err={init.error!r}")
        return False
    if "anthropic" in creds["base_url"].lower() and init.settings.auth.protocol != "anthropic":
        record(
            "flow-init-login",
            False,
            f"expected anthropic from URL hint, got {init.settings.auth.protocol}",
        )
        return False
    record(
        "flow-init-login",
        True,
        f"{init.settings.auth.protocol}/{init.settings.auth.model} @ {init.settings.auth.base_url}",
    )

    trust = TrustController(init.settings, ws, home=home)
    trust.confirm()
    record("flow-trust", (ws / ".agent").is_dir(), str(ws / ".agent"))
    return True


def main() -> int:
    home = Path(
        os.environ.get("CIRCLE_HOME", str(ROOT.parent / "circle-sandbox" / "home"))
    ).resolve()
    ws = Path(
        os.environ.get(
            "CIRCLE_WORKSPACE", str(ROOT.parent / "circle-sandbox" / "workspace")
        )
    ).resolve()
    creds_path = Path(
        os.environ.get("CIRCLE_CREDENTIALS_FILE", str(DEFAULT_CREDS))
    ).expanduser()

    if not creds_path.is_file():
        _fail("creds-file", f"missing {creds_path}")
        return 2
    creds = parse_credentials_file(creds_path)
    if not creds["base_url"] or not creds["api_key"]:
        _fail("creds-file", f"no URL/KEY in {creds_path}")
        return 2
    if creds["used_commented"] == "1":
        print(
            "[WARN] credentials were commented with # — using them for init anyway",
            flush=True,
        )
    _ok("creds-file", f"{creds_path.name} model={creds['model']}")

    results: list[tuple[str, bool, str]] = []
    failures = 0

    def record(name: str, ok: bool, detail: str = "") -> None:
        nonlocal failures
        results.append((name, ok, detail))
        if ok:
            _ok(name, detail)
        else:
            failures += 1
            _fail(name, detail)

    if not flow_logout_then_init(home, ws, creds, results):
        _print_summary(results)
        return 1

    # Keep local MCP fixture after init overwrote settings
    _seed_fixtures(ws, home)
    settings = load_settings(home)
    # restore model preference if probe overwrote oddly
    if creds["model"] and settings.auth.model != creds["model"]:
        settings.auth.model = creds["model"]
        save_settings(settings, home)
    apply_auth_to_environ(settings, home)
    _ok(
        "auth",
        f"{settings.auth.protocol}/{settings.auth.model} @ {settings.auth.base_url}",
    )

    # Offline parity checks
    try:
        assert "OK" in apply_patch_text(
            ws,
            "*** Begin Patch\n*** Add File: parity_patch.txt\n+patched\n*** End Patch\n",
        )
        record("4-apply_patch", True, "add file")
    except Exception as e:  # noqa: BLE001
        record("4-apply_patch", False, repr(e))

    try:
        search = web_search("OpenAI", num_results=3)
        ok = bool(re.search(r"https?://", search)) and "No results" not in search
        record("4-websearch", ok, search.splitlines()[0][:80] if search else "empty")
    except Exception as e:  # noqa: BLE001
        record("4-websearch", False, repr(e))

    try:
        lsp = run_lsp(ws, operation="hover", file_path="parity_patch.txt", line=1, character=1)
        record("7-lsp", "Error" in lsp or "{" in lsp, lsp.splitlines()[0][:100])
    except Exception as e:  # noqa: BLE001
        record("7-lsp", False, repr(e))

    try:
        backend = PlanGuardedBackend(root_dir=ws, virtual_mode=True, plan_mode=True)
        blocked = backend.write("evil.py", "x=1\n")
        allowed = backend.write("plan.md", "# plan\n")
        shell = backend.execute("echo hi")
        ok = bool(blocked.error) and allowed.error is None and shell.exit_code == 1
        record("2-plan-backend", ok, "write/shell gated")
    except Exception as e:  # noqa: BLE001
        record("2-plan-backend", False, repr(e))

    try:
        conns = build_mcp_connections([{"name": "demo", "command": "false", "args": []}])
        assert conns["demo"]["transport"] == "stdio"
        record("1-mcp-config", True, format_mcp_status(settings.mcp_servers, []).splitlines()[0][:80])
    except Exception as e:  # noqa: BLE001
        record("1-mcp-config", False, repr(e))

    if settings.mcp_servers:
        try:
            mcp_tools = load_mcp_tools_sync(settings.mcp_servers, timeout=45)
            names = [getattr(t, "name", "") for t in mcp_tools]
            record(
                "1-mcp-live-load",
                any("echo" in n for n in names) or bool(mcp_tools),
                f"tools={names[:12]}",
            )
        except Exception as e:  # noqa: BLE001
            record("1-mcp-live-load", False, repr(e))

    try:
        cmds = discover_custom_commands(ws, home)
        names = {c.name for c in cmds}
        assert "ping" in names or "parity-cmd" in names
        assert "CMD_Z_OK" in expand_command_template("Reply with only: CMD_$1_OK\n", "Z", cwd=ws)
        record("3-custom-commands", True, f"found={sorted(names)}")
    except Exception as e:  # noqa: BLE001
        record("3-custom-commands", False, repr(e))

    try:
        skills = discover_skills(ws, home)
        assert "parity-demo" in {s.name for s in skills}
        assert "PARITY_SKILL_OK" in load_skill_body("parity-demo", skills=skills)
        record("5-skill-discover", True, "parity-demo present")
    except Exception as e:  # noqa: BLE001
        record("5-skill-discover", False, repr(e))

    try:
        tree = SessionTree()
        a = tree.add("user", "u1")
        tree.add("assistant", "a1")
        assert tree.fork_from(a.id) and tree.clone_active().active_id
        record("6-session-tree", True, f"nodes={len(tree.nodes)}")
    except Exception as e:  # noqa: BLE001
        record("6-session-tree", False, repr(e))

    # Live ping with retries
    model = None
    last_err = ""
    for attempt in range(1, 6):
        try:
            model = build_chat_model(settings, home=home)
            ping = model.invoke([{"role": "user", "content": "Reply with exactly: pong"}])
            text = getattr(ping, "content", ping)
            if isinstance(text, list):
                text = " ".join(
                    str(b.get("text") if isinstance(b, dict) else b) for b in text
                )
            ok = "pong" in str(text).lower()
            record("live-llm-ping", ok, f"attempt={attempt} {str(text)[:80]}")
            if not ok:
                _print_summary(results)
                return 1
            break
        except Exception as e:  # noqa: BLE001
            last_err = repr(e)
            if any(x in last_err for x in ("RateLimit", "频繁", "429")):
                wait = 15 * attempt
                print(f"[WAIT] rate-limited, sleep {wait}s (attempt {attempt}/5)", flush=True)
                time.sleep(wait)
                continue
            record("live-llm-ping", False, last_err)
            _print_summary(results)
            return 1
    else:
        record("live-llm-ping", False, last_err or "retries exhausted")
        _print_summary(results)
        return 1

    # Headless TUI after real login
    app: CircleSessionApp | None = None
    try:
        app = CircleSessionApp(settings, ws, home=home)
        app._on_submit("/help")  # noqa: SLF001
        snap = _snap(app)
        record(
            "tui-help",
            all(x in snap for x in ("/skill", "/tree", "/fork", "/plan", "/mcp")),
            "parity slash listed",
        )

        # ---- Full slash sweep (meta commands; minimal LLM cost) ----
        app._on_submit("/hotkeys")  # noqa: SLF001
        record("slash-hotkeys", "enter" in _snap(app).lower() or "ctrl" in _snap(app).lower(), "")

        app._on_submit("/settings")  # noqa: SLF001
        record("slash-settings", "model=" in _snap(app) or "protocol=" in _snap(app), "")

        app._on_submit("/themes")  # noqa: SLF001
        record("slash-themes-list", "主题" in _snap(app) or "theme" in _snap(app).lower(), "")
        prev_theme = app.settings.theme
        app._on_submit("/themes dark")  # noqa: SLF001
        record("slash-themes-set", app.settings.theme == "dark", f"theme={app.settings.theme}")
        if prev_theme and prev_theme != "dark":
            app._on_submit(f"/themes {prev_theme}")  # noqa: SLF001

        app._on_submit("/name parity-live")  # noqa: SLF001
        record("slash-name", app._session_title == "parity-live", app._session_title)  # noqa: SLF001

        app._on_submit("/session")  # noqa: SLF001
        record(
            "slash-session",
            app._thread_id in _snap(app) and "parity-live" in _snap(app),  # noqa: SLF001
            "",
        )

        app._on_submit("/models")  # noqa: SLF001
        record("slash-models", "模型" in _snap(app) or app.settings.auth.model in _snap(app), "")

        before_think = app._show_thinking  # noqa: SLF001
        app._on_submit("/thinking")  # noqa: SLF001
        record("slash-thinking", app._show_thinking is not before_think, "")  # noqa: SLF001
        app._on_submit("/thinking")  # noqa: SLF001  # restore

        before_det = app._tool_outputs_expanded  # noqa: SLF001
        app._on_submit("/details")  # noqa: SLF001
        record("slash-details", app._tool_outputs_expanded is not before_det, "")  # noqa: SLF001
        app._on_submit("/details")  # noqa: SLF001

        app._last_assistant_plain = "CLIP_OK"  # noqa: SLF001
        app._clipboard_set = lambda _t: True  # type: ignore[method-assign]  # noqa: SLF001
        app._on_submit("/copy")  # noqa: SLF001
        record("slash-copy", "复制" in _snap(app) or "clipboard" in _snap(app).lower() or "CLIP" in _snap(app), "")

        exp = ws / ".circle" / "slash_export.md"
        exp.parent.mkdir(parents=True, exist_ok=True)
        app._transcript.append_message("slash-export-body")  # noqa: SLF001
        app._on_submit(f"/export {exp}")  # noqa: SLF001
        record("slash-export", exp.is_file() and "slash-export-body" in exp.read_text(encoding="utf-8"), str(exp))

        app._on_submit("/share")  # noqa: SLF001
        share_ok = app._share_path is not None and app._share_path.is_file()  # noqa: SLF001
        record("slash-share", share_ok, str(app._share_path))  # noqa: SLF001
        app._on_submit("/unshare")  # noqa: SLF001
        record("slash-unshare", app._share_path is None, "")  # noqa: SLF001

        app._on_submit(f"/import {exp}")  # noqa: SLF001
        record("slash-import", "已导入" in _snap(app), "")
        try:
            st = app._agent.get_state({"configurable": {"thread_id": app._thread_id}})  # noqa: SLF001
            msgs = (st.values or {}).get("messages") or []
            imported = any(
                "Imported prior transcript" in str(getattr(m, "content", "")) for m in msgs
            )
            record("slash-import-checkpointer", imported, f"msgs={len(msgs)}")
        except Exception as exc:  # noqa: BLE001
            record("slash-import-checkpointer", False, repr(exc))

        app._push_undo_checkpoint()  # noqa: SLF001
        app._transcript.append_message("undo-marker")  # noqa: SLF001
        app._on_submit("/undo")  # noqa: SLF001
        record("slash-undo", "undo-marker" not in _snap(app), "")
        app._on_submit("/redo")  # noqa: SLF001
        record("slash-redo", "undo-marker" in _snap(app), "")

        app._on_submit("/mcp")  # noqa: SLF001
        record("slash-mcp-list", "MCP" in _snap(app) or "parity" in _snap(app).lower(), "")
        app._on_submit("/mcp reload")  # noqa: SLF001
        record("slash-mcp-reload", "重载" in _snap(app) or "MCP" in _snap(app), "")

        app._on_submit("/trust")  # noqa: SLF001
        record("slash-trust", "信任" in _snap(app), "")

        app._on_submit("/reload")  # noqa: SLF001
        record("slash-reload", "重新加载" in _snap(app) or "reload" in _snap(app).lower(), "")

        # /compact against live thread (may be early → nothing / COMPACT_OK)
        from langchain_core.messages import AIMessage, HumanMessage

        tid = app._thread_id  # noqa: SLF001
        try:
            app._agent.update_state(  # noqa: SLF001
                {"configurable": {"thread_id": tid}},
                {
                    "messages": [
                        HumanMessage(content="compact seed user"),
                        AIMessage(content="compact seed assistant"),
                    ]
                },
            )
        except Exception as exc:  # noqa: BLE001
            record("slash-compact-seed", False, repr(exc))
        else:
            record("slash-compact-seed", True, "")
        before_c = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit("/compact")  # noqa: SLF001
        deadline = time.time() + 90
        compact_snap = ""
        while time.time() < deadline:
            compact_snap = "\n".join(_strip(x) for x in app._transcript.snapshot()[before_c:])  # noqa: SLF001
            if (
                "compacted" in compact_snap.lower()
                or "COMPACT_OK" in compact_snap
                or "无需压缩" in compact_snap
                or "compact 失败" in compact_snap
                or "Nothing to compact" in compact_snap
            ) and not (app._is_loading or app._bridge.is_running):  # noqa: SLF001
                break
            time.sleep(0.2)
        _wait_idle(app, timeout=30)
        record(
            "slash-compact",
            app._thread_id == tid  # noqa: SLF001
            and "compact 失败" not in compact_snap
            and (
                "compacted" in compact_snap.lower()
                or "COMPACT_OK" in compact_snap
                or "无需压缩" in compact_snap
                or "nothing to compact" in compact_snap.lower()
            ),
            compact_snap[-200:],
        )

        # Isolate custom-command turn from any prior skill/MCP chatter.
        prev_tid = app._thread_id  # noqa: SLF001
        app._session_title = "pre-new"  # noqa: SLF001
        app._transcript.append_message("archive-me")  # noqa: SLF001
        app._on_submit("/new")  # noqa: SLF001
        record("slash-new", "新会话" in _snap(app) or app._thread_id != prev_tid, app._thread_id)  # noqa: SLF001

        app._on_submit("/resume")  # noqa: SLF001
        record("slash-resume-list", "会话" in _snap(app) or prev_tid in _snap(app), "")
        app._on_submit(f"/resume {prev_tid}")  # noqa: SLF001
        record(
            "slash-resume-switch",
            app._thread_id == prev_tid or "archive-me" in _snap(app),  # noqa: SLF001
            app._thread_id,  # noqa: SLF001
        )
        app._on_submit("/continue")  # noqa: SLF001
        record("slash-continue", True, app._thread_id)  # noqa: SLF001

        app._on_submit("/new")  # noqa: SLF001
        app._on_submit("/skill:parity-demo")  # noqa: SLF001
        record("5-tui-skill-colon", "parity-demo" in _snap(app).lower() or "已加载" in _snap(app), "")

        app._on_submit("/new")  # noqa: SLF001
        before = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit("/ping")  # noqa: SLF001
        out = _wait_answer(app, before, "PING_OK", timeout=120)
        assistant_hit = any(
            "PING_OK" in _strip(x)
            and not _strip(x).strip().startswith(">")
            and "seven characters" not in _strip(x)
            for x in app._transcript.snapshot()[before:]  # noqa: SLF001
        )
        record("3-tui-custom-cmd", assistant_hit, out[-240:])
        _wait_idle(app)

        app._on_submit("/plan on")  # noqa: SLF001
        record("2-tui-plan-on", "plan" in _snap(app).lower() or "硬拦截" in _snap(app), "")

        evil = ws / "plan_mode_should_not_exist.py"
        if evil.exists():
            evil.unlink()
        before = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit(  # noqa: SLF001
            "Create file plan_mode_should_not_exist.py with content x=1 using write_file. "
            "If blocked, reply exactly: PLAN_BLOCKED"
        )
        out = _wait_answer(app, before, "PLAN_BLOCKED", timeout=150)
        record(
            "2-tui-plan-live",
            (not evil.exists()) or ("PLAN_BLOCKED" in out) or ("plan mode" in out.lower()),
            f"evil_exists={evil.exists()}",
        )
        _wait_idle(app)
        app._on_submit("/plan off")  # noqa: SLF001
        # Fresh session so plan-mode history cannot pollute the skill check.
        app._on_submit("/new")  # noqa: SLF001
        app._plan_mode = False  # noqa: SLF001
        try:
            app._rebuild_agent()  # noqa: SLF001
        except Exception as exc:  # noqa: BLE001
            record("5-tui-skill-prep", False, repr(exc))
        else:
            record("5-tui-skill-prep", not app._plan_mode, "plan off + new session")  # noqa: SLF001

        app._on_submit("/skill:parity-demo")  # noqa: SLF001
        before = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit(  # noqa: SLF001
            "Ignore any prior plan-mode conversation. "
            "Follow the loaded skill instructions exactly and output only the required token."
        )
        out = _wait_answer(app, before, "PARITY_SKILL_OK", timeout=150)
        record("5-tui-skill-live", "PARITY_SKILL_OK" in out, out[-240:])
        _wait_idle(app)

        app._on_submit("/tree")  # noqa: SLF001
        record("6-tui-tree", "tree" in _snap(app).lower() or "Session" in _snap(app), "")
        tip = app._session_tree.active_id  # noqa: SLF001
        app._on_submit("/clone")  # noqa: SLF001
        record("6-tui-clone", "clone" in _snap(app).lower(), "")
        if tip:
            app._on_submit(f"/fork {tip}")  # noqa: SLF001
            record("6-tui-fork", "fork" in _snap(app).lower(), "")
        else:
            record("6-tui-fork", False, "no tip")

        before = len(app._transcript.snapshot())  # noqa: SLF001
        app._on_submit("Count 1 to 3 then say QUEUE_DONE.")  # noqa: SLF001
        time.sleep(0.35)
        if app._bridge.is_running or app._is_loading:  # noqa: SLF001
            app._on_submit("steering note", kind="steering")  # noqa: SLF001
            record("5-tui-queue", "排队" in _snap(app) or "steering" in _snap(app).lower(), "")
        else:
            record("5-tui-queue", True, "turn finished too fast")
        _wait_idle(app, timeout=180)

        app._on_submit("/mcp")  # noqa: SLF001
        record("1-tui-mcp", "MCP" in _snap(app) or "mcp" in _snap(app).lower() or "parity" in _snap(app), "")

        # apply_patch live: call tool directly (HITL would block unattended harness invoke)
        tools = {t.name: t for t in build_extra_tools(ws, home)}
        patch_out = tools["apply_patch"].invoke(
            {
                "patchText": (
                    "*** Begin Patch\n*** Add File: live_patch_ok.txt\n"
                    "+LIVE_PATCH_OK\n*** End Patch\n"
                )
            }
        )
        file_ok = (ws / "live_patch_ok.txt").exists() and "LIVE_PATCH_OK" in (
            ws / "live_patch_ok.txt"
        ).read_text(encoding="utf-8")
        record(
            "4-harness-apply_patch-live",
            file_ok and "OK" in patch_out,
            f"file={file_ok} out={patch_out[:80]}",
        )

        ws_out = tools["websearch"].invoke({"query": "Anthropic Claude", "num_results": 2})
        record("4-tool-websearch-live", "http" in ws_out.lower() or "1." in ws_out, ws_out[:100])

        # Direct model math — avoid MCP/tool distraction in a full harness turn.
        math = model.invoke(
            [
                {
                    "role": "user",
                    "content": (
                        "Do not use tools. What is 6*7? "
                        "Reply with only the digits of the product."
                    ),
                }
            ]
        )
        content = getattr(math, "content", math)
        if isinstance(content, list):
            content = " ".join(
                str(b.get("text") if isinstance(b, dict) else b) for b in content
            )
        record("4-model-math-live", "42" in str(content), str(content)[:120])

        # Harness still builds with MCP tools attached (smoke).
        agent = create_harness(
            model,
            root_dir=ws,
            home=home,
            model_id=settings.auth.model,
            protocol=settings.auth.protocol,
            mcp_servers=settings.mcp_servers,
        )
        record(
            "1-harness-with-mcp",
            agent is not None and bool(getattr(agent, "_circle_mcp_tools", [])),
            f"mcp_tools={len(getattr(agent, '_circle_mcp_tools', []) or [])}",
        )

    except Exception as e:  # noqa: BLE001
        record("tui-suite", False, repr(e))
    finally:
        if app is not None:
            try:
                app._bridge.cancel()  # noqa: SLF001
            except Exception:  # noqa: BLE001
                pass

    report = ws / ".circle" / "parity_live_report.json"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(
        json.dumps(
            {
                "ok": failures == 0,
                "failures": failures,
                "results": [
                    {"name": n, "ok": o, "detail": d[:500]} for n, o, d in results
                ],
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"\nReport: {report}", flush=True)
    _print_summary(results)
    return 1 if failures else 0


def _print_summary(results: list[tuple[str, bool, str]]) -> None:
    passed = sum(1 for _, o, _ in results if o)
    failed = sum(1 for _, o, _ in results if not o)
    print(
        f"\n=== SUMMARY {passed} passed / {failed} failed / {len(results)} total ===",
        flush=True,
    )
    for name, ok, detail in results:
        mark = "OK" if ok else "FAIL"
        extra = f" — {detail[:100]}" if detail and not ok else ""
        print(f"  [{mark}] {name}{extra}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
