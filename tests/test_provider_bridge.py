import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from circle.provider_bridge import PiChatModel, bridge_call, pi_context


def test_context_preserves_signatures_and_repaired_tool_calls():
    original = {"role": "assistant", "provider": "anthropic", "model": "m", "api": "anthropic-messages",
                "content": [{"type": "thinking", "thinking": "reason", "thinkingSignature": "sig"},
                            {"type": "toolCall", "id": "t", "name": "Wrong", "arguments": {}}]}
    msg = AIMessage(content="", additional_kwargs={"circle_pi_message": original},
                    tool_calls=[{"name": "read_file", "args": {"file_path": "/x"}, "id": "t", "type": "tool_call"}])
    rows = pi_context([msg, ToolMessage(content="result", tool_call_id="t", name="read_file")], [], "p", "m")["messages"]
    assert rows[0]["content"][0]["thinkingSignature"] == "sig"
    assert rows[0]["content"][1]["name"] == "read_file"
    assert rows[1]["toolCallId"] == "t"


def test_upstream_catalog_without_credentials(tmp_path):
    rows = bridge_call("catalog", {}, home=tmp_path)
    assert {"openai", "openai-codex", "anthropic", "google", "amazon-bedrock"} <= {row["id"] for row in rows}
    assert not (tmp_path / "provider-credentials.json").exists()


def test_real_model_sdk_streams_against_local_response_server(tmp_path):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            item = {"type": "message", "id": "msg-1", "role": "assistant", "status": "completed",
                    "content": [{"type": "output_text", "text": "BRIDGE_OK", "annotations": []}]}
            response = {"id": "resp-1", "object": "response", "model": "gpt-4.1", "status": "completed",
                        "output": [item], "usage": {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13,
                                                    "input_tokens_details": {"cached_tokens": 0},
                                                    "output_tokens_details": {"reasoning_tokens": 0}}}
            events = [
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": {**item, "content": []}},
                {"type": "response.content_part.added", "output_index": 0, "content_index": 0,
                 "part": {"type": "output_text", "text": "", "annotations": []}},
                {"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "delta": "BRIDGE_OK"},
                {"type": "response.output_item.done", "output_index": 0, "item": item},
                {"type": "response.completed", "response": response},
            ]
            for event in events:
                self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        model = PiChatModel(provider="openai", model="gpt-4.1", home=tmp_path,
                            base_url=f"http://127.0.0.1:{server.server_port}/v1",
                            options={"apiKey": "synthetic-placeholder", "maxTokens": 32})
        result = model.invoke([HumanMessage(content="synthetic prompt")])
        assert "BRIDGE_OK" in result.content
        assert result.usage_metadata["total_tokens"] == 13
        assert result.additional_kwargs["circle_pi_message"]["responseId"] == "resp-1"
        assert requests
    finally:
        server.shutdown()
        server.server_close()
