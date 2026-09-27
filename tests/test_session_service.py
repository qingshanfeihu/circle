from pathlib import Path

from langchain_core.messages import AIMessage, HumanMessage
from pydantic import Field

from circle.checkpoint_store import make_checkpointer
from circle.harness import create_harness
from circle.session_service import SessionService
from circle.testing import ScriptedModel


class CapturingModel(ScriptedModel):
    inputs: list[list[str]] = Field(default_factory=list)

    def _generate(self, messages, *args, **kwargs):
        self.inputs.append([str(m.content) for m in messages])
        return super()._generate(messages, *args, **kwargs)


def setup(tmp_path: Path):
    ws, home = tmp_path / "ws", tmp_path / "home"
    ws.mkdir()
    sessions = SessionService(home, ws)
    model = CapturingModel(responses=[AIMessage(content=f"answer-{n}") for n in range(10)])
    agent = create_harness(model, root_dir=ws, home=home, checkpointer=make_checkpointer(home))
    return sessions.bind(agent), model


def turn(graph, sid, text):
    return graph.invoke({"messages": [HumanMessage(content=text)]}, {"configurable": {"thread_id": sid}})


def test_selected_checkpoint_controls_next_model_request(tmp_path):
    graph, model = setup(tmp_path)
    turn(graph, "s", "first")
    first = graph.sessions.get("s")["ref"]
    turn(graph, "s", "second")
    graph.sessions.select("s", first)
    turn(graph, "s", "alternative")
    assert "first" in model.inputs[-1]
    assert "second" not in model.inputs[-1]
    assert "alternative" in model.inputs[-1]


def test_fork_preserves_delta_ancestors_and_isolates_future_inputs(tmp_path):
    graph, model = setup(tmp_path)
    turn(graph, "s", "first")
    first = graph.sessions.get("s")["ref"]
    turn(graph, "s", "second")
    fork = graph.sessions.fork("s", ref=first)
    turn(graph, fork, "branch")
    assert "first" in model.inputs[-1] and "second" not in model.inputs[-1]
    turn(graph, "s", "original")
    assert "second" in model.inputs[-1] and "branch" not in model.inputs[-1]


def test_empty_checkpoint_is_not_latest_after_undo(tmp_path):
    graph, model = setup(tmp_path)
    graph.sessions.ensure("s")
    empty = graph.sessions.get("s")["ref"]
    turn(graph, "s", "discard")
    graph.sessions.select("s", empty)
    turn(graph, "s", "fresh")
    assert "discard" not in model.inputs[-1]


def test_restart_discovers_and_restores_sessions(tmp_path):
    graph, _ = setup(tmp_path)
    turn(graph, "s", "persistent")
    restarted = SessionService(tmp_path / "home", tmp_path / "ws").bind(graph.raw)
    assert restarted.sessions.list()[0]["id"] == "s"
    state = restarted.get_state({"configurable": {"thread_id": "s"}})
    assert state.values["messages"][0].content == "persistent"


def test_export_import_preserves_full_structured_history(tmp_path):
    graph, model = setup(tmp_path)
    text = "long-content-" * 1000
    turn(graph, "s", text)
    restored = graph.import_session(graph.export("s"))
    turn(graph, restored, "continue")
    assert text in model.inputs[-1]
