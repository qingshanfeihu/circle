"""HITL interrupt 携带多个 action_requests 时，resume 必须补齐同等数量的 decisions。

回归：模型并行发起两个需审批的工具调用（如 read_file + execute）时，
langchain HumanInTheLoopMiddleware 期望 decisions 数 == 挂起 tool calls 数，
否则抛 "Number of human decisions (1) does not match number of hanging tool calls (2)."
"""

from types import SimpleNamespace

from circle.tui.harness_bridge import HarnessBridge


def _make_bridge(monkeypatch) -> tuple[HarnessBridge, list]:
    """构造一个不真正跑 agent 的 bridge，捕获 _spawn 的 payload。"""
    bridge = HarnessBridge.__new__(HarnessBridge)
    bridge._worker = None  # is_running 属性需要
    captured: list = []
    monkeypatch.setattr(bridge, "_spawn", lambda payload: captured.append(payload))
    return bridge, captured


def _interrupt_payload(n: int):
    """模拟 langgraph __interrupt__：单个 interrupt 携带 n 个 action_requests。"""
    reqs = [
        {"name": "execute", "args": {"command": f"echo {i}"}, "description": ""}
        for i in range(n)
    ]
    first = SimpleNamespace(value={"action_requests": reqs})
    return [first]


def test_count_action_requests(monkeypatch):
    bridge, _ = _make_bridge(monkeypatch)
    assert bridge._count_action_requests(_interrupt_payload(1)) == 1
    assert bridge._count_action_requests(_interrupt_payload(3)) == 3
    # 兼容裸 dict（无 action_requests 键）
    assert bridge._count_action_requests([SimpleNamespace(value={"name": "x"})]) == 1


def test_resume_fans_out_decision_to_all_pending(monkeypatch):
    bridge, captured = _make_bridge(monkeypatch)
    bridge._cancelled = False
    # 模拟 _run 捕获到携带 2 个 action_requests 的 interrupt
    bridge._pending_action_count = bridge._count_action_requests(
        _interrupt_payload(2)
    )
    assert bridge._pending_action_count == 2

    bridge.resume({"decision": "approve"})
    assert len(captured) == 1
    decisions = captured[0].resume["decisions"]
    assert decisions == [{"type": "approve"}, {"type": "approve"}]
    # 计数已复位，避免泄漏到下一次 resume
    assert bridge._pending_action_count == 1


def test_resume_rejects_all_pending(monkeypatch):
    bridge, captured = _make_bridge(monkeypatch)
    bridge._cancelled = False
    bridge._pending_action_count = 2

    bridge.resume({"decision": "reject"})
    decisions = captured[0].resume["decisions"]
    assert len(decisions) == 2
    assert all(d["type"] == "reject" for d in decisions)


def test_resume_default_single_when_count_unknown(monkeypatch):
    """未知挂起数量时退回 1 个 decision（旧行为）。"""
    bridge, captured = _make_bridge(monkeypatch)
    bridge._cancelled = False
    bridge._pending_action_count = 1
    bridge.resume({"decision": "always_approve"})
    assert captured[0].resume["decisions"] == [{"type": "approve"}]
