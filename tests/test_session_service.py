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


def test_tree_keeps_alternative_branch_selectable_after_restart(tmp_path):
    graph, model = setup(tmp_path)
    turn(graph, "s", "first")
    first = graph.sessions.get("s")["ref"]
    turn(graph, "s", "discarded-branch")
    old_head = graph.sessions.get("s")["ref"]
    graph.sessions.select("s", first)
    turn(graph, "s", "alternative-branch")
    restarted = SessionService(tmp_path / "home", tmp_path / "ws").bind(graph.raw)
    tree = restarted.project_tree("s")
    assert {"discarded-branch", "alternative-branch"} <= {node.text for node in tree.nodes.values()}
    assert "discarded-branch" in tree.render_list()
    imported = graph.import_session(graph.export("s"))
    imported_tree = graph.project_tree(imported)
    assert {"discarded-branch", "alternative-branch"} <= {node.text for node in imported_tree.nodes.values()}
    assert not graph.get_state({"configurable": {"thread_id": imported}}).next
    restarted.sessions.select("s", old_head)
    turn(restarted, "s", "continue-original")
    assert "discarded-branch" in model.inputs[-1]
    assert "alternative-branch" not in model.inputs[-1]


def test_portable_compaction_preserves_next_model_input(tmp_path):
    from deepagents.middleware.summarization import SUMMARIZATION_EVENT_KEY
    graph, model = setup(tmp_path)
    turn(graph, "s", "old detail")
    summary = HumanMessage(content="PORTABLE_SUMMARY", additional_kwargs={"lc_source": "summarization"})
    graph.update_state({"configurable": {"thread_id": "s"}}, {
        SUMMARIZATION_EVENT_KEY: {"cutoff_index": 2, "summary_message": summary, "file_path": "/old-host/history.md"}
    }, as_node="model")
    turn(graph, "s", "settle")
    payload = graph.export("s")
    imported = graph.import_session(payload)
    turn(graph, imported, "continue")
    assert "PORTABLE_SUMMARY" in model.inputs[-1]
    assert "old detail" not in model.inputs[-1]
    assert graph.export(imported)["state"][SUMMARIZATION_EVENT_KEY]["file_path"] is None


def test_concurrent_session_writer_and_selection_are_rejected(tmp_path):
    import pytest
    graph, _ = setup(tmp_path)
    turn(graph, "s", "first")
    another = SessionService(tmp_path / "home", tmp_path / "ws").bind(graph.raw)
    with graph.sessions.run_guard("s"):
        with pytest.raises(RuntimeError, match="already running"):
            turn(another, "s", "overlap")
        with pytest.raises(RuntimeError, match="already running"):
            another.sessions.select("s", another.sessions.get("s")["ref"])
