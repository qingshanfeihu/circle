"""Explicit user file/image inputs, encoded as standard LangChain blocks."""
from __future__ import annotations

import base64
import difflib
import uuid
import fnmatch
import mimetypes
import re
import subprocess
from pathlib import Path

from circle.approvals import DEFAULT_CREDENTIAL_FILES

REFERENCES = re.compile(r'(?<!\S)@(?:"([^"]+)"|\'([^\']+)\'|(\S+))')


def clipboard_image(home: Path) -> Path | None:
    from PIL import Image, ImageGrab
    image = ImageGrab.grabclipboard()
    if not isinstance(image, Image.Image):
        return None
    folder = home / "attachments"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (uuid.uuid4().hex + ".png")
    image.save(path, format="PNG")
    return path


def file_candidates(workspace: Path, prefix: str) -> list[str]:
    try:
        output = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                                          cwd=workspace, stderr=subprocess.DEVNULL).decode()
        paths = [path for path in output.split("\0") if path]
    except (subprocess.CalledProcessError, FileNotFoundError):
        paths = [str(path.relative_to(workspace)) for path in workspace.glob("*") if path.is_file()]
    exact = [path for path in paths if path.startswith(prefix)]
    return sorted(exact)[:20] or difflib.get_close_matches(prefix, paths, n=20, cutoff=0.2)


def prepare_content(text: str, workspace: Path, *, files=(), credential_files=None):
    references = [next(part for part in match.groups() if part is not None) for match in REFERENCES.finditer(text)]
    selected = [*files, *references]
    if not selected:
        return text
    blocks = [{"type": "text", "text": text}]
    seen = set()
    for source in selected:
        path = Path(source).expanduser()
        path = (workspace / path).resolve() if not path.is_absolute() else path.resolve()
        if path in seen:
            continue
        seen.add(path)
        if any(fnmatch.fnmatchcase(path.name, pattern) for pattern in (credential_files or DEFAULT_CREDENTIAL_FILES)):
            raise ValueError("Credential files cannot be attached")
        if not path.is_file():
            raise FileNotFoundError(f"Attachment not found: {source}")
        data = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if mime.startswith("image/"):
            if len(data) > 10_000_000:
                raise ValueError("Image exceeds 10 MB; resize before attaching")
            blocks.append({"type": "image", "base64": base64.b64encode(data).decode(), "mime_type": mime})
        elif len(data) > 50_000:
            blocks.append({"type": "text", "text": f"Referenced file: {path} ({len(data)} bytes). Content is not truncated or attached; use read_file pagination."})
        else:
            blocks.append({"type": "text", "text": f"File: {path}\n{data.decode('utf-8')}"})
    return blocks
