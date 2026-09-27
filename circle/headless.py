"""Print and native JSON event modes share the durable Circle runtime."""
from __future__ import annotations

import json
import signal
import sys
import threading
import uuid

from langchain_core.load import dumpd
from langchain_core.messages import HumanMessage

from circle.input_files import prepare_content
from circle.run_control import RunSignals, current_run
from circle.runtime import create_session_runtime
from circle.tui.content_blocks import message_text


def run_headless(settings, workspace, *, home, prompt, mode="text", session_id=None,
                 plan_mode=False, model_override=None, files=()):
    runtime = create_session_runtime(settings, workspace, home=home, model_override=model_override,
                                     plan_mode=plan_mode)
    sid = session_id or "circle-" + uuid.uuid4().hex[:12]
    config = {"configurable": {"thread_id": sid}}
    signals = RunSignals()
    token = current_run.set(signals)
    previous = None
    if threading.current_thread() is threading.main_thread():
        previous = signal.getsignal(signal.SIGINT)
        def cancel(signum, frame):
            signals.cancelled.set()
            raise KeyboardInterrupt
        signal.signal(signal.SIGINT, cancel)
    try:
        content = prepare_content(prompt, workspace, files=files, credential_files=settings.credential_files)
        if mode == "json":
            for event in runtime.wire_events({"messages": [HumanMessage(content=content)]}, config):
                print(json.dumps(dumpd(event), ensure_ascii=False), flush=True)
            state = runtime.get_state(config)
        else:
            result = runtime.invoke({"messages": [HumanMessage(content=content)]}, config)
            state = runtime.get_state(config)
            if not state.interrupts and result.get("messages"):
                print(message_text(result["messages"][-1].content))
        if state.interrupts:
            print(json.dumps({"status": "awaiting_user", "session_id": sid,
                              "interrupts": [dumpd(i.value) for i in state.interrupts]}, ensure_ascii=False), file=sys.stderr)
            return 3
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 -- process exit contract
        from circle.middleware.redact import redact
        print(redact(str(exc)), file=sys.stderr)
        return 1
    finally:
        if previous is not None:
            signal.signal(signal.SIGINT, previous)
        current_run.reset(token)
        runtime.close()
