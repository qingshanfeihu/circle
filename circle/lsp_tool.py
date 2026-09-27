"""Language-server tools backed by Microsoft's multilspy client."""
from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
from pathlib import Path

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.run_control import check_cancelled
from circle.system_prompt import load_tool_prompt

LANGUAGES = {".py": "python", ".pyi": "python", ".ts": "typescript", ".tsx": "typescript",
             ".js": "javascript", ".jsx": "javascript", ".go": "go", ".rs": "rust"}


class _LspInput(BaseModel):
    operation: str = Field(description="goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation")
    filePath: str
    line: int = 1
    character: int = 1
    query: str = ""


async def _query(workspace, path, operation, line, character, query):
    from multilspy import LanguageServer
    from multilspy.multilspy_config import MultilspyConfig
    from multilspy.multilspy_logger import MultilspyLogger

    language = LANGUAGES.get(path.suffix.lower())
    if not language:
        raise ValueError(f"No configured language server for {path.suffix}")
    relative = str(path.relative_to(workspace))
    server = LanguageServer.create(MultilspyConfig.from_dict({"code_language": language}),
                                    MultilspyLogger(), str(workspace))
    if language == "python":
        server.server.process_launch_info.cmd = shlex.quote(sys.executable) + " -c " + shlex.quote("from jedi_language_server.cli import cli; cli()")
    server.server.process_launch_info.env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")
    async with asyncio.timeout(15):
        async with server.start_server():
            row, col = max(0, line - 1), max(0, character - 1)
            methods = {"goToDefinition": (server.request_definition, (relative, row, col)),
                       "findReferences": (server.request_references, (relative, row, col)),
                       "hover": (server.request_hover, (relative, row, col)),
                       "documentSymbol": (server.request_document_symbols, (relative,)),
                       "workspaceSymbol": (server.request_workspace_symbol, (query,))}
            if operation == "goToImplementation":
                return await server.server.send.implementation(
                    {"textDocument": {"uri": path.as_uri()}, "position": {"line": row, "character": col}})
            if operation not in methods:
                raise ValueError(f"Unsupported operation {operation}")
            fn, args = methods[operation]
            return await fn(*args)


async def _controlled_query(*args):
    task = asyncio.create_task(_query(*args))
    try:
        while not task.done():
            check_cancelled()
            await asyncio.sleep(0.05)
        return await task
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


def run_lsp(workspace: Path, *, operation: str, file_path: str, line: int = 1,
            character: int = 1, query: str = "") -> str:
    workspace = workspace.resolve()
    path = Path(file_path).expanduser()
    path = (workspace / path).resolve() if not path.is_absolute() else path.resolve()
    if not path.is_relative_to(workspace):
        return "Error: LSP file must belong to this workspace"
    if not path.is_file():
        return f"Error: file not found: {path}"
    try:
        result = asyncio.run(_controlled_query(workspace, path, operation, line, character, query))
        return json.dumps(result, ensure_ascii=False, indent=2)
    except ImportError:
        return "Error: install Circle's lsp extra (multilspy)"
    except (TimeoutError, ValueError) as exc:
        return f"Error: LSP {type(exc).__name__}: {exc}"


def build_lsp_tool(workspace: Path | None) -> StructuredTool:
    root = Path(workspace).resolve() if workspace else Path.cwd()

    def query(operation: str, filePath: str, line: int = 1, character: int = 1, query: str = "") -> str:
        return run_lsp(root, operation=operation, file_path=filePath, line=line, character=character, query=query)

    return StructuredTool.from_function(name="lsp", func=query, args_schema=_LspInput,
                                        description=load_tool_prompt("lsp") or "Query a language server")
