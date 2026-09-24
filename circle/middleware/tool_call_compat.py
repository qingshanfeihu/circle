"""Repair common tool-call shape mistakes before the tool runs.

Models, especially through OpenAI-compatible gateways, often get the shape of a call
slightly wrong. What is repaired (only when the result is unambiguous):

- tool name case or separators (``Read_File`` → ``read_file``), only onto a tool that
  exists and never onto a tool that needs approval: approval is decided on the name
  the model sent, so a repaired name there would skip it;
- arguments sent as a JSON string, including broken ``\\u`` escapes;
- a list or object field sent as a JSON string;
- argument key spelling (``filePath`` → ``file_path``) when it maps to exactly one key;
- a one-element list for a string field, ``null`` for an optional list/object field.

When the arguments still do not match the schema, the tool is not run and the model is
told which fields are wrong (paths and received types, never values).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, replace
from typing import Any, Awaitable, Callable, Iterable

from langchain.agents.middleware.types import AgentMiddleware
from langchain_core.messages import ToolMessage
from pydantic import ValidationError

from circle.middleware.tool_error_boundary import validation_detail
from circle.tool_events import announce_blocked_tool_call
from circle.tool_recoverable import mark_recoverable

logger = logging.getLogger(__name__)


def canonical(name: str) -> str:
    match = re.fullmatch(r"mcp__(.+?)__(.+)", str(name or ""))
    value = match.group(1) + "_" + match.group(2) if match else str(name or "")
    return re.sub(r"[-_\s]+", "", value).lower()


def resolve_name(name: str, candidates: Iterable[str]) -> str | None:
    candidates = tuple(candidates)
    if name in candidates:
        return name
    lowered = name.lower()
    case = [c for c in candidates if c.lower() == lowered]
    if len(case) == 1:
        return case[0]
    key = canonical(name)
    loose = [c for c in candidates if canonical(c) == key]
    return loose[0] if len(loose) == 1 else None


def _properties(schema: dict) -> dict:
    props = schema.get("properties")
    return props if isinstance(props, dict) else {}


def _branches(schema: dict) -> list[dict]:
    out: list[dict] = []
    for key in ("allOf", "anyOf", "oneOf"):
        branch = schema.get(key)
        if isinstance(branch, list):
            out.extend(entry for entry in branch if isinstance(entry, dict))
    return out


def _types(schema: dict) -> set[str]:
    declared = schema.get("type")
    out = {declared} if isinstance(declared, str) else set()
    if isinstance(declared, list):
        out.update(t for t in declared if isinstance(t, str))
    for branch in _branches(schema):
        out |= _types(branch)
    return out


def repair_unicode_escapes(text: str) -> str:
    """``\\u 00e9`` / ``\\u00 e9`` (whitespace inside the escape) → ``\\u00e9``."""
    if "\\u" not in text:
        return text
    out: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch != "\\":
            out.append(ch)
            i += 1
            continue
        if nxt == "\\":
            out.append("\\\\")
            i += 2
            continue
        if nxt != "u":
            out.append(ch)
            i += 1
            continue
        cursor, digits = i + 2, []
        while cursor < len(text) and len(digits) < 4:
            cur = text[cursor]
            if re.fullmatch(r"[0-9a-fA-F]", cur):
                digits.append(cur)
            elif not cur.isspace():
                break
            cursor += 1
        if len(digits) == 4:
            out.append("\\u" + "".join(digits))
            i = cursor
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def parse_tool_input(text: str) -> Any:
    if text.strip() == "":
        return {}
    for candidate in (text, repair_unicode_escapes(text)):
        try:
            return json.loads(candidate)
        except (TypeError, ValueError):
            continue
    return text


def _normalize_value(value: Any, schema: dict | None) -> Any:
    if not schema:
        return value
    if isinstance(value, str):
        declared = _types(schema)
        wanted = list if "array" in declared else dict if "object" in declared else None
        if wanted is None or "string" in declared:
            return value
        try:
            parsed = json.loads(repair_unicode_escapes(value))
        except (TypeError, ValueError):
            return value
        return _normalize_value(parsed, schema) if isinstance(parsed, wanted) else value
    if isinstance(value, list):
        items = schema.get("items")
        return [_normalize_value(v, items) for v in value] if isinstance(items, dict) else value
    if isinstance(value, dict):
        return normalize_input(value, schema)
    return value


def normalize_input(value: Any, schema: dict) -> Any:
    """Canonicalize argument keys against the schema and decode JSON-in-a-string fields."""
    if not isinstance(value, dict):
        return value
    props = _properties(schema)
    branches = _branches(schema)
    if not props and not branches:
        return value
    by_canonical: dict[str, list[str]] = {}
    for key in props:
        by_canonical.setdefault(canonical(key), []).append(key)
    out: dict[str, Any] = {}
    for key, item in value.items():
        if key in props:
            out[key] = _normalize_value(item, props[key] if isinstance(props[key], dict) else None)
    for key, item in value.items():
        if key in props:
            continue
        matches = by_canonical.get(canonical(key), [])
        if len(matches) == 1 and matches[0] not in out:
            target = matches[0]
            out[target] = _normalize_value(item, props[target] if isinstance(props[target], dict)
                                           else None)
        elif key not in out:
            out[key] = item  # unknown key: leave it for the schema check to report
    for branch in branches:
        nested = normalize_input(out, branch)
        if isinstance(nested, dict):
            out = nested
    return out


def downgrade_shapes(value: Any, schema: dict) -> tuple[Any, tuple[str, ...]]:
    if not isinstance(value, dict):
        return value, ()
    props = _properties(schema)
    codes: list[str] = []
    replaced: dict[str, Any] = {}
    dropped: set[str] = set()
    for key, item in value.items():
        field = props.get(key)
        if not isinstance(field, dict):
            continue
        declared = _types(field)
        if item is None:
            if "default" in field and declared & {"array", "object"} and "null" not in declared:
                dropped.add(key)
                codes.append("null_to_default")
            continue
        if isinstance(item, list) and "string" in declared and "array" not in declared:
            if len(item) == 1 and isinstance(item[0], str):
                replaced[key] = item[0]
                codes.append("list_to_str")
    if not replaced and not dropped:
        return value, ()
    return ({k: replaced.get(k, v) for k, v in value.items() if k not in dropped},
            tuple(dict.fromkeys(codes)))


def tool_schema(tool: Any) -> dict:
    model = getattr(tool, "tool_call_schema", None)
    if isinstance(model, dict):
        return model
    if hasattr(model, "model_json_schema"):
        try:
            schema = model.model_json_schema()
        except Exception:  # noqa: BLE001 — schema with unserializable defaults
            schema = None
        if isinstance(schema, dict):
            return schema
    args = getattr(tool, "args", None)
    return {"type": "object", "properties": dict(args)} if isinstance(args, dict) else {}


@dataclass(frozen=True)
class Repair:
    tool_name: str
    args: Any
    codes: tuple[str, ...]


def repair_tool_call(name: str, args: Any, tools_by_name: dict[str, Any]) -> Repair | None:
    """None when the call needs no repair or names an unknown tool."""
    resolved = resolve_name(name, tools_by_name)
    if not resolved:
        return None
    schema = tool_schema(tools_by_name[resolved])
    codes: list[str] = ["tool_name"] if resolved != name else []
    parsed = args
    if isinstance(args, str):
        parsed = parse_tool_input(args)
        if not isinstance(parsed, str):
            codes.append("json_string_args")
    normalized = normalize_input(parsed, schema)
    if normalized != parsed:
        codes.append("argument_keys_or_json_fields")
    normalized, more = downgrade_shapes(normalized, schema)
    codes.extend(more)
    if not codes:
        return None
    return Repair(resolved, normalized, tuple(dict.fromkeys(codes)))


def _schema_error(tool: Any, args: Any) -> ValidationError | None:
    validate = getattr(getattr(tool, "tool_call_schema", None), "model_validate", None)
    if validate is None or not isinstance(args, dict):
        return None
    try:
        validate(args)
    except ValidationError as exc:
        return exc
    except Exception:  # noqa: BLE001 — not an argument-shape problem; the tool reports it
        return None
    return None


class ToolCallCompatibilityMiddleware(AgentMiddleware):
    """``tools`` may be given now or bound later (``bind``) once the agent's final tool
    table is known; ``gated`` names tools that need approval (no name repair onto them)."""

    def __init__(self, tools: Iterable[Any] = (), *, gated: Iterable[str] = ()) -> None:
        self.tools_by_name: dict[str, Any] = {}
        self.gated = set(gated)
        self.bind(tools)

    def bind(self, tools: Iterable[Any]) -> None:
        for tool in tools:
            name = str(getattr(tool, "name", "") or "")
            if name:
                self.tools_by_name[name] = tool

    def _reject(self, request: Any, name: str, text: str) -> ToolMessage:
        """The model can fix these itself; the tool never ran, so announce the row."""
        call = request.tool_call
        announce_blocked_tool_call({**call, "name": name}, text, recoverable=True)
        return mark_recoverable(ToolMessage(
            content=text, name=name, status="error",
            tool_call_id=str(call.get("id") or f"invalid-{canonical(name)}")))

    def _prepare(self, request: Any) -> tuple[Any, ToolMessage | None]:
        call = request.tool_call
        name = str(call.get("name") or "")
        tools = dict(self.tools_by_name)
        if request.tool is not None:
            tools.setdefault(name, request.tool)
        repair = repair_tool_call(name, call.get("args"), tools)
        prepared = request
        if repair is not None:
            if repair.tool_name != name and repair.tool_name in self.gated:
                return request, self._reject(
                    request, name,
                    f"Tool {name!r} does not exist. Did you mean {repair.tool_name!r}? "
                    "Re-issue the call with the exact tool name; nothing was run.")
            logger.info("tool_call_compat: %s → %s (%s)", name, repair.tool_name,
                        ",".join(repair.codes))
            prepared = replace(request, tool=tools[repair.tool_name],
                               tool_call={**call, "name": repair.tool_name, "args": repair.args})
        tool = prepared.tool
        args = prepared.tool_call.get("args")
        if tool is not None and not isinstance(args, dict):
            final = prepared.tool_call["name"]
            keys = ", ".join(_properties(tool_schema(tool))) or "(none)"
            return request, self._reject(
                request, final,
                f"Tool call {final!r} was not run: arguments must be a JSON object with "
                f"key(s): {keys}. Re-issue one corrected call.")
        error = _schema_error(tool, args) if tool is not None else None
        if error is not None:
            final = prepared.tool_call["name"]
            return request, self._reject(
                request, final,
                f"Tool call {final!r} was not run: invalid arguments — "
                f"{validation_detail(error) or 'arguments do not match the schema'}. "
                "Re-issue the call with arguments that satisfy the declared schema.")
        return prepared, None

    @staticmethod
    def _unknown_tool_answer(prepared: Any, result: Any) -> Any:
        """ToolNode answers an unknown tool name without running anything: give it a row."""
        if getattr(prepared, "tool", None) is None and isinstance(result, ToolMessage):
            call = prepared.tool_call
            announce_blocked_tool_call(call, str(result.content), recoverable=True)
            mark_recoverable(result)
        return result

    def wrap_tool_call(self, request: Any, handler: Callable[[Any], Any]) -> Any:
        prepared, rejected = self._prepare(request)
        if rejected is not None:
            return rejected
        return self._unknown_tool_answer(prepared, handler(prepared))

    async def awrap_tool_call(self, request: Any,
                              handler: Callable[[Any], Awaitable[Any]]) -> Any:
        prepared, rejected = self._prepare(request)
        if rejected is not None:
            return rejected
        return self._unknown_tool_answer(prepared, await handler(prepared))
