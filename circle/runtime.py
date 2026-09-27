"""One harness factory for TUI, CLI, ACP and the Python SDK."""
from pathlib import Path

from circle.checkpoint_store import make_checkpointer
from circle.extensions import ExtensionHost
from circle.harness import BUILTIN_TOOL_NAMES, create_harness
from circle.model import build_chat_model
from circle.session_service import SessionService
from circle.settings import is_folder_trusted
from circle.tui.slash_commands import known_slash_names


def create_session_runtime(settings, workspace: Path, *, home: Path, model_override=None,
                           checkpointer=None, plan_mode=False):
    host = ExtensionHost(home=home, workspace=workspace, trusted=is_folder_trusted(settings, workspace),
                         settings=settings.extensions, reserved_tools=set(BUILTIN_TOOL_NAMES),
                         reserved_commands=known_slash_names()).load()
    if settings.auth.provider in host.providers() and model_override is None:
        model_override = host.providers()[settings.auth.provider](settings.auth)
    graph = create_harness(build_chat_model(settings, home=home, model_override=model_override),
                           root_dir=workspace, home=home, model_id=settings.auth.model,
                           protocol=settings.auth.protocol, extensions=host,
                           mcp_servers=settings.mcp_servers, plan_mode=plan_mode,
                           checkpointer=checkpointer if checkpointer is not None else make_checkpointer(home))
    facade = SessionService(home, workspace).bind(graph)
    facade.config_defaults = {"extension_flags": dict(settings.extension_flags)}
    return facade
