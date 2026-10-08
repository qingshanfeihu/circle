"""Circle extensions: third-party code that adds tools, commands, middleware,
subagents, TUI renderers and event handlers without touching Circle itself.

An extension is a directory with an ``extension.py`` that defines
``register(api)``. Discovery:

- ``<CIRCLE_HOME>/extensions/<name>/extension.py`` (user level, always considered);
- ``<workspace>/.circle/extensions/<name>/extension.py`` only when the workspace is
  trusted (``settings.trusted_folders``) — an untrusted checkout must not run code.

``settings.extensions[<name>] = {"enabled": false}`` switches one off. Each
extension registers into its own staging area; if ``register`` raises, nothing it
registered is kept and the error is shown by ``/extensions``. Other extensions are
not affected.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from langchain_core.tools import StructuredTool, ToolException

from circle.paths import circle_home

logger = logging.getLogger(__name__)

ENTRY = "extension.py"
MIDDLEWARE_SLOTS = ("model_call", "tool_boundary", "after_model")
EVENTS = ("session_start", "turn_start", "turn_end", "tool_result")
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class ToolError(Exception):
    """Raised by an extension tool to report a failed call to the model."""


class ExtensionError(Exception):
    """A registration the host refuses (bad name, clash, unknown slot)."""


@dataclass
class Watch:
    """What a tool returns to have Circle wait for something slow (a run on another machine,
    a sign-in in a browser) instead of the model calling the tool again or sleeping.

    Circle calls ``poll()`` every ``interval_s`` seconds as a background job, off the model's
    turns: None means not yet, any other value is the result (text or JSON) and the model
    gets a notice with it; an exception or ``deadline_s`` fails the job. ``result`` is what
    the tool call returns now. ``on_stop`` runs once if the job is stopped (``stop_job``,
    /jobs, Circle leaving)."""

    title: str
    poll: Callable[[], Any]
    interval_s: float = 10.0
    deadline_s: float = 3600.0
    result: Any = None
    on_stop: Callable[[], None] | None = None


@dataclass
class CommandContext:
    """What an extension command handler may do in the session."""

    workspace: Path
    toast: Callable[[str], None]
    append: Callable[[str], None]
    send_user_message: Callable[[str], None]


@dataclass
class ExtensionTool:
    name: str
    description: str
    parameters: dict[str, Any]
    execute: Callable[[dict[str, Any]], Any]
    read_only: bool
    approval: bool
    source: str = ""


@dataclass
class ExtensionCommand:
    name: str
    description: str
    handler: Callable[[str, CommandContext], None]


@dataclass
class Extension:
    name: str
    source: str  # "user" | "project"
    path: Path
    enabled: bool = True
    error: str = ""
    warnings: list[str] = field(default_factory=list)
    tools: list[ExtensionTool] = field(default_factory=list)
    commands: list[ExtensionCommand] = field(default_factory=list)
    middleware: list[tuple[str, Any]] = field(default_factory=list)
    subagents: list[tuple[dict[str, Any], list[str]]] = field(default_factory=list)
    renderers: dict[str, Callable[[Any], list[str]]] = field(default_factory=dict)
    handlers: dict[str, list[Callable[[dict[str, Any]], None]]] = field(default_factory=dict)

    @property
    def loaded(self) -> bool:
        return self.enabled and not self.error


class ExtensionAPI:
    """The object passed to ``register(api)``; one per extension."""

    ToolError = ToolError
    Watch = Watch

    def __init__(self, ext: Extension, reserved_tools: set[str], reserved_commands: set[str]):
        self._ext = ext
        self._reserved_tools = reserved_tools
        self._reserved_commands = reserved_commands

    @property
    def name(self) -> str:
        return self._ext.name

    def register_tool(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        execute: Callable[[dict[str, Any]], Any],
        *,
        read_only: bool = False,
        approval: bool | None = None,
    ) -> None:
        """Add a tool. ``parameters`` is a JSON Schema object; ``execute(args)`` returns
        a dict (sent as JSON) or a string, or raises ``ToolError`` for a failed call.
        Tools that are not read-only go through Circle's approval prompt unless
        ``approval=False``."""
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name or ""):
            raise ExtensionError(f"invalid tool name {name!r}")
        if name in self._reserved_tools or any(t.name == name for t in self._ext.tools):
            raise ExtensionError(f"tool {name!r} already exists")
        if not isinstance(parameters, dict) or parameters.get("type") != "object":
            raise ExtensionError(f"tool {name!r}: parameters must be a JSON Schema object")
        if not callable(execute):
            raise ExtensionError(f"tool {name!r}: execute must be callable")
        self._ext.tools.append(ExtensionTool(
            name=name, description=str(description or name), parameters=parameters,
            execute=execute, read_only=bool(read_only),
            approval=(not read_only) if approval is None else bool(approval),
            source=self._ext.name))

    def register_command(self, name: str, description: str,
                         handler: Callable[[str, CommandContext], None]) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", name or ""):
            raise ExtensionError(f"invalid command name {name!r}")
        if name in self._reserved_commands or any(c.name == name for c in self._ext.commands):
            raise ExtensionError(f"command /{name} already exists")
        self._ext.commands.append(ExtensionCommand(name, str(description or ""), handler))

    def register_middleware(self, middleware: Any, slot: str = "tool_boundary") -> None:
        if slot not in MIDDLEWARE_SLOTS:
            raise ExtensionError(f"unknown middleware slot {slot!r}; use one of {MIDDLEWARE_SLOTS}")
        self._ext.middleware.append((slot, middleware))

    def register_subagent(self, spec: dict[str, Any], tools: list[str] | None = None) -> None:
        """Add a subagent. ``tools`` names the tools it may use; omit it to give none
        of the extension-visible tools beyond what the harness always provides."""
        if not isinstance(spec, dict) or not all(spec.get(k) for k in ("name", "description",
                                                                      "system_prompt")):
            raise ExtensionError("subagent spec needs name, description and system_prompt")
        self._ext.subagents.append((dict(spec), list(tools or [])))

    def register_renderer(self, event_kind: str, renderer: Callable[[Any], list[str]]) -> None:
        """``tool_result:<tool name>`` → ``renderer(update)`` returns transcript lines."""
        if not event_kind.startswith("tool_result:") or not event_kind.split(":", 1)[1]:
            raise ExtensionError("renderer kind must be tool_result:<tool name>")
        self._ext.renderers[event_kind] = renderer

    def on(self, event: str, handler: Callable[[dict[str, Any]], None]) -> None:
        if event not in EVENTS:
            raise ExtensionError(f"unknown event {event!r}; use one of {EVENTS}")
        self._ext.handlers.setdefault(event, []).append(handler)


def _watched(tool: ExtensionTool, watch: Watch, jobs: Any) -> str:
    """Hand a Watch to the session's jobs; without them, wait for it in this call."""
    now = _as_text(watch.result) if watch.result is not None else ""
    if jobs is None:
        import time

        began = time.monotonic()
        while time.monotonic() - began < watch.deadline_s:
            time.sleep(watch.interval_s)
            value = watch.poll()
            if value is not None:
                return "\n\n".join(part for part in (now, _as_text(value)) if part)
        raise ToolException(f"{tool.name}: no result after {watch.deadline_s:g}s")
    from circle.jobs import job_owner

    try:
        job = jobs.start_watch(watch.title, watch.poll, interval=watch.interval_s,
                               deadline=watch.deadline_s, on_stop=watch.on_stop,
                               owner=job_owner(), source=tool.source)
    except RuntimeError as exc:
        raise ToolException(f"{exc}; stop one with stop_job first") from None
    note = (f"[Circle watches this as background job {job.id} and adds a notice with the "
            f"result when it completes. Do not call {tool.name} again or sleep to wait for "
            "it; end your turn if you have nothing else to do.]")
    return f"{now}\n\n{note}" if now else note


def _as_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, indent=1, default=str)


def _make_langchain_tool(tool: ExtensionTool, host: ExtensionHost | None = None) -> StructuredTool:
    def _run(**kwargs: Any) -> str:
        try:
            value = tool.execute(dict(kwargs))
        except ToolError as exc:
            raise ToolException(str(exc)) from None
        if isinstance(value, Watch):
            return _watched(tool, value, getattr(host, "jobs", None))
        return _as_text(value)

    return StructuredTool.from_function(
        func=_run, name=tool.name, description=tool.description,
        args_schema=tool.parameters, handle_tool_error=True)


class ExtensionHost:
    """Discovers, loads and aggregates extensions for one Circle session."""

    def __init__(self, *, home: Path | None, workspace: Path, trusted: bool,
                 settings: dict[str, Any] | None = None,
                 reserved_tools: set[str] | None = None,
                 reserved_commands: set[str] | None = None):
        self.home = Path(home) if home else circle_home()
        self.workspace = Path(workspace)
        self.trusted = trusted
        self.settings = dict(settings or {})
        self.reserved_tools = set(reserved_tools or ())
        self.reserved_commands = set(reserved_commands or ())
        self.extensions: list[Extension] = []
        # The session's background jobs, for tools that return a Watch
        self.jobs: Any = None

    # ── discovery / loading ───────────────────────────────────────
    def discover(self) -> list[tuple[str, str, Path]]:
        roots = [("user", self.home / "extensions")]
        if self.trusted:
            roots.append(("project", self.workspace / ".circle" / "extensions"))
        found: dict[str, tuple[str, str, Path]] = {}
        for source, root in roots:
            if not root.is_dir():
                continue
            for entry in sorted(root.iterdir()):
                if entry.is_dir() and (entry / ENTRY).is_file() and _NAME_RE.match(entry.name):
                    # 项目级与用户级同名时项目级覆盖（与 skills、commands 的覆盖顺序一致）
                    found[entry.name] = (entry.name, source, entry / ENTRY)
        return list(found.values())

    def enabled(self, name: str) -> bool:
        cfg = self.settings.get(name)
        return not (isinstance(cfg, dict) and cfg.get("enabled") is False)

    def load(self) -> "ExtensionHost":
        self.extensions = []
        taken_tools = set(self.reserved_tools)
        taken_commands = set(self.reserved_commands)
        for name, source, path in self.discover():
            ext = Extension(name=name, source=source, path=path, enabled=self.enabled(name))
            self.extensions.append(ext)
            if not ext.enabled:
                continue
            api = ExtensionAPI(ext, taken_tools, taken_commands)
            try:
                module = self._import(name, path)
                register = getattr(module, "register", None)
                if not callable(register):
                    raise ExtensionError("extension.py defines no register(api)")
                register(api)
            except Exception as exc:  # noqa: BLE001 — 扩展互相隔离，错误只记在这个扩展上
                logger.warning("extension %s failed to load: %s", name, exc)
                ext.error = f"{type(exc).__name__}: {exc}"
                ext.tools, ext.commands, ext.middleware = [], [], []
                ext.subagents, ext.renderers, ext.handlers = [], {}, {}
                continue
            taken_tools.update(t.name for t in ext.tools)
            taken_commands.update(c.name for c in ext.commands)
        return self

    @staticmethod
    def _import(name: str, path: Path) -> Any:
        module_name = f"circle_extension_{re.sub(r'[^A-Za-z0-9_]', '_', name)}"
        spec = importlib.util.spec_from_file_location(module_name, path)
        if spec is None or spec.loader is None:
            raise ExtensionError(f"cannot load {path}")
        module = importlib.util.module_from_spec(spec)
        sys.modules.pop(module_name, None)
        spec.loader.exec_module(module)
        return module

    # ── aggregation for the harness ───────────────────────────────
    def _loaded(self) -> list[Extension]:
        return [e for e in self.extensions if e.loaded]

    def tool_specs(self) -> list[ExtensionTool]:
        return [t for e in self._loaded() for t in e.tools]

    def bind_jobs(self, jobs: Any) -> None:
        self.jobs = jobs

    def tools(self) -> list[StructuredTool]:
        return [_make_langchain_tool(t, self) for t in self.tool_specs()]

    def interrupt_on(self) -> dict[str, bool]:
        return {t.name: True for t in self.tool_specs() if t.approval}

    def middleware(self) -> list[Any]:
        items = [(MIDDLEWARE_SLOTS.index(slot), mw) for e in self._loaded() for slot, mw in e.middleware]
        return [mw for _, mw in sorted(items, key=lambda pair: pair[0])]

    def subagents(self, available_tools: list[Any]) -> list[dict[str, Any]]:
        by_name = {getattr(t, "name", None): t for t in available_tools}
        out: list[dict[str, Any]] = []
        for ext in self._loaded():
            for spec, names in ext.subagents:
                missing = [n for n in names if n not in by_name]
                if missing:
                    # 只跳过这一个子代理；扩展的其他注册照常生效
                    note = f"subagent {spec.get('name')} names tools that do not exist {missing}; skipped"
                    logger.warning("extension %s: %s", ext.name, note)
                    if note not in ext.warnings:
                        ext.warnings.append(note)
                    continue
                out.append({**spec, "tools": [by_name[n] for n in names]})
        return out

    def catalog(self) -> list[tuple[str, str]]:
        """(name, first sentence) for the system prompt's tool list."""
        rows = []
        for tool in self.tool_specs():
            first = tool.description.split(". ", 1)[0].strip().rstrip(".")
            rows.append((tool.name, first))
        return rows

    # ── session-side hooks ────────────────────────────────────────
    def commands(self) -> dict[str, ExtensionCommand]:
        return {c.name: c for e in self._loaded() for c in e.commands}

    def renderer(self, tool_name: str) -> Callable[[Any], list[str]] | None:
        for ext in self._loaded():
            fn = ext.renderers.get(f"tool_result:{tool_name}")
            if fn is not None:
                return fn
        return None

    def emit(self, event: str, payload: dict[str, Any]) -> None:
        for ext in self._loaded():
            for handler in ext.handlers.get(event, []):
                try:
                    handler(dict(payload))
                except Exception as exc:  # noqa: BLE001 — 事件处理出错只记日志，不打断会话
                    logger.warning("extension %s %s handler failed: %s", ext.name, event, exc)

    def describe(self) -> list[str]:
        if not self.extensions:
            where = [str(self.home / "extensions")]
            if self.trusted:
                where.append(str(self.workspace / ".circle" / "extensions"))
            return ["No extensions. Put each in its own folder with an extension.py, in "
                    + " or ".join(where)]
        lines = []
        for ext in self.extensions:
            if not ext.enabled:
                state = "off"
            elif ext.error:
                state = f"failed to load: {ext.error}"
            else:
                tools, commands = len(ext.tools), len(ext.commands)
                state = (f"{tools} tool{'' if tools == 1 else 's'} · "
                         f"{commands} command{'' if commands == 1 else 's'}")
            lines.append(f"{ext.name} ({'project' if ext.source == 'project' else 'user'}) · {state}")
            lines.extend(f"  ⚠ {note}" for note in ext.warnings)
        return lines
