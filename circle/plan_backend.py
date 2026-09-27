"""Plan-mode hard gate on sandbox mutating operations."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from deepagents.backends.protocol import ExecuteResponse

from circle.run_control import check_cancelled
from circle.sandbox import CircleSandboxBackend


def _is_plan_file(path: str | Path) -> bool:
    name = Path(str(path)).name.lower()
    return name in {"plan.md", "plan"}


class PlanGuardedBackend(CircleSandboxBackend):
    """Reject mutating ops in plan mode except writes to plan.md."""

    def __init__(self, *args: Any, plan_mode: bool = False, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.plan_mode = plan_mode
        # command -> refusal text ("" = allowed); set by the harness from circle.approvals
        self.command_guard: Callable[[str], str] | None = None

    def set_plan_mode(self, enabled: bool) -> None:
        self.plan_mode = enabled

    def is_plan_file(self, path: str | Path) -> bool:
        try:
            return self._resolve_path(str(path)) == (self.cwd / "plan.md").resolve()
        except (ValueError, OSError):
            return False

    def write(self, file_path: str, content: str) -> Any:
        check_cancelled()
        if self.plan_mode and not self.is_plan_file(file_path):
            from deepagents.backends.protocol import WriteResult

            return WriteResult(
                error=(
                    "Plan mode is active: only /plan.md may be written. "
                    "Use /plan off to leave plan mode."
                )
            )
        return super().write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> Any:
        check_cancelled()
        if self.plan_mode and not self.is_plan_file(file_path):
            from deepagents.backends.protocol import EditResult

            return EditResult(
                error=(
                    "Plan mode is active: edits blocked except /plan.md. "
                    "Use /plan off to leave plan mode."
                )
            )
        return super().edit(file_path, old_string, new_string, replace_all=replace_all)

    def delete(self, file_path: str) -> Any:
        check_cancelled()
        if self.plan_mode:
            from deepagents.backends.protocol import DeleteResult

            return DeleteResult(
                error=(
                    "Plan mode is active: deletes blocked except /plan.md. "
                    "Use /plan off to leave plan mode."
                )
            )
        return super().delete(file_path)

    def execute(self, command: str, *, timeout: int | None = None) -> ExecuteResponse:
        if self.plan_mode:
            return ExecuteResponse(
                output=(
                    "Plan mode is active: shell execute is blocked. "
                    "Use read-only tools or /plan off."
                ),
                exit_code=1,
            )
        refusal = self.command_guard(command) if self.command_guard else ""
        if refusal:
            return ExecuteResponse(output=refusal, exit_code=126)
        check_cancelled()
        duration = timeout if timeout is not None else self._default_timeout
        if duration <= 0:
            raise ValueError("timeout must be positive")
        process = subprocess.Popen(command, shell=True, cwd=self.cwd, env=self._env,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, start_new_session=os.name != "nt")
        deadline = time.monotonic() + duration
        try:
            while True:
                check_cancelled()
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, duration)
                try:
                    output, _ = process.communicate(timeout=min(0.1, deadline - time.monotonic()))
                    limit = self._max_output_bytes
                    return ExecuteResponse(output=output[:limit] or "<no output>",
                                           exit_code=process.returncode, truncated=len(output) > limit)
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if process.poll() is None:
                if os.name == "nt":
                    import psutil
                    try:
                        parent = psutil.Process(process.pid)
                        descendants = parent.children(recursive=True)
                        # Stop the shell from launching more work before killing
                        # its captured children. Avoid another shell/taskkill
                        # process on the cancellation path.
                        for child in [parent, *reversed(descendants)]:
                            try:
                                child.kill()
                            except psutil.NoSuchProcess:
                                continue
                        _, alive = psutil.wait_procs([parent, *descendants], timeout=2)
                        if alive:
                            raise RuntimeError("Cancelled shell processes did not terminate")
                    except psutil.NoSuchProcess:
                        pass
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.communicate()
