"""Plan-mode hard gate on sandbox mutating operations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents.backends.protocol import ExecuteResponse

from circle.sandbox import CircleSandboxBackend


def _is_plan_file(path: str | Path) -> bool:
    name = Path(str(path)).name.lower()
    return name in {"plan.md", "plan"}


class PlanGuardedBackend(CircleSandboxBackend):
    """Reject mutating ops in plan mode except writes to plan.md."""

    def __init__(self, *args: Any, plan_mode: bool = False, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.plan_mode = plan_mode

    def set_plan_mode(self, enabled: bool) -> None:
        self.plan_mode = enabled

    def write(self, file_path: str, content: str) -> Any:  # noqa: ANN401
        if self.plan_mode and not _is_plan_file(file_path):
            from deepagents.backends.protocol import WriteResult

            return WriteResult(
                error=(
                    "Plan mode is active: only /plan.md may be written. "
                    "Use /plan off to leave plan mode."
                )
            )
        return super().write(file_path, content)

    def edit(self, file_path: str, old_string: str, new_string: str, replace_all: bool = False) -> Any:  # noqa: ANN401
        if self.plan_mode and not _is_plan_file(file_path):
            from deepagents.backends.protocol import EditResult

            return EditResult(
                error=(
                    "Plan mode is active: edits blocked except /plan.md. "
                    "Use /plan off to leave plan mode."
                )
            )
        return super().edit(file_path, old_string, new_string, replace_all=replace_all)

    def delete(self, file_path: str) -> Any:  # noqa: ANN401
        if self.plan_mode and not _is_plan_file(file_path):
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
        return super().execute(command, timeout=timeout)
