"""Model guards (C4): retries per error kind with Retry-After, dropped parameters,
stalls, repetition, missing finish signals, and the effort fitted to the model family —
driven by a scripted streaming model that raises real SDK error types."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import openai
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGenerationChunk
from pydantic import Field

import circle.model_guard as mg
from circle.model import _clamp_effort, apply_reasoning
from circle.text_repetition import RepetitionMonitor

REQ = httpx.Request("POST", "https://gateway.example/v1/chat/completions")


def status_error(code: int, message: str = "error", *, headers: dict | None = None,
                 body: dict | None = None) -> openai.APIStatusError:
    response = httpx.Response(code, headers=headers or {}, request=REQ, json=body or {})
    cls = {400: openai.BadRequestError, 429: openai.RateLimitError,
           500: openai.InternalServerError}.get(code, openai.APIStatusError)
    return cls(message, response=response, body=body)


def text(value: str, finish: str | None = None) -> ChatGenerationChunk:
    return ChatGenerationChunk(message=AIMessageChunk(content=value),
                               generation_info={"finish_reason": finish} if finish else None)


def keepalive() -> ChatGenerationChunk:
    return ChatGenerationChunk(message=AIMessageChunk(content=""))


def reasoning(value: str) -> ChatGenerationChunk:
    return ChatGenerationChunk(message=AIMessageChunk(
        content="", additional_kwargs={"reasoning_content": value}))


class Scripted(BaseChatModel):
    """Each request takes the next script: a list of chunks, exceptions or callables."""

    scripts: list[list[Any]] = Field(default_factory=list)
    seen: list[dict[str, Any]] = Field(default_factory=list)
    reasoning_effort: str | None = None
    extra_body: dict | None = None

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise NotImplementedError

    def _stream(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append({"messages": list(messages), "kwargs": dict(kwargs),
                          "effort": self.reasoning_effort,
                          "extra": dict(self.extra_body or {})})
        for step in self.scripts.pop(0):
            if isinstance(step, BaseException):
                raise step
            if callable(step):
                step()
                continue
            yield step


class AsyncScripted(Scripted):
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        for chunk in Scripted._stream(self, messages, stop, run_manager, **kwargs):
            yield chunk


@pytest.fixture
def sleeps(monkeypatch):
    waited: list[float] = []
    monkeypatch.setattr(mg, "_sleep", waited.append)
    return waited


def _run(model: Any, **kwargs) -> str:
    return "".join(str(c.content) for c in model.stream("hi", **kwargs))


def test_rate_limit_waits_as_the_endpoint_asks_then_succeeds(sleeps):
    events: list[dict] = []
    remove = mg.add_retry_listener(events.append)
    try:
        model = mg.guard_model(Scripted(scripts=[
            [status_error(429, "slow down", headers={"retry-after": "7"})],
            [status_error(503, "busy")],
            [text("ok", "stop")],
        ]))
        assert _run(model) == "ok"
    finally:
        remove()
    assert sleeps[0] == 7.0 and 1.5 <= sleeps[1] <= 2.5
    assert [e["kind"] for e in events] == ["rate_limit", "server"]


def test_quota_and_client_errors_are_not_retried(sleeps):
    for exc in (status_error(402, "pay up"),
                status_error(429, "quota", body={"error": {"code": "insufficient_quota"}}),
                status_error(401, "bad key")):
        model = mg.guard_model(Scripted(scripts=[[exc], [text("never", "stop")]]))
        with pytest.raises(type(exc)):
            _run(model)
    assert sleeps == []


def test_network_errors_use_their_own_budget(sleeps):
    scripts = [[openai.APIConnectionError(request=REQ)] for _ in range(10)]
    model = mg.guard_model(Scripted(scripts=scripts))
    with pytest.raises(openai.APIConnectionError):
        _run(model)
    assert len(sleeps) == mg.BUDGETS["network"].max_retries
    assert sleeps[:3] == [3.0, 6.0, 12.0]


def test_errors_after_output_are_not_retried(sleeps):
    model = mg.guard_model(Scripted(scripts=[[text("partial "), status_error(500, "boom")],
                                             [text("again", "stop")]]))
    with pytest.raises(openai.InternalServerError):
        _run(model)
    assert sleeps == []


def test_a_rejected_parameter_is_dropped_and_stays_dropped(sleeps):
    rejected = status_error(400, "Unsupported value: the reasoning_effort parameter is invalid",
                            body={"error": {"param": "reasoning_effort"}})
    inner = Scripted(reasoning_effort="xhigh",
                     scripts=[[rejected], [text("ok", "stop")], [text("again", "stop")]])
    model = mg.guard_model(inner)
    assert _run(model) == "ok"
    assert [s["effort"] for s in model.seen] == ["xhigh", None]
    assert mg.downgrades(model) == {"reasoning_effort": "rejected by the endpoint (400)"}
    assert _run(model) == "again" and model.seen[-1]["effort"] is None
    assert sleeps == []


def test_only_the_named_parameter_is_dropped():
    rejected = status_error(400, "Invalid request: the thinking parameter is not supported",
                            body={"error": {"param": "thinking"}})
    model = mg.guard_model(Scripted(reasoning_effort="high",
                                    extra_body={"thinking": {"type": "enabled"}, "top_k": 3},
                                    scripts=[[rejected], [text("ok", "stop")]]))
    assert _run(model) == "ok"
    assert model.seen[-1]["effort"] == "high" and model.seen[-1]["extra"] == {"top_k": 3}


def test_unrelated_bad_requests_are_raised():
    model = mg.guard_model(Scripted(reasoning_effort="high",
                                    scripts=[[status_error(400, "context length exceeded")]]))
    with pytest.raises(openai.BadRequestError):
        _run(model)
    assert model.seen[0]["effort"] == "high" and mg.downgrades(model) == {}


def test_parallel_tool_calls_is_dropped_for_this_request_only():
    rejected = status_error(400, "unknown parameter: parallel_tool_calls")
    model = mg.guard_model(Scripted(scripts=[[rejected], [text("ok", "stop")]]))
    assert _run(model, parallel_tool_calls=False) == "ok"
    assert "parallel_tool_calls" in model.seen[0]["kwargs"]
    assert "parallel_tool_calls" not in model.seen[1]["kwargs"]


def test_keepalive_only_stream_is_cut_and_resent_once(monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(mg.time, "monotonic", lambda: clock["t"])
    monkeypatch.setenv("CIRCLE_LLM_STALL_TIMEOUT", "30")

    def tick():
        clock["t"] += 31

    stalled = [keepalive(), tick, keepalive()]
    model = mg.guard_model(Scripted(scripts=[stalled, [text("ok", "stop")]]))
    assert _run(model) == "ok"
    model = mg.guard_model(Scripted(scripts=[list(stalled), list(stalled)]))
    with pytest.raises(mg.StreamStalled):
        _run(model)


def test_stall_after_content_is_not_resent(monkeypatch):
    clock = {"t": 0.0}
    monkeypatch.setattr(mg.time, "monotonic", lambda: clock["t"])
    monkeypatch.setenv("CIRCLE_LLM_STALL_TIMEOUT", "30")
    model = mg.guard_model(Scripted(scripts=[
        [text("half"), lambda: clock.__setitem__("t", 100.0), keepalive()],
        [text("never", "stop")]]))
    with pytest.raises(mg.StreamStalled):
        _run(model)
    assert len(model.seen) == 1


LOOP = "the same sentence keeps coming back here again and again "


def test_looping_reasoning_is_resent_with_a_reminder():
    looping = [reasoning(LOOP) for _ in range(60)]
    model = mg.guard_model(Scripted(scripts=[looping, [text("done", "stop")]]))
    assert _run(model) == "done"
    reminder = model.seen[1]["messages"][-1]
    assert isinstance(reminder, HumanMessage) and "repeating" in reminder.content


def test_looping_answer_text_is_ended_not_resent():
    model = mg.guard_model(Scripted(scripts=[[text(LOOP) for _ in range(60)],
                                             [text("never", "stop")]]))
    out = _run(model)
    assert out.startswith(LOOP) and len(model.seen) == 1


def test_persistent_looping_gives_up():
    model = mg.guard_model(Scripted(scripts=[[reasoning(LOOP) for _ in range(60)]
                                             for _ in range(4)]))
    with pytest.raises(mg.TextRepetitionLoop):
        _run(model)
    assert len(model.seen) == mg.MAX_REPEAT_RECOVERIES + 1


def test_missing_finish_signal_resends_only_empty_streams():
    model = mg.guard_model(Scripted(scripts=[[keepalive()], [text("ok", "stop")]]))
    assert _run(model) == "ok"
    model = mg.guard_model(Scripted(scripts=[[text("cut sho")], [text("never", "stop")]]))
    assert _run(model) == "cut sho" and len(model.seen) == 1


def test_async_stream_has_the_same_retries(monkeypatch):
    waited: list[float] = []

    async def fake_sleep(seconds):
        waited.append(seconds)

    monkeypatch.setattr(mg, "_asleep", fake_sleep)
    monkeypatch.setattr(mg, "_sleep", lambda s: pytest.fail("the sync path must not run"))
    model = mg.guard_model(AsyncScripted(scripts=[[status_error(429, "slow", headers={
        "retry-after-ms": "1500"})], [text("ok", "stop")]]))

    async def collect():
        return "".join([str(c.content) async for c in model.astream("hi")])

    assert asyncio.run(collect()) == "ok" and waited == [1.5]


def test_models_without_native_async_are_guarded_once(sleeps):
    model = mg.guard_model(Scripted(scripts=[[status_error(429, "slow", headers={
        "retry-after": "2"})], [text("ok", "stop")]]))

    async def collect():
        return "".join([str(c.content) async for c in model.astream("hi")])

    assert asyncio.run(collect()) == "ok" and sleeps == [2.0] and len(model.seen) == 2


def test_guarded_model_keeps_its_settings_and_class():
    inner = Scripted(reasoning_effort="high")
    model = mg.guard_model(inner)
    assert isinstance(model, Scripted) and model.reasoning_effort == "high"
    assert mg.guard_model(model) is model
    assert mg.guard_model("not a model") == "not a model"


def test_retry_after_message_and_http_date():
    assert mg.retry_after_s(RuntimeError("Please try again in 2.5s")) == 2.5
    exc = status_error(429, "x", headers={"retry-after": "Wed, 21 Oct 2099 07:28:00 GMT"})
    assert mg.retry_after_s(exc) > 1000
    assert mg.backoff_s("rate_limit", 0, exc) == mg.BUDGETS["rate_limit"].cap_s


# ── effort per model family ─────────────────────────────────────────────────


def test_effort_levels_are_clamped_to_what_the_family_supports():
    assert _clamp_effort("xhigh", ["low", "medium", "high", "max"]) == "high"
    assert _clamp_effort("max", ["low", "high"]) == "high"
    assert _clamp_effort("minimal", ["low", "high"]) == "low"


def _payload(name: str, effort: str = "xhigh") -> dict:
    from langchain_anthropic import ChatAnthropic

    model = ChatAnthropic(model=name, api_key="x", reasoning_effort=effort)
    apply_reasoning(model, effort, "anthropic")
    return mg.guard_model(model)._get_request_payload([("user", "hi")])


def test_anthropic_effort_follows_the_model_catalog():
    assert _payload("claude-sonnet-4-6")["output_config"] == {"effort": "high"}
    budget = _payload("claude-sonnet-4-5")
    assert budget.get("output_config") is None
    assert budget["thinking"] == {"type": "enabled", "budget_tokens": 16000}
    assert budget["max_tokens"] > 16000
    newer = _payload("claude-opus-5-5")  # 比目录新：自适应思考 + effort，从不关思考
    assert newer["thinking"] == {"type": "adaptive"} and newer["output_config"]["effort"] == "xhigh"
    assert newer["max_tokens"] >= 32000
    other = _payload("mimo-v2.5-pro")
    assert other["output_config"] == {"effort": "xhigh"} and not other.get("thinking")
    # 目录外的非 Claude 模型也不能停在 SDK 的 4096：思考先把额度吃光，回合以空回答结束
    assert other["max_tokens"] >= 32000


def test_thinking_that_uses_up_the_output_budget_is_reported(caplog):
    events: list[dict] = []
    remove = mg.add_retry_listener(events.append)
    try:
        model = mg.guard_model(Scripted(scripts=[[reasoning("step " * 40), text("", "max_tokens")]]))
        with caplog.at_level("WARNING", logger="circle.model_guard"):
            assert _run(model) == ""
    finally:
        remove()
    assert any("before any answer" in r.getMessage() for r in caplog.records)
    assert [e["event"] for e in events] == ["output_budget_exhausted"]


def test_async_stream_reports_a_thinking_only_budget_stop_too(caplog):
    model = mg.guard_model(AsyncScripted(scripts=[[reasoning("step " * 40), text("", "length")]]))

    async def consume() -> list:
        return [c async for c in model.astream("hi")]

    with caplog.at_level("WARNING", logger="circle.model_guard"):
        asyncio.run(consume())
    assert any("before any answer" in r.getMessage() for r in caplog.records)


def test_a_budget_stop_after_an_answer_is_not_flagged(caplog):
    model = mg.guard_model(Scripted(scripts=[[text("partial answer"), text("", "max_tokens")]]))
    with caplog.at_level("WARNING", logger="circle.model_guard"):
        assert _run(model) == "partial answer"
    assert not any("before any answer" in r.getMessage() for r in caplog.records)


def test_openai_effort_only_when_asked(monkeypatch):
    from langchain_openai import ChatOpenAI

    monkeypatch.delenv("CIRCLE_REASONING_EFFORT", raising=False)
    model = apply_reasoning(ChatOpenAI(model="gpt-x", api_key="x"), "xhigh", "openai")
    assert model.reasoning_effort is None
    monkeypatch.setenv("CIRCLE_REASONING_EFFORT", "high")
    model = apply_reasoning(ChatOpenAI(model="gpt-x", api_key="x"), "high", "openai")
    assert model.reasoning_effort == "high"


def test_repetition_monitor_ignores_varied_text():
    monitor = RepetitionMonitor()
    varied = " ".join(f"word{i}" for i in range(2000))
    assert monitor.feed(varied) is None
    looping = RepetitionMonitor()
    assert looping.feed(LOOP * 40) is not None


# ── the real OpenAI client against a local endpoint ─────────────────────────


def test_real_openai_client_retries_and_drops_a_rejected_parameter(monkeypatch):
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from langchain_openai import ChatOpenAI

    bodies: list[dict] = []
    monkeypatch.setattr(mg, "_sleep", lambda s: None)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _json(self, code, payload, headers=()):
            data = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for key, value in headers:
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            bodies.append(body)
            if len(bodies) == 1:
                self._json(429, {"error": {"message": "slow down", "type": "rate_limit"}},
                           [("retry-after", "1")])
                return
            if "reasoning_effort" in body:
                self._json(400, {"error": {"message": "Unsupported parameter: 'reasoning_effort'"
                                           " is not supported with this model.",
                                           "param": "reasoning_effort",
                                           "type": "invalid_request_error"}})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in (({"role": "assistant", "content": "hello"}, None), ({}, "stop")):
                chunk = {"id": "c1", "object": "chat.completion.chunk", "created": 1,
                         "model": "m", "choices": [{"index": 0, "delta": delta,
                                                    "finish_reason": finish}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(b"data: [DONE]\n\n")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        model = mg.guard_model(ChatOpenAI(
            model="m", api_key="test", base_url=f"http://127.0.0.1:{server.server_port}/v1",
            streaming=True, max_retries=0, reasoning_effort="high"))
        assert _run(model) == "hello"
        assert model.invoke("again").content == "hello"
    finally:
        server.shutdown()
    assert [("reasoning_effort" in b) for b in bodies] == [True, True, False, False]
    assert "reasoning_effort" in mg.downgrades(model)


def test_session_shows_waits_and_dropped_parameters(tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage

    from circle.oauth import start_oauth_login
    from circle.testing import ScriptedModel
    from circle.tui.controllers import InitController, TrustController
    from circle.tui.session_app import CircleSessionApp

    monkeypatch.setenv("CIRCLE_OAUTH_MOCK", "1")
    home, ws = tmp_path / "home", tmp_path / "ws"
    ws.mkdir()
    init = InitController(home=home, oauth_login=start_oauth_login)
    init.submit_line("2")
    init.confirm()
    init.confirm()
    TrustController(init.settings, ws, home=home).confirm()
    app = CircleSessionApp(init.settings, ws, home=home,
                           model_override=ScriptedModel(responses=[AIMessage(content="ok")]))
    app._on_model_retry({"event": "retry", "kind": "rate_limit", "attempt": 1, "max": 5,  # noqa: SLF001
                         "wait_s": 7.0})
    app._on_model_retry({"event": "param_dropped", "param": "thinking", "status": 400})  # noqa: SLF001
    snap = "\n".join(app._transcript.snapshot())  # noqa: SLF001
    assert "端点限流，7.0s 后重试（1/5）" in snap and "端点不接受参数 thinking" in snap
