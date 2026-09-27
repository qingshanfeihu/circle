"""ACP transport reuses the official Deep Agents adapter and Circle factory."""
from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path


async def serve_acp(settings, *, home: Path):
    from acp import run_agent
    from acp.schema import SessionMode, SessionModeState
    from deepagents_acp.server import AgentServerACP
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    from circle.run_control import RunSignals, current_run
    from circle.runtime import create_session_runtime

    home.mkdir(parents=True, exist_ok=True)
    runtimes = []
    signals = {}
    tasks = {}
    async with AsyncSqliteSaver.from_conn_string(str(home / "checkpoints.sqlite")) as saver:
        await saver.setup()

        def factory(context):
            selected = replace(settings, auth=replace(settings.auth))
            if context.model:
                if context.model in selected.connections:
                    from circle.model_registry import ModelRegistry
                    ModelRegistry(selected, home).select_connection(context.model)
                else:
                    selected.auth.model = context.model
            runtime = create_session_runtime(selected, Path(context.cwd), home=home, checkpointer=saver,
                                              plan_mode=context.mode == "plan")
            runtimes.append(runtime)
            return runtime

        class CircleACP(AgentServerACP):
            async def prompt(self, prompt, session_id, **kwargs):
                signal = RunSignals()
                signals[session_id] = signal
                tasks[session_id] = asyncio.current_task()
                token = current_run.set(signal)
                try:
                    return await super().prompt(prompt=prompt, session_id=session_id, **kwargs)
                except asyncio.CancelledError:
                    from acp.schema import PromptResponse
                    return PromptResponse(stop_reason="cancelled")
                finally:
                    current_run.reset(token)
                    tasks.pop(session_id, None)
                    signals.pop(session_id, None)

            async def cancel(self, session_id, **kwargs):
                if session_id in signals:
                    signals[session_id].cancelled.set()
                if session_id in tasks:
                    tasks[session_id].cancel()
                await super().cancel(session_id=session_id, **kwargs)

        try:
            modes = SessionModeState(current_mode_id="default", available_modes=[
                SessionMode(id="default", name="执行", description="工具按审批策略执行"),
                SessionMode(id="plan", name="计划", description="只读探索，仅允许工作区计划文件")])
            models = [{"value": name, "name": name} for name in settings.connections] or None
            await run_agent(CircleACP(factory, load_sessions=True, modes=modes, models=models))
        finally:
            for runtime in runtimes:
                runtime.sessions.close()
