"""Minimal LSP tool — JSON-RPC over stdio language servers."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from circle.system_prompt import load_tool_prompt

# ext → (command, args)
_DEFAULT_SERVERS: dict[str, tuple[str, list[str]]] = {
    ".py": ("pylsp", []),
    ".pyi": ("pylsp", []),
    ".ts": ("typescript-language-server", ["--stdio"]),
    ".tsx": ("typescript-language-server", ["--stdio"]),
    ".js": ("typescript-language-server", ["--stdio"]),
    ".jsx": ("typescript-language-server", ["--stdio"]),
    ".go": ("gopls", []),
    ".rs": ("rust-analyzer", []),
}


class _LspInput(BaseModel):
    operation: str = Field(
        description=(
            "One of: goToDefinition, findReferences, hover, documentSymbol, "
            "workspaceSymbol, goToImplementation"
        )
    )
    filePath: str = Field(description="File path (workspace-relative or absolute).")
    line: int = Field(default=1, description="1-based line number.")
    character: int = Field(default=1, description="1-based character offset.")
    query: str = Field(default="", description="Query for workspaceSymbol.")


class _LspClient:
    def __init__(self, cmd: list[str], root: Path) -> None:
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(root),
        )
        self._lock = threading.Lock()
        self._next_id = 1
        self._root = root
        self._initialized = False

    def close(self) -> None:
        try:
            self._proc.terminate()
            self._proc.wait(timeout=2)
        except Exception:  # noqa: BLE001
            try:
                self._proc.kill()
            except Exception:  # noqa: BLE001
                pass

    def _send(self, payload: dict[str, Any]) -> None:
        assert self._proc.stdin is not None
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self._proc.stdin.write(header + body)
        self._proc.stdin.flush()

    def _read(self, timeout: float = 8.0) -> dict[str, Any] | None:
        assert self._proc.stdout is not None
        deadline = time.time() + timeout
        buf = b""
        while time.time() < deadline:
            # peek header
            line = b""
            while time.time() < deadline:
                ch = self._proc.stdout.read(1)
                if not ch:
                    time.sleep(0.01)
                    continue
                line += ch
                if line.endswith(b"\r\n"):
                    break
            if not line:
                continue
            if line.lower().startswith(b"content-length:"):
                length = int(line.split(b":", 1)[1].strip())
                # consume blank line
                while time.time() < deadline:
                    ch = self._proc.stdout.read(1)
                    if ch == b"\n":
                        break
                body = b""
                while len(body) < length and time.time() < deadline:
                    chunk = self._proc.stdout.read(length - len(body))
                    if not chunk:
                        time.sleep(0.01)
                        continue
                    body += chunk
                try:
                    return json.loads(body.decode("utf-8"))
                except json.JSONDecodeError:
                    return None
        return None

    def request(self, method: str, params: dict[str, Any]) -> Any:
        with self._lock:
            if not self._initialized:
                self._send(
                    {
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "processId": os.getpid(),
                            "rootUri": self._root.as_uri(),
                            "capabilities": {},
                        },
                    }
                )
                self._read(timeout=10)
                self._send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
                self._initialized = True
                self._next_id = 2
            rid = self._next_id
            self._next_id += 1
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            # Drain until matching id
            for _ in range(20):
                msg = self._read()
                if msg is None:
                    break
                if msg.get("id") == rid:
                    if "error" in msg:
                        return {"error": msg["error"]}
                    return msg.get("result")
            return {"error": "timeout waiting for LSP response"}


_CLIENTS: dict[str, _LspClient] = {}
_CLIENTS_LOCK = threading.Lock()


def _server_for(path: Path) -> list[str] | None:
    spec = _DEFAULT_SERVERS.get(path.suffix.lower())
    if not spec:
        return None
    cmd, args = spec
    if not shutil.which(cmd):
        return None
    return [cmd, *args]


def _uri(path: Path) -> str:
    return path.resolve().as_uri()


def run_lsp(
    workspace: Path,
    *,
    operation: str,
    file_path: str,
    line: int = 1,
    character: int = 1,
    query: str = "",
) -> str:
    op = (operation or "").strip()
    path = Path(file_path).expanduser()
    if not path.is_absolute():
        path = (workspace / path).resolve()
    else:
        path = path.resolve()
    if not path.is_file() and op != "workspaceSymbol":
        return f"Error: file not found: {path}"

    cmd = _server_for(path if path.suffix else workspace / "x.py")
    if cmd is None and op == "workspaceSymbol":
        # try python server as default
        if shutil.which("pylsp"):
            cmd = ["pylsp"]
        elif shutil.which("typescript-language-server"):
            cmd = ["typescript-language-server", "--stdio"]
    if cmd is None:
        return (
            f"Error: no LSP server available for {path.suffix or 'workspace'}. "
            "Install pylsp / typescript-language-server / gopls / rust-analyzer."
        )

    key = " ".join(cmd) + "|" + str(workspace)
    with _CLIENTS_LOCK:
        client = _CLIENTS.get(key)
        if client is None:
            client = _LspClient(cmd, workspace)
            _CLIENTS[key] = client

    pos = {"line": max(0, int(line) - 1), "character": max(0, int(character) - 1)}
    doc = {"uri": _uri(path), "languageId": path.suffix.lstrip(".") or "plaintext", "version": 1, "text": ""}
    try:
        if path.is_file():
            doc["text"] = path.read_text(encoding="utf-8")
            client.request("textDocument/didOpen", {"textDocument": doc})
    except Exception:  # noqa: BLE001
        pass

    method_map = {
        "goToDefinition": ("textDocument/definition", {"textDocument": {"uri": _uri(path)}, "position": pos}),
        "findReferences": (
            "textDocument/references",
            {
                "textDocument": {"uri": _uri(path)},
                "position": pos,
                "context": {"includeDeclaration": True},
            },
        ),
        "hover": ("textDocument/hover", {"textDocument": {"uri": _uri(path)}, "position": pos}),
        "documentSymbol": ("textDocument/documentSymbol", {"textDocument": {"uri": _uri(path)}}),
        "workspaceSymbol": ("workspace/symbol", {"query": query or ""}),
        "goToImplementation": (
            "textDocument/implementation",
            {"textDocument": {"uri": _uri(path)}, "position": pos},
        ),
    }
    if op not in method_map:
        return f"Error: unsupported operation {op!r}"
    method, params = method_map[op]
    result = client.request(method, params)
    return json.dumps(result, indent=2, ensure_ascii=False, default=str)


def build_lsp_tool(workspace: Path | None) -> StructuredTool:
    root = Path(workspace).resolve() if workspace else Path.cwd()
    description = load_tool_prompt("lsp") or (
        "Language Server Protocol helpers: definitions, references, hover, symbols."
    )

    def _run(
        operation: str,
        filePath: str,
        line: int = 1,
        character: int = 1,
        query: str = "",
    ) -> str:
        try:
            return run_lsp(
                root,
                operation=operation,
                file_path=filePath,
                line=line,
                character=character,
                query=query,
            )
        except Exception as exc:  # noqa: BLE001
            return f"Error: LSP failed: {exc}"

    return StructuredTool.from_function(
        name="lsp",
        description=description,
        func=_run,
        args_schema=_LspInput,
    )
