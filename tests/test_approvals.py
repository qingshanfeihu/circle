"""Approval policy (C3): command classification, the backend refusal (main agent and
subagent), per-thread "always" rules that survive a restart, forced asks, and the
session panel that asks call by call."""

from __future__ import annotations

import os
import stat
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command

from circle.approvals import (
    ApprovalPolicy,
    ApprovalStore,
    classify_command,
    default_policy,
)
from circle.harness import create_harness, sandbox_backend
from circle.oauth import start_oauth_login
from circle.testing import ScriptedModel
from circle.tui.controllers import InitController, TrustController
from circle.tui.harness_bridge import HarnessBridge
from circle.tui.session_app import CircleSessionApp

SECRET = "sk-live-do-not-leak-0123456789"


@pytest.mark.parametrize("command, verdict", [
    ("ls -la", "ASK"),
    ("git push origin main", "ASK"),
    ("curl https://example.com", "ASK"),
    ("git commit -m 'rm the thing'", "ASK"),
    ("rm a.txt", "ASK_FORCED"),
    ("echo hi && rm -rf build", "ASK_FORCED"),
    ("echo hi\nrm x", "ASK_FORCED"),
    ('echo "$(rm x)"', "ASK_FORCED"),
    ("echo `rm x`", "ASK_FORCED"),
    ('bash -lc "rm x"', "ASK_FORCED"),
    ("python3 -c 'import shutil; shutil.rmtree(\"b\")'", "ASK_FORCED"),
    ("env FOO=1 nohup rm x", "ASK_FORCED"),
    ("xargs -n1 rm < list", "ASK_FORCED"),
    ("find . -name '*.pyc' -delete", "ASK_FORCED"),
    ("find . -exec rm {} \\;", "ASK_FORCED"),
    ("git push --force origin main", "ASK_FORCED"),
    ("git push origin +main", "ASK_FORCED"),
    ("git -C repo reset --hard HEAD~1", "ASK_FORCED"),
    ("git branch -D feature", "ASK_FORCED"),
    ("git restore a.py", "ASK_FORCED"),
    ("dd if=/dev/zero of=disk.img", "ASK_FORCED"),
    ("echo 'unterminated", "ASK_FORCED"),
    ("sudo ls", "DENY"),
    ("cat .env", "DENY"),
    ("grep KEY config/.env.local", "DENY"),
    ("cp ~/.ssh/id_rsa /tmp/k", "DENY"),
    ("echo X=1 >> .env", "DENY"),
    ("cat .compile-excel/token.json", "DENY"),
])
def test_command_classification(command, verdict):
    assert classify_command(command).verdict == verdict


def test_credential_file_list_is_configurable():
    assert classify_command("cat secrets.yaml").verdict == "ASK"
    assert classify_command("cat secrets.yaml", ["secrets.*"]).verdict == "DENY"
    assert classify_command("cat .env", ["secrets.*"]).verdict == "ASK"


def test_backend_refuses_denied_commands(tmp_path):
    (tmp_path / ".env").write_text(f"KEY={SECRET}\n", encoding="utf-8")
    backend = sandbox_backend(tmp_path)
    backend.command_guard = default_policy(tmp_path / "home").deny_message
    denied = backend.execute("cat .env")
    assert denied.exit_code == 126 and SECRET not in denied.output
    assert "credential file" in denied.output
    assert backend.execute("echo fine").output.strip() == "fine"


# ── through the real harness ────────────────────────────────────────────────


def _exec(command: str, call_id: str) -> AIMessage:
    return _call("execute", {"command": command}, call_id)


def _call(name: str, args: dict, call_id: str) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": call_id,
                                              "type": "tool_call"}])


def _harness(tmp_path: Path, responses: list):
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    policy = default_policy(home)
    agent = create_harness(ScriptedModel(responses=responses), root_dir=ws, home=home,
                           approvals=policy)
    return agent, policy, ws


CFG = {"configurable": {"thread_id": "t-approvals"}}


def _send(agent, payload: Any):
    agent.invoke(payload, config=CFG)
    return agent.get_state(CFG)


def _user(text: str = "go") -> dict:
    return {"messages": [{"role": "user", "content": text}]}


def _approve(n: int = 1) -> Command:
    return Command(resume={"decisions": [{"type": "approve"}] * n})


def _tool_msgs(state) -> list[ToolMessage]:
    return [m for m in state.values["messages"] if isinstance(m, ToolMessage)]


def test_always_rule_skips_the_prompt_for_that_exact_command_only(tmp_path):
    agent, policy, _ = _harness(tmp_path, [
        _exec("echo one", "c1"), AIMessage(content="done"),
        _exec("echo one", "c2"), AIMessage(content="done"),
        _exec("echo two", "c3"), AIMessage(content="done"),
    ])
    state = _send(agent, _user())
    request = state.interrupts[0].value["action_requests"][0]
    assert request["name"] == "execute"
    assert policy.remember(CFG["configurable"]["thread_id"], "execute", request["args"], "always")
    state = _send(agent, _approve())
    assert not state.interrupts and _tool_msgs(state)[-1].content.startswith("one")

    state = _send(agent, _user("again"))
    assert not state.interrupts, "the always rule must cover the identical command"
    assert _tool_msgs(state)[-1].content.startswith("one")

    state = _send(agent, _user("different"))
    assert state.interrupts, "a different command must ask again"


def test_always_rules_survive_a_new_store(tmp_path):
    root = tmp_path / "approvals"
    first = ApprovalPolicy(ApprovalStore(root))
    assert first.remember("t1", "execute", {"command": "make test"}, "always")
    again = ApprovalPolicy(ApprovalStore(root))
    assert not again.needs_approval("execute", {"command": "make test"}, "t1")
    assert again.needs_approval("execute", {"command": "make test"}, "other-thread")
    files = list(root.iterdir())
    assert files and stat.S_IMODE(os.stat(files[0]).st_mode) == 0o600
    assert "make test" not in files[0].read_text(encoding="utf-8")  # only a hash of it
    assert again.store.revoke("t1", 0) is not None
    assert again.needs_approval("execute", {"command": "make test"}, "t1")


def test_forced_asks_never_become_always(tmp_path):
    agent, policy, ws = _harness(tmp_path, [
        _exec("rm victim.txt", "c1"), AIMessage(content="done"),
        _exec("rm victim.txt", "c2"), AIMessage(content="done"),
    ])
    (ws / "victim.txt").write_text("x", encoding="utf-8")
    state = _send(agent, _user())
    args = state.interrupts[0].value["action_requests"][0]["args"]
    assert policy.review("execute", args).allow_always is False
    assert policy.remember(CFG["configurable"]["thread_id"], "execute", args, "always") is False
    state = _send(agent, Command(resume={"decisions": [{"type": "reject", "message": "no"}]}))
    assert (ws / "victim.txt").exists()
    state = _send(agent, _user("again"))
    assert state.interrupts, "a delete must ask every time"


def test_denied_commands_do_not_prompt_and_do_not_run(tmp_path):
    agent, _, ws = _harness(tmp_path, [_exec("cat .env", "c1"), AIMessage(content="done")])
    (ws / ".env").write_text(f"KEY={SECRET}\n", encoding="utf-8")
    state = _send(agent, _user())
    assert not state.interrupts
    msg = _tool_msgs(state)[-1]
    assert "Denied by approval policy" in msg.content and SECRET not in msg.content


@pytest.mark.parametrize("guard", [True, False])
def test_denial_holds_inside_the_general_purpose_subagent(tmp_path, monkeypatch, guard):
    # 主代理与子代理共用同一个模型脚本：task → 子代理执行 → 子代理收尾 → 主代理收尾。
    # guard=False 是反向对照：拿掉后端拒绝，同一脚本确实会在子代理里把文件拷出来
    if not guard:
        monkeypatch.setattr(ApprovalPolicy, "deny_message", lambda self, command: "")
    agent, _, ws = _harness(tmp_path, [
        _call("task", {"description": "copy the key file", "subagent_type": "general-purpose"},
              "t1"),
        _exec("cp .env leaked.txt", "c1"),
        AIMessage(content="sub done"),
        AIMessage(content="done"),
    ])
    (ws / ".env").write_text(f"KEY={SECRET}\n", encoding="utf-8")
    state = _send(agent, _user())
    assert not state.interrupts
    assert (ws / "leaked.txt").exists() is (not guard)


def test_the_delete_tool_needs_approval(tmp_path):
    agent, policy, ws = _harness(tmp_path, [_call("delete", {"file_path": "/keep.txt"}, "c1"),
                                            AIMessage(content="done")])
    (ws / "keep.txt").write_text("x", encoding="utf-8")
    state = _send(agent, _user())
    request = state.interrupts[0].value["action_requests"][0]
    assert request["name"] == "delete"
    review = policy.review("delete", request["args"])
    assert review.verdict == "ASK_FORCED" and review.warn_delete
    _send(agent, Command(resume={"decisions": [{"type": "reject", "message": "no"}]}))
    assert (ws / "keep.txt").exists()


def test_edit_rules_cover_the_workspace_but_not_outside_it(tmp_path):
    outside = tmp_path / "outside" / "x.txt"
    agent, policy, ws = _harness(tmp_path, [
        _call("write_file", {"file_path": "/a.txt", "content": "a"}, "c1"), AIMessage(content="d"),
        _call("write_file", {"file_path": "/sub/b.txt", "content": "b"}, "c2"),
        AIMessage(content="d"),
        _call("write_file", {"file_path": str(outside), "content": "c"}, "c3"),
        AIMessage(content="d"),
    ])
    thread = CFG["configurable"]["thread_id"]
    state = _send(agent, _user())
    args = state.interrupts[0].value["action_requests"][0]["args"]
    assert policy.remember(thread, "write_file", args, "always")
    _send(agent, _approve())
    state = _send(agent, _user("second"))
    assert not state.interrupts and (ws / "sub" / "b.txt").read_text(encoding="utf-8") == "b"
    state = _send(agent, _user("outside"))
    assert state.interrupts, "a write outside the workspace must still ask"
    assert policy.review("write_file", {"file_path": str(outside)}).allow_always is False


def test_extension_tools_get_a_tool_wide_always_rule():
    policy = ApprovalPolicy(ApprovalStore(Path("/nonexistent-unused")))
    review = policy.review("writer", {"x": 1})
    assert review.allow_always and review.pattern == "*"


# ── session panel ───────────────────────────────────────────────────────────


def _session(tmp_path: Path, monkeypatch) -> CircleSessionApp:
    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, ws, home=home).confirm()
    return CircleSessionApp(init.settings, ws, home=home,
                            model_override=ScriptedModel(responses=[AIMessage(content="ok")]))


def test_panel_asks_each_call_and_resumes_with_every_decision(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch)
    resumed: list[Any] = []
    monkeypatch.setattr(app._bridge, "resume", resumed.append)  # noqa: SLF001
    requests = [{"name": "execute", "args": {"command": "make test"}, "description": ""},
                {"name": "execute", "args": {"command": "rm -rf build"}, "description": ""}]
    app._on_interrupt([SimpleNamespace(value={"action_requests": requests})])  # noqa: SLF001

    first = app._exec_approval  # noqa: SLF001
    assert first is not None and first._payload["allow_always"] is True  # noqa: SLF001
    assert "make test" in first._payload["body"]  # noqa: SLF001
    app._finish_exec_approval({"decision": "always"})  # noqa: SLF001
    assert resumed == [], "must not resume before every call is answered"

    second = app._exec_approval  # noqa: SLF001
    assert second is not None and second._payload["allow_always"] is False  # noqa: SLF001
    assert second._payload["warn_delete"] is True  # noqa: SLF001
    app._finish_exec_approval({"decision": "reject"})  # noqa: SLF001

    assert resumed == [{"decisions": [{"type": "approve"},
                                      {"type": "reject", "message": resumed[0]["decisions"][1]
                                       ["message"]}]}]
    thread = app._thread_id  # noqa: SLF001
    assert not app._approvals.needs_approval("execute", {"command": "make test"}, thread)  # noqa: SLF001

    app._on_submit("/approvals")  # noqa: SLF001
    snap = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    assert "1. execute · this exact command" in snap
    app._on_submit("/approvals revoke 1")  # noqa: SLF001
    assert app._approvals.needs_approval("execute", {"command": "make test"}, thread)  # noqa: SLF001


def test_bridge_resume_passes_structured_values_through(monkeypatch):
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._worker = None  # noqa: SLF001
    captured: list = []
    monkeypatch.setattr(bridge, "_spawn", captured.append)
    value = {"decisions": [{"type": "approve"}, {"type": "reject", "message": "no"}]}
    bridge.resume(value)
    assert captured[0].resume == value
