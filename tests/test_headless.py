import json

from langchain_core.messages import AIMessage

from circle.headless import run_headless
from circle.settings import CircleSettings, ModelAuth
from circle.testing import ScriptedModel
from circle.lsp_tool import run_lsp


def test_print_and_json_use_the_same_durable_history(tmp_path, capsys):
    settings = CircleSettings(initialized=True, auth=ModelAuth(model="synthetic", base_url="http://invalid.example"))
    model = ScriptedModel(responses=[AIMessage(content="TEXT_OK"), AIMessage(content="JSON_OK")])
    assert run_headless(settings, tmp_path, home=tmp_path / "home", prompt="one", session_id="shared", model_override=model) == 0
    assert "TEXT_OK" in capsys.readouterr().out
    assert run_headless(settings, tmp_path, home=tmp_path / "home", prompt="two", mode="json", session_id="shared", model_override=model) == 0
    records = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert records and any("JSON_OK" in json.dumps(record) for record in records)


def test_headless_approval_is_nonzero_and_does_not_write(tmp_path, capsys):
    settings = CircleSettings(initialized=True, auth=ModelAuth(model="synthetic", base_url="http://invalid.example"))
    model = ScriptedModel(responses=[AIMessage(content="", tool_calls=[
        {"name": "write_file", "args": {"file_path": "/marker", "content": "x"}, "id": "t1", "type": "tool_call"}])])
    assert run_headless(settings, tmp_path, home=tmp_path / "home", prompt="test", model_override=model) == 3
    assert not (tmp_path / "marker").exists()
    assert "awaiting_user" in capsys.readouterr().err


def test_multilspy_real_python_definition(tmp_path):
    (tmp_path / "example.py").write_text("def greet():\n    return 'hello'\n\ngreet()\n")
    result = run_lsp(tmp_path, operation="goToDefinition", file_path="example.py", line=4, character=2)
    rows = json.loads(result)
    assert rows and rows[0]["range"]["start"]["line"] == 0
