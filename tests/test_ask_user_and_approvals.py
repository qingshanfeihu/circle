"""The question tool pauses for real answers from the question panel (one interrupt per
call, several resumed together by id); line mode keeps the text form; secrets are still
collected once through the masked channel. /approvals opens a page that revokes rules."""

from __future__ import annotations

import json
import re

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.types import Command

from circle.harness import create_harness
from circle.ink import theme
from circle.ink.components.ask_user_view import AskUserSession
from circle.ink.parse_keypress import KeyPress
from circle.testing import ScriptedModel

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@pytest.fixture(autouse=True)
def _palette():
    theme.reset_palette()
    theme.set_palette(theme.build_palette("#d6dee6", "#10151a"))
    yield
    theme.reset_palette()


def _calls(*calls):
    return AIMessage(content="", tool_calls=[{"name": n, "args": a, "id": i, "type": "tool_call"}
                                             for n, a, i in calls])


QUESTION = {"question": "Which database?", "options": ["Postgres (Recommended)",
                                                       {"label": "SQLite", "description": "file"}]}


def _agent(tmp_path, responses, *, ask_user=True):
    return create_harness(ScriptedModel(responses=responses), root_dir=tmp_path,
                          home=tmp_path / "home", ask_user=ask_user)


def _tool_messages(result, name="question"):
    return [m for m in result["messages"] if isinstance(m, ToolMessage) and m.name == name]


def _answers(message: ToolMessage) -> list[dict]:
    text = str(message.content)
    return json.loads(text[text.index("["):])


# ── the tool ───────────────────────────────────────────────────────────────


def test_question_pauses_and_the_resume_value_becomes_the_answer(tmp_path):
    agent = _agent(tmp_path, [_calls(("question", {"questions": [QUESTION]}, "q1")),
                              AIMessage(content="ok")])
    config = {"configurable": {"thread_id": "t"}}
    paused = agent.invoke({"messages": [{"role": "user", "content": "set up"}]}, config=config)
    (interrupt,) = paused["__interrupt__"]
    assert interrupt.value == {"kind": "ask_user", "questions": [{
        "question": "Which database?", "header": "",
        "options": [{"label": "Postgres (Recommended)", "description": ""},
                    {"label": "SQLite", "description": "file"}],
        "multiSelect": False, "allow_other": True}]}
    done = agent.invoke(Command(resume={"answers": [["SQLite"]]}), config=config)
    assert _answers(_tool_messages(done)[0]) == [{"question": "Which database?",
                                                  "answer": ["SQLite"]}]


def test_parallel_questions_resume_together_by_interrupt_id(tmp_path):
    agent = _agent(tmp_path, [
        _calls(("question", {"questions": [{"question": "A?"}]}, "q1"),
               ("question", {"questions": [{"question": "B?"}]}, "q2")),
        AIMessage(content="ok")])
    config = {"configurable": {"thread_id": "t"}}
    paused = agent.invoke({"messages": [{"role": "user", "content": "go"}]}, config=config)
    pending = {i.value["questions"][0]["question"]: i.id for i in paused["__interrupt__"]}
    assert set(pending) == {"A?", "B?"}
    done = agent.invoke(Command(resume={pending["A?"]: {"answers": [["yes"]]},
                                        pending["B?"]: {"cancelled": True}}), config=config)
    by_id = {m.tool_call_id: str(m.content) for m in _tool_messages(done)}
    assert '"answer": [\n      "yes"\n    ]' in by_id["q1"]
    assert "closed the question panel without answering" in by_id["q2"]


def test_line_mode_keeps_the_text_form(tmp_path):
    agent = _agent(tmp_path, [_calls(("question", {"questions": [QUESTION]}, "q1")),
                              AIMessage(content="ok")], ask_user=False)
    result = agent.invoke({"messages": [{"role": "user", "content": "go"}]},
                          config={"configurable": {"thread_id": "t"}})
    assert "__interrupt__" not in result
    assert "USER_QUESTIONS" in str(_tool_messages(result)[0].content)


def test_secrets_are_collected_once_after_the_plain_answers(tmp_path, monkeypatch):
    from circle import secret_prompt

    collected = []

    def fake_collect(home, questions):
        collected.append([q["key"] for q in questions])
        return ["  - DB_PASS: collected"]

    monkeypatch.setattr(secret_prompt, "collect", fake_collect)
    secret = {"question": "DB password", "secret": True, "key": "DB_PASS", "target_file": "x.env"}
    agent = _agent(tmp_path, [_calls(("question", {"questions": [QUESTION, secret]}, "q1")),
                              AIMessage(content="ok")])
    config = {"configurable": {"thread_id": "t"}}
    agent.invoke({"messages": [{"role": "user", "content": "go"}]}, config=config)
    assert collected == [], "nothing is collected before the panel is answered"
    done = agent.invoke(Command(resume={"answers": [["SQLite"]]}), config=config)
    assert collected == [["DB_PASS"]]
    text = str(_tool_messages(done)[0].content)
    assert "SQLite" in text and "DB_PASS: collected" in text


# ── the panel ──────────────────────────────────────────────────────────────


def _panel(questions):
    got: list = []
    session = AskUserSession(questions, render=lambda: None, on_answer=got.append)
    return session, got


def _q(question, labels, **extra):
    return {"question": question, "options": [{"label": x} for x in labels], **extra}


def test_digits_answer_and_advance_then_submit():
    session, got = _panel([_q("A?", ["x", "y"]), _q("B?", ["z"])])
    session.handle_key("2", "2")
    assert got == []
    session.handle_key("1", "1")
    assert got == [[["y"], ["z"]]]


def test_multi_select_space_then_enter_and_typed_answers():
    session, got = _panel([_q("Pick", ["a", "b", "c"], multiSelect=True)])
    session.handle_key(" ", " ")
    session.handle_key("down", "")
    session.handle_key("down", "")
    session.handle_key(" ", " ")
    session.handle_key("o", "o")
    assert session.in_other_input
    session.submit_other_text("my own")
    session.handle_key("enter", "\r")
    assert got == [[["a", "c", "my own"]]]


def test_escape_after_answering_asks_to_confirm_and_cancel_reports_none():
    session, got = _panel([_q("A?", ["x"]), _q("B?", ["y"])])
    session.handle_key("1", "1")
    session.handle_key("escape", "")
    assert got == [] and "确定全部放弃" in ANSI.sub("", "\n".join(session.render_lines()))
    session.handle_key("escape", "")
    assert got == [None]


def test_submitting_with_an_unanswered_question_warns_once():
    session, got = _panel([_q("A?", ["x"]), _q("B?", ["y"])])
    session.handle_key("1", "1")
    session.handle_key("up", "")
    session.handle_key("escape", "")
    assert got == [], "a moved but unchosen cursor warns before cancelling"


# ── the session ────────────────────────────────────────────────────────────


def _session(tmp_path, monkeypatch, responses):
    from tests.test_progress_handler import _session as make

    return make(tmp_path, monkeypatch, responses)


def _wait(app):
    from tests.test_progress_handler import _wait_idle

    _wait_idle(app)


def test_session_turn_answers_through_the_panel(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [
        _calls(("question", {"questions": [QUESTION]}, "q1")),
        AIMessage(content="Using SQLite then."),
    ])
    app._prompt.set_value("draft")  # noqa: SLF001
    app._on_submit("set up the db")  # noqa: SLF001
    _wait(app)
    assert app._ask_session is not None  # noqa: SLF001
    panel = ANSI.sub("", "\n".join(app._ask_session.render_lines()))  # noqa: SLF001
    assert "Which database?" in panel and "SQLite" in panel
    app._handle_key(KeyPress(key="2", char="2"))  # noqa: SLF001
    _wait(app)
    assert app._ask_session is None  # noqa: SLF001
    text = ANSI.sub("", "\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert "The user answered in the question panel" in text
    assert "Using SQLite then." in text and text.count("✻ Cooked") == 1


def test_typed_answer_goes_through_the_prompt(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [
        _calls(("question", {"questions": [{"question": "Name?"}]}, "q1")),
        AIMessage(content="thanks"),
    ])
    app._on_submit("go")  # noqa: SLF001
    _wait(app)
    for key in ["enter", *"Ada", "enter"]:
        app._handle_key(KeyPress(key=key, char=key if len(key) == 1 else ""))  # noqa: SLF001
    _wait(app)
    text = ANSI.sub("", "\n".join(app._transcript.snapshot()))  # noqa: SLF001
    assert "The user answered" in text and "thanks" in text


def test_cancelling_the_turn_closes_the_panel(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [
        _calls(("question", {"questions": [QUESTION]}, "q1")),
        AIMessage(content="never"),
    ])
    app._on_submit("go")  # noqa: SLF001
    _wait(app)
    assert app._ask_session is not None  # noqa: SLF001
    app._handle_key(KeyPress(key="ctrl+c", ctrl=True, char="c"))  # noqa: SLF001
    assert app._ask_session is None and not app._ask_panel.is_visible  # noqa: SLF001


def test_approvals_page_revokes_a_rule(tmp_path, monkeypatch):
    app = _session(tmp_path, monkeypatch, [AIMessage(content="ok")])
    store = app._approvals.store  # noqa: SLF001
    store.record(app._thread_id, "always", "execute", "hash-1", "npm test")  # noqa: SLF001
    app._cmd_approvals("")  # noqa: SLF001
    page = app._approvals_page  # noqa: SLF001
    assert page is not None
    text = ANSI.sub("", "\n".join(page.render_lines()))
    assert "[always] execute · npm test" in text and "撤销: npm test" in text
    app._handle_key(KeyPress(key="enter", char="\r"))  # noqa: SLF001
    assert app._approvals_page is None  # noqa: SLF001
    assert store.rules(app._thread_id) == []  # noqa: SLF001
