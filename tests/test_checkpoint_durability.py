"""Fast multi-step turns finish and persist all tool results before returning."""
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool

from circle.harness import create_harness
from circle.testing import ScriptedModel


def test_fast_multi_step_turn_persists_each_tool_result(tmp_path, monkeypatch):
    monkeypatch.setenv('CIRCLE_LOOP_GUARD', '0')

    @tool
    def tick(index: int) -> str:
        """Return a numbered result."""
        return f'result-{index}'

    replies = [AIMessage(content='', tool_calls=[{
        'name': 'tick', 'args': {'index': i}, 'id': f'tick-{i}'
    }]) for i in range(20)] + [AIMessage(content='done')]
    graph = create_harness(ScriptedModel(responses=replies), root_dir=tmp_path,
                           extra_tools=[tick])
    config = {'configurable': {'thread_id': 'checkpoint-smoke'}, 'recursion_limit': 200}
    result = graph.invoke({'messages': [HumanMessage(content='count')]}, config=config)
    assert result['messages'][-1].content == 'done'
    saved = graph.get_state(config).values['messages']
    assert [m.content for m in saved if isinstance(m, ToolMessage)] == [f'result-{i}' for i in range(20)]
    assert saved[-1].content == 'done'
