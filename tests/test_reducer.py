"""Reducer: run, LLM, tool, subagent-parent, thinking and ask-user branches.

Ported from InfoTest ``tests/tui/test_reducer.py``."""

from __future__ import annotations

import pytest

from circle.tui.message_model import (
    BLOCK_ASK_USER,
    BLOCK_TEXT,
    BLOCK_THINKING,
    BLOCK_TOOL_RESULT,
    BLOCK_TOOL_USE,
)

from circle.tui.reducer import MessageReducer

def _evt(kind: str, seq: int, **kw):
    base = {
        "kind": kind,
        "run_id": "r1",
        "seq": seq,
        "ts": "",
        "payload": {},
        "tags": {},
        "usage": None,
    }
    base.update(kw)
    return base


def test_reasoning_token_sets_thinking_phase():
    """reasoning delta（content 空、reasoning 非空）→ llm_phase='thinking'（footer 真实状态源），
    且不混入回答文本；随后 content delta → output。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_token", 1, payload={"reasoning": "让我逐步推理"}))
    assert snaps[-1].llm_phase == "thinking"
    assert snaps[-1].streaming_text is None   # 思考不混入回答文本

    r.dispatch(_evt("llm_token", 2, payload={"reasoning": "继续想"}))
    assert snaps[-1].llm_phase == "thinking"

    r.dispatch(_evt("llm_token", 3, payload={"content": "答案是42"}))
    assert snaps[-1].llm_phase == "output"
    assert snaps[-1].streaming_text == "答案是42"


def test_token_streaming_then_final_clears_streaming_text():
    """`llm_token` 累加到 streaming_text；`llm_end name=final_thought` 清空 + push 终态。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_token", 1, payload={"content": "Hel"}))
    r.dispatch(_evt("llm_token", 2, payload={"content": "lo"}))
    assert snaps[-1].streaming_text == "Hello"
    assert len(snaps[-1].messages) == 0

    r.dispatch(_evt("llm_end", 3, payload={"name": "final_thought", "content": "Hello world"}))
    snap = snaps[-1]
    assert snap.streaming_text is None, "streaming_text must be cleared on final"
    assert len(snap.messages) == 1
    assert snap.messages[0].role == "assistant"
    assert snap.messages[0].content[0].type == BLOCK_TEXT
    assert snap.messages[0].content[0].text == "Hello world"


def test_long_then_short_final_thought_yields_two_independent_messages():
    """本次 bug 的关键场景：长报告 + 短结尾 = 两条独立 assistant message，无任何去重。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    long_report = "# Report\n\n" + ("- bullet line\n" * 200)
    r.dispatch(_evt("llm_end", 1, payload={"name": "final_thought", "content": long_report}))
    r.dispatch(_evt("llm_end", 2, payload={"name": "final_thought", "content": "评审完成。"}))

    snap = snaps[-1]
    assert len(snap.messages) == 2
    assert snap.messages[0].uuid == "r1:1"
    assert snap.messages[1].uuid == "r1:2"
    assert snap.messages[0].content[0].text == long_report
    assert snap.messages[1].content[0].text == "评审完成。"


def test_thought_with_tool_calls_marker_skipped():
    """``[Calling tools]`` 占位不该入 messages（仅清流式态）。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_token", 1, payload={"content": "thinking..."}))
    r.dispatch(_evt("llm_end", 2, payload={"name": "thought", "content": "[Calling tools]"}))

    snap = snaps[-1]
    assert snap.streaming_text is None
    assert len(snap.messages) == 0


def test_llm_phase_input_on_start_output_on_token_cleared_on_end():
    """llm_start→input；llm_token→output+估算 token；llm_end→清空 phase。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_start", 1))
    assert snaps[-1].llm_phase == "input"
    assert snaps[-1].output_token_count == 0

    r.dispatch(_evt("llm_token", 2, payload={"content": "abcd"}))
    assert snaps[-1].llm_phase == "output"
    assert snaps[-1].output_token_count == 1

    r.dispatch(_evt("llm_end", 3, payload={"name": "final_thought", "content": "done"}))
    assert snaps[-1].llm_phase == ""
    assert snaps[-1].output_token_count == 0


def test_usage_only_accumulates_to_snapshot_usage():
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_end", 1, payload={"name": "usage_only"}, usage={
        "input_tokens": 100, "output_tokens": 50, "total_tokens": 150,
    }))
    r.dispatch(_evt("llm_end", 2, payload={"name": "usage_only"}, usage={
        "input_tokens": 30, "output_tokens": 10, "total_tokens": 40,
    }))
    assert dict(snaps[-1].usage) == {"input_tokens": 130, "output_tokens": 60, "total_tokens": 190}
    
    assert len(snaps[-1].messages) == 0


def test_cache_write_fields_accumulate_to_snapshot_usage():
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("llm_end", 1, payload={"name": "usage_only"}, usage={
        "input_tokens": 100, "output_tokens": 50, "total_tokens": 150,
        "prompt_cache_hit_tokens": 60,
        "prompt_cache_write_tokens": 30, "prompt_cache_write_1h_tokens": 10,
    }))
    r.dispatch(_evt("llm_end", 2, payload={"name": "usage_only"}, usage={
        "input_tokens": 30, "output_tokens": 10, "total_tokens": 40,
        "prompt_cache_hit_tokens": 20,
        "prompt_cache_write_tokens": 5, "prompt_cache_write_1h_tokens": 5,
    }))
    usage = dict(snaps[-1].usage)
    assert usage["prompt_cache_hit_tokens"] == 80
    assert usage["prompt_cache_write_tokens"] == 35
    assert usage["prompt_cache_write_1h_tokens"] == 15


def test_tool_call_then_tool_result_pairs_by_tool_use_id():
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("tool_call", 1, tags={"name": "qa_grep"},
                    payload={"name": "qa_grep", "input": {"pattern": "foo"}}))
    r.dispatch(_evt("tool_result", 2, tags={"name": "qa_grep"},
                    payload={"name": "qa_grep", "output": "hit-1\nhit-2"}))

    snap = snaps[-1]
    assert len(snap.messages) == 2
    
    assert snap.messages[0].role == "assistant"
    use_block = snap.messages[0].content[0]
    assert use_block.type == BLOCK_TOOL_USE
    assert use_block.name == "qa_grep"
    assert use_block.tool_use_id == "r1:1"
    
    assert use_block.status == "done"

    
    assert snap.messages[1].role == "user"
    res_block = snap.messages[1].content[0]
    assert res_block.type == BLOCK_TOOL_RESULT
    assert res_block.tool_use_id == "r1:1"
    assert res_block.output == "hit-1\nhit-2"


def test_subagent_inner_event_attaches_parent_tool_use_id():
    """task tool 调用 → 主 agent 发 tool_call；subagent 内部事件带 parent_subagent
    tag → reducer 把 parent_tool_use_id 设为 task tool_use_id。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    
    r.dispatch(_evt("tool_call", 10, tags={"name": "task"},
                    payload={"name": "task", "input": {"subagent_type": "verifier"}}))
    
    r.dispatch(_evt("llm_end", 11,
                    tags={"parent_subagent": "verifier"},
                    payload={"name": "final_thought", "content": "verifier report"}))

    snap = snaps[-1]
    
    verifier_msg = next(m for m in snap.messages if m.subagent_type == "verifier")
    assert verifier_msg.parent_tool_use_id == "r1:10"
    assert verifier_msg.content[0].text == "verifier report"


def test_thinking_block_creates_thinking_content():
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("info", 1, payload={"name": "thinking_block", "thinking": "deep thought"}))
    snap = snaps[-1]
    assert len(snap.messages) == 1
    block = snap.messages[0].content[0]
    assert block.type == BLOCK_THINKING
    assert block.thinking == "deep thought"


def test_run_lifecycle_status_transitions():
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    assert r.snapshot().status == "idle"
    r.dispatch(_evt("run_start", 1))
    assert snaps[-1].status == "running"
    r.dispatch(_evt("run_end", 2))
    assert snaps[-1].status == "done"


def test_set_run_status_external_hook_propagates():
    """bridge 在 worker 完成时调 reducer.set_run_status——确认会触发 notify。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.set_run_status("done")
    assert snaps[-1].status == "done"


def test_messages_tuple_immutable_across_dispatches():
    """每次 dispatch 后 snapshot.messages 是新 tuple（不影响之前订阅者）。"""
    r = MessageReducer()
    captured: list[tuple] = []

    def cb(s):
        captured.append(s.messages)

    r.subscribe(cb)
    r.dispatch(_evt("llm_end", 1, payload={"name": "final_thought", "content": "a"}))
    r.dispatch(_evt("llm_end", 2, payload={"name": "final_thought", "content": "b"}))

    
    assert captured[0] is not captured[1]
    assert len(captured[0]) == 1
    assert len(captured[1]) == 2
    
    assert isinstance(captured[0], tuple)


def _find(snap, seq):
    """按 uuid 后缀 seq 找 message。"""
    return next(m for m in snap.messages if m.uuid.endswith(f":{seq}"))


def test_rev_monotonic_across_reset():
    """rev 跨 reset 不清零(清零=reset 后全部快照被 UI 判旧丢弃)。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)
    r.dispatch(_evt("tool_call", 1, tags={"name": "ls"}, payload={"input": {}}))
    rev_before = snaps[-1].rev
    r.reset()
    assert snaps[-1].rev > rev_before, "reset 后 rev 必须继续递增"
    assert snaps[-1].messages == ()
    r.dispatch(_evt("tool_call", 2, tags={"name": "ls"}, payload={"input": {}}))
    assert snaps[-1].rev > rev_before + 1


def test_ask_user_answered_marks_block_answered():
    """ask_user_answered 回边:按 question_id 把 snapshot 里那条 ask_user 块**原位**标
    answered + answers(生命周期对称:问了/答了都进 snapshot,供全量重放渲折叠态而非
    复活面板)。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)

    r.dispatch(_evt("ask_user_request", 1,
                    payload={"question_id": "qX", "questions": [{"question": "v?"}]}))
    blocks = [b for m in snaps[-1].messages for b in m.content if b.type == BLOCK_ASK_USER]
    assert len(blocks) == 1 and not blocks[0].payload.get("answered")

    r.dispatch(_evt("ask_user_answered", 2,
                    payload={"question_id": "qX", "answers": {"v?": "10.5"}}))
    blocks = [b for m in snaps[-1].messages for b in m.content if b.type == BLOCK_ASK_USER]
    assert len(blocks) == 1                                   # 原位标记,不新增块
    assert blocks[0].payload.get("answered") is True
    assert blocks[0].payload.get("answers") == {"v?": "10.5"}


def test_ask_user_answered_unknown_qid_is_noop():
    """未知 question_id 的 answered 事件 = no-op(不崩、不误改别的 ask_user 块)。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)
    r.dispatch(_evt("ask_user_request", 1,
                    payload={"question_id": "qX", "questions": [{"question": "v?"}]}))
    r.dispatch(_evt("ask_user_answered", 2, payload={"question_id": "NOPE", "answers": {}}))
    blocks = [b for m in snaps[-1].messages for b in m.content if b.type == BLOCK_ASK_USER]
    assert len(blocks) == 1 and not blocks[0].payload.get("answered")


def test_ask_user_presented_marks_existing_block_without_creating_another():
    """scheduled/request 与实际呈现分态；presented 只原位更新同一问询块。"""
    r = MessageReducer()
    r.dispatch(_evt("ask_user_request", 1, payload={
        "question_id": "qP",
        "questions": [{"question": "v?"}],
    }))
    before = [b for m in r.snapshot().messages for b in m.content
              if b.type == BLOCK_ASK_USER]
    assert len(before) == 1
    assert before[0].payload["scheduled"] is True
    assert before[0].payload["presented"] is False

    r.dispatch(_evt("ask_user_presented", 2, payload={
        "question_id": "qP",
        "channel": "ink_tui",
        "redacted_render_digest": "a" * 64,
        "option_tokens": [["A", "B", "Other"]],
        "ts": 1.5,
    }))
    after = [b for m in r.snapshot().messages for b in m.content
             if b.type == BLOCK_ASK_USER]
    assert len(after) == 1
    assert after[0].payload["presented"] is True
    assert after[0].payload["presented_channel"] == "ink_tui"
    assert after[0].payload["redacted_render_digest"] == "a" * 64


@pytest.mark.parametrize("outcome", ["answered", "cancelled", "timeout", "teardown",
                                     "non_interactive"])
def test_ask_user_resolved_marks_block_terminal_with_exact_outcome(outcome):
    """所有问询出口共用明确终态；snapshot 不得把 timeout/cancel 当仍待答。"""
    r = MessageReducer()
    snaps = []
    r.subscribe(snaps.append)
    r.dispatch(_evt("ask_user_request", 1,
                    payload={"question_id": "qR", "questions": [{"question": "v?"}]}))
    answers = {"v?": "10.5"} if outcome == "answered" else {}
    r.dispatch(_evt("ask_user_resolved", 2, payload={
        "question_id": "qR", "outcome": outcome, "answers": answers,
        "reason": "done", "ts": 1.5,
    }))

    blocks = [b for m in snaps[-1].messages for b in m.content if b.type == BLOCK_ASK_USER]
    assert len(blocks) == 1
    assert blocks[0].payload["resolved"] is True
    assert blocks[0].payload["outcome"] == outcome
    assert blocks[0].payload["answers"] == answers
    assert blocks[0].payload["reason"] == "done"


def test_ask_user_first_terminal_wins_during_replay_or_race():
    """同一 qid 的迟到冲突终态不得把 timeout 改写成 answered。"""
    r = MessageReducer()
    r.dispatch(_evt("ask_user_request", 1,
                    payload={"question_id": "q-one", "questions": [{"question": "v?"}]}))
    r.dispatch(_evt("ask_user_resolved", 2, payload={
        "question_id": "q-one", "outcome": "timeout", "answers": {},
        "reason": "deadline", "ts": 1.0,
    }))
    r.dispatch(_evt("ask_user_resolved", 3, payload={
        "question_id": "q-one", "outcome": "answered", "answers": {"v?": "迟到"},
        "reason": "late", "ts": 2.0,
    }))

    block = next(
        b for m in r.snapshot().messages for b in m.content
        if b.type == BLOCK_ASK_USER
    )
    assert block.payload["outcome"] == "timeout"
    assert block.payload["answers"] == {}
    assert block.payload["reason"] == "deadline"
