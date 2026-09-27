"""LangChain model boundary backed by Pi's public model SDK, never its agent."""
from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from circle.middleware.redact import redact
from circle.paths import circle_home
from circle.run_control import check_cancelled


def bridge_events(method: str, params: dict, *, home: Path | None = None,
                  timeout: float = 180.0, on_prompt=None) -> Iterator[dict]:
    script = Path(__file__).parent / "node" / "bridge.mjs"
    node = os.environ.get("CIRCLE_NODE") or shutil.which("node")
    if not node or not (script.parent / "node_modules").is_dir():
        raise RuntimeError("Provider bridge unavailable. Run npm ci --ignore-scripts --prefix circle/node, or use the runtime release")
    child = subprocess.Popen([node, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, env={**os.environ, "PI_TELEMETRY": "0"})
    records: queue.Queue = queue.Queue()
    prompts = {}
    write_lock = threading.Lock()

    def read_records():
        try:
            for line in child.stdout:
                records.put(json.loads(line))
        except (ValueError, OSError) as exc:
            records.put(exc)
        finally:
            records.put(None)

    reader = threading.Thread(target=read_records, daemon=True)
    reader.start()
    request = {"jsonrpc": "2.0", "id": 1, "method": method,
               "params": {**params, "home": str(home or circle_home())}}
    child.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
    child.stdin.flush()
    deadline = time.monotonic() + timeout
    try:
        while True:
            check_cancelled()
            if time.monotonic() >= deadline:
                raise TimeoutError("Provider bridge timed out")
            try:
                item = records.get(timeout=0.1)
            except queue.Empty:
                continue
            if item is None:
                # Never echo process stderr; SDK failures can include credentials.
                raise RuntimeError(f"Provider bridge exited without a result (code {child.poll()})")
            if isinstance(item, Exception):
                raise TypeError("Invalid provider bridge response") from item
            if item.get("method") == "auth_prompt" and on_prompt:
                p = item["params"]
                cancelled = threading.Event()
                prompts[p["prompt_id"]] = cancelled
                def answer_prompt(prompt=p, cancellation=cancelled):
                    try:
                        answer = on_prompt({**prompt["prompt"], "cancelled": cancellation})
                        if not cancellation.is_set():
                            with write_lock:
                                child.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "auth_answer",
                                    "params": {"prompt_id": prompt["prompt_id"], "answer": answer}}) + "\n")
                                child.stdin.flush()
                    except Exception as exc:  # noqa: BLE001 -- prompt callback boundary
                        if not cancellation.is_set():
                            records.put(exc)
                threading.Thread(target=answer_prompt, daemon=True).start()
            if item.get("method") == "auth_prompt_cancelled":
                pending = prompts.get(item["params"]["prompt_id"])
                if pending is not None:
                    pending.set()
            if "error" in item:
                raise RuntimeError(redact(str(item["error"].get("message") or "Provider error")))
            yield item
            if "result" in item:
                return
    finally:
        for cancellation in prompts.values():
            cancellation.set()
        if child.poll() is None:
            child.kill()
        child.communicate()
        reader.join(timeout=1)


def bridge_call(method: str, params: dict, *, home: Path | None = None) -> Any:
    return next(event["result"] for event in bridge_events(method, params, home=home) if "result" in event)


def _blocks(content: Any) -> list[dict]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    blocks = []
    for block in content:
        if isinstance(block, str):
            blocks.append({"type": "text", "text": block})
        elif block.get("type") == "text":
            blocks.append({"type": "text", "text": block["text"]})
        elif block.get("type") == "image" and block.get("base64"):
            blocks.append({"type": "image", "data": block["base64"], "mimeType": block["mime_type"]})
        else:
            raise ValueError(f"Unsupported model input block: {block.get('type')}")
    return blocks


def pi_context(messages, tools, provider, model) -> dict:
    rows = []
    empty_usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                   "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
    for message in messages:
        if isinstance(message, SystemMessage):
            row = {"role": "system", "content": message.content}
        elif isinstance(message, HumanMessage):
            row = {"role": "user", "content": _blocks(message.content)}
        elif isinstance(message, ToolMessage):
            row = {"role": "toolResult", "toolCallId": message.tool_call_id, "toolName": message.name,
                   "content": _blocks(message.content), "isError": message.status == "error"}
        elif isinstance(message, AIMessage):
            original = message.additional_kwargs.get("circle_pi_message")
            if original:
                row = {**original, "content": [b for b in original["content"] if b["type"] != "toolCall"]}
            else:
                row = {"role": "assistant", "content": _blocks(message.content), "api": "openai-completions",
                       "provider": provider, "model": model, "usage": empty_usage, "stopReason": "stop"}
            row["content"].extend({"type": "toolCall", "id": c["id"], "name": c["name"], "arguments": c["args"]}
                                   for c in message.tool_calls)
        else:
            raise TypeError(f"Unsupported message: {message.type}")
        row.setdefault("timestamp", int(time.time() * 1000))
        rows.append(row)
    return {"messages": rows, "tools": tools}


class PiChatModel(BaseChatModel):
    provider: str
    model: str
    home: Path = Field(default_factory=circle_home)
    base_url: str = ""
    options: dict = Field(default_factory=dict)
    tools: list[dict] = Field(default_factory=list)
    catalog_model: dict = Field(default_factory=dict)

    @property
    def _llm_type(self):
        return "circle-pi-model-adapter"

    def bind_tools(self, tools, **kwargs):
        converted = [convert_to_openai_tool(tool)["function"] for tool in tools]
        return self.model_copy(update={"tools": converted})

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        params = {"provider": self.provider, "model": self.model, "base_url": self.base_url,
                  "context": pi_context(messages, self.tools, self.provider, self.model), "options": self.options}
        for event in bridge_events("generate", params, home=self.home):
            if event.get("method") == "model_delta":
                data = event["params"]
                if data["type"] == "text_delta":
                    yield ChatGenerationChunk(message=AIMessageChunk(content=data["delta"]))
                else:
                    yield ChatGenerationChunk(message=AIMessageChunk(content=[{"type": "thinking", "thinking": data["delta"]}]))
            elif "result" in event:
                result = event["result"]
                calls = [{"name": b["name"], "args": b["arguments"], "id": b["id"], "type": "tool_call"}
                         for b in result["content"] if b["type"] == "toolCall"]
                usage = result["usage"]
                input_count = sum(usage.get(k, 0) for k in ("input", "cacheRead", "cacheWrite"))
                output_count = usage.get("output", 0)
                yield ChatGenerationChunk(message=AIMessageChunk(content="", tool_calls=calls,
                    additional_kwargs={"circle_pi_message": result},
                    response_metadata={"finish_reason": result["stopReason"], "model_name": result["model"]},
                    usage_metadata={"input_tokens": input_count, "output_tokens": output_count,
                                    "total_tokens": input_count + output_count,
                                    "input_token_details": {"cache_read": usage.get("cacheRead", 0), "cache_creation": usage.get("cacheWrite", 0)}}))

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        combined = None
        for chunk in self._stream(messages, stop=stop, run_manager=run_manager, **kwargs):
            combined = chunk.message if combined is None else combined + chunk.message
        if combined is None:
            raise RuntimeError("Provider returned no message")
        return ChatResult(generations=[ChatGeneration(message=AIMessage(**combined.model_dump(exclude={"type", "tool_call_chunks", "chunk_position"})))])
