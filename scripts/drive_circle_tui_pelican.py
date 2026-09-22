#!/usr/bin/env python3
"""Assign the pelican SVG task to the installed Circle TUI (not a side harness)."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pexpect

CIRCLE = os.environ.get(
    "CIRCLE_BIN", "/Users/jiangyongze/Public/circle-sandbox/bin/circle"
)
HOME = os.environ.get("CIRCLE_HOME", "/Users/jiangyongze/Public/circle-sandbox/home")
WS = Path(
    os.environ.get(
        "CIRCLE_WORKSPACE", "/Users/jiangyongze/Public/circle-sandbox/workspace"
    )
).resolve()

PROMPT = (
    "任务：用 write_file 在沙箱根路径写入文件。\n"
    "file_path 必须精确是：/pelican-bike.svg\n"
    "内容：自包含 SVG，画面=鹈鹕骑自行车（pelican on a bicycle）。\n"
    "包含鹈鹕（身体/大嘴/翅膀）和自行车（两轮/车架/脚蹬），viewBox=0 0 800 600。\n"
    "不要写入其它路径。写完后只回复：done /pelican-bike.svg"
)


def main() -> int:
    target = WS / "pelican-bike.svg"
    if target.exists():
        target.unlink()

    env = os.environ.copy()
    env["CIRCLE_HOME"] = HOME
    env["TERM"] = "xterm-256color"
    env.pop("CIRCLE_NO_TUI", None)

    print(f"[drive] launch {CIRCLE}", flush=True)
    print(f"[drive] workspace={WS}", flush=True)
    print(f"[drive] model settings in {HOME}/settings.json", flush=True)

    child = pexpect.spawn(
        CIRCLE,
        [str(WS)],
        cwd=str(WS),
        env=env,
        encoding="utf-8",
        timeout=120,
        dimensions=(40, 120),
        maxread=20000,
    )
    # Don't mirror full alt-screen spam to stdout
    child.logfile_read = None

    try:
        child.expect(["Circle ·", "claude-sonnet-5", "/ commands"], timeout=40)
    except pexpect.TIMEOUT:
        print("[drive] TUI did not become ready", file=sys.stderr)
        _shutdown(child)
        return 2

    time.sleep(0.6)
    for line in PROMPT.split("\n"):
        child.send(line)
        child.send("\n")  # multiline via... does prompt support newline?
    # PromptInput may need shift+enter for newline; send as single line instead
    child.sendcontrol("u")  # clear if any
    time.sleep(0.1)
    child.send(PROMPT.replace("\n", " "))
    time.sleep(0.15)
    child.send("\r")
    print("[drive] task handed to Circle", flush=True)

    deadline = time.time() + 180
    approvals = 0
    last_approve = 0.0
    while time.time() < deadline:
        if target.is_file() and target.stat().st_size > 300:
            print(f"[drive] got {target} ({target.stat().st_size} B)", flush=True)
            break

        idx = child.expect(
            [
                r"Allow once",
                r"write_file",
                r"Permission",
                pexpect.TIMEOUT,
                pexpect.EOF,
            ],
            timeout=6,
        )
        if idx == 4:
            print("[drive] circle exited", file=sys.stderr)
            break
        if idx in (0, 1, 2):
            # Debounce: alt-screen redraws contain "Allow once" repeatedly
            now = time.time()
            if now - last_approve < 2.5:
                time.sleep(0.3)
                continue
            if approvals >= 8:
                print("[drive] approval cap reached", file=sys.stderr)
                break
            child.send("\r")
            approvals += 1
            last_approve = now
            print(f"[drive] Circle HITL approve #{approvals}", flush=True)
            time.sleep(1.0)
        else:
            time.sleep(0.5)
    else:
        print("[drive] timeout waiting for /pelican-bike.svg", file=sys.stderr)

    _shutdown(child)

    # Accept root file only
    if target.is_file() and "<svg" in target.read_text(encoding="utf-8").lower():
        text = target.read_text(encoding="utf-8")
        print(f"[drive] OK via Circle TUI → {target} ({len(text)} bytes, approvals={approvals})")
        print(text[:280].replace("\n", " "))
        return 0

    # Show if model wrote elsewhere
    found = list(WS.rglob("pelican-bike.svg"))
    print(f"[drive] FAIL root missing; found elsewhere: {found}", file=sys.stderr)
    return 1


def _shutdown(child: pexpect.spawn) -> None:
    try:
        if child.isalive():
            child.send("/exit\r")
            child.expect(pexpect.EOF, timeout=8)
    except Exception:  # noqa: BLE001
        try:
            child.sendcontrol("c")
            child.sendcontrol("c")
            child.terminate(force=True)
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    raise SystemExit(main())
