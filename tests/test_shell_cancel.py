"""esc stops a running shell command: the turn ends at once and the command, with
everything it started, is ended rather than left to finish or time out."""

from __future__ import annotations

import sys
import time

import pytest
from langchain_core.messages import AIMessage

from circle.approvals import default_policy
from circle.harness import create_harness
from circle.sandbox import STOPPED_OUTPUT, CircleSandboxBackend
from circle.testing import ScriptedModel
from circle.tui.harness_bridge import HarnessBridge

# Circle runs commands in their own process group and ends the group on esc or a timeout. On
# Windows commands go through deepagents' own backend, which cannot be stopped (Known issues),
# and these commands are POSIX shell.
pytestmark = pytest.mark.skipif(sys.platform == "win32",
                                reason="POSIX shell and process groups; not on Windows yet")


def _wait_until(predicate, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_esc_ends_a_running_command_and_the_turn(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    command = "touch started; (sleep 30; touch child-late) & sleep 30; touch late"
    model = ScriptedModel(responses=[
        AIMessage(content="", tool_calls=[{"name": "execute", "args": {"command": command},
                                           "id": "e1"}]),
        AIMessage(content="never reached")])
    policy = default_policy(tmp_path / "home")
    policy.set_yolo("slow", True)
    agent = create_harness(model, root_dir=ws, home=tmp_path / "home", approvals=policy)
    done, errors = [], []
    bridge = HarnessBridge(agent=agent, thread_id="slow", on_update=lambda _u: None,
                           on_interrupt=lambda _i: None, on_done=done.append,
                           on_error=errors.append)
    bridge.start("run it")
    assert _wait_until(lambda: (ws / "started").exists(), 10), "the command started"
    stopped_at = time.monotonic()
    bridge.cancel()
    assert _wait_until(lambda: not bridge.is_running, 5), "esc must not wait for sleep 30"
    assert time.monotonic() - stopped_at < 5
    time.sleep(0.3)
    assert not (ws / "late").exists() and not (ws / "child-late").exists()
    assert not errors and not done


def test_the_timeout_ends_the_whole_process_group(tmp_path):
    backend = CircleSandboxBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=True)
    started = time.monotonic()
    result = backend.execute("(sleep 5; touch orphan) & echo begun; sleep 5", timeout=1)
    assert result.exit_code == 124 and "timed out after 1 seconds" in result.output
    assert time.monotonic() - started < 4
    time.sleep(0.2)
    assert not (tmp_path / "orphan").exists(), "the background child was ended too"


def test_output_matches_the_upstream_format(tmp_path):
    backend = CircleSandboxBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=True)
    ok = backend.execute("echo out; echo err >&2")
    assert (ok.output, ok.exit_code) == ("out\n\n[stderr] err", 0)
    failed = backend.execute("echo nope; exit 3")
    assert failed.exit_code == 3 and failed.output == "nope\n\nExit code: 3"
    assert backend.execute("true").output == "<no output>"
    assert STOPPED_OUTPUT.startswith("Stopped")


def test_output_that_is_not_text_does_not_break_the_turn(tmp_path):
    (tmp_path / "logo.bin").write_bytes(b"\x89PNG\xff\xfe\x00binary\n")
    backend = CircleSandboxBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=True)
    result = backend.execute("cat logo.bin")
    assert result.exit_code == 0 and "PNG" in result.output and "binary" in result.output
