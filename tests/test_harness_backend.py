"""The harness uses the framework sandbox backend and adds no file tools."""

from pathlib import Path

import pytest

from circle_harness import sandbox_backend
from deepagents.backends import LocalShellBackend
from deepagents.backends.protocol import SandboxBackendProtocol


def test_backend_is_the_framework_local_sandbox(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    assert isinstance(backend, LocalShellBackend)
    assert isinstance(backend, SandboxBackendProtocol)
    assert backend.virtual_mode is True
    assert backend._env == {}


def test_filesystem_paths_stay_inside_the_root(tmp_path: Path):
    backend = sandbox_backend(tmp_path)
    written = backend.write("/note.txt", "circle")
    assert written.error is None
    assert (tmp_path / "note.txt").read_text(encoding="utf-8") == "circle"
    with pytest.raises(ValueError, match="Path traversal not allowed"):
        backend.read("/../note.txt")
