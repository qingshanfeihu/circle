"""Explicit user file/image inputs, encoded as standard LangChain blocks."""
from __future__ import annotations

import base64
import difflib
import fnmatch
import io
import mimetypes
import re
import subprocess
import uuid
from pathlib import Path

from circle.approvals import DEFAULT_CREDENTIAL_FILES, INTERNAL_CREDENTIAL_FILES

REFERENCES = re.compile(r'(?<!\S)@(?:"([^"]+)"|\'([^\']+)\'|(\S+))')


def prepare_image(data: bytes, mime: str):
    """Use Pillow's image transforms, with the same bounds as Pi's input path."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(data)) as original:
            before = original.size
            orientation = original.getexif().get(274, 1)
            max_payload = int(4.5 * 1024 * 1024)
            if (max(before) <= 2000 and (len(data) + 2) // 3 * 4 <= max_payload
                    and mime in {"image/png", "image/jpeg", "image/gif", "image/webp"}
                    and orientation == 1):
                return data, mime, None
            image = ImageOps.exif_transpose(original)
            image.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.save(output, format="PNG")
            encoded, result_mime = output.getvalue(), "image/png"
            if (len(encoded) + 2) // 3 * 4 > max_payload:
                # JPEG bounds the transport size. Composite transparency on white.
                rgb = Image.new("RGB", image.size, "white")
                rgba = image.convert("RGBA")
                rgb.paste(rgba, mask=rgba.getchannel("A"))
                output = io.BytesIO()
                rgb.save(output, format="JPEG", quality=80)
                encoded, result_mime = output.getvalue(), "image/jpeg"
            if (len(encoded) + 2) // 3 * 4 > max_payload:
                raise ValueError("Image cannot fit the provider payload limit")
            note = f"Image resized/oriented: original {before[0]}x{before[1]}, submitted {image.width}x{image.height}. Coordinates refer to the submitted image."
            return encoded, result_mime, note
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Unsupported or invalid image attachment") from exc


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


def image_previews(content, *, width: int = 60) -> list[str]:
    """Rich Pixels supplies an inline preview using ordinary terminal cells."""
    if not isinstance(content, list) or not any(block.get("type") == "image" for block in content):
        return []
    from PIL import Image
    from rich.console import Console
    from rich_pixels import Pixels
    lines = []
    for block in content:
        if block.get("type") != "image":
            continue
        try:
            with Image.open(io.BytesIO(base64.b64decode(block["base64"]))) as image:
                image.thumbnail((max(1, min(width, 60)), 40))
                output = io.StringIO()
                console = Console(file=output, width=max(1, width), force_terminal=True,
                                  color_system="truecolor", no_color=False, legacy_windows=False)
                console.print(Pixels.from_image(image))
                lines.extend(output.getvalue().splitlines())
        except (ValueError, OSError):
            lines.append("（图片预览不可用，附件仍保留）")
    return lines


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
        patterns = (*INTERNAL_CREDENTIAL_FILES, *(credential_files or DEFAULT_CREDENTIAL_FILES))
        if any(fnmatch.fnmatchcase(path.name, pattern) for pattern in patterns):
            raise ValueError("Credential files cannot be attached")
        if not path.is_file():
            raise FileNotFoundError(f"Attachment not found: {source}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        size = path.stat().st_size
        if not mime.startswith("image/") and size > 50_000:
            blocks.append({"type": "text", "text": f"Referenced file: {path} ({size} bytes). Content is not truncated or attached; use read_file pagination."})
            continue
        if size > 50_000_000:
            raise ValueError("Image exceeds the 50 MB input limit")
        data = path.read_bytes()
        if mime.startswith("image/"):
            data, mime, note = prepare_image(data, mime)
            if note:
                blocks.append({"type": "text", "text": note})
            blocks.append({"type": "image", "base64": base64.b64encode(data).decode(), "mime_type": mime})
        else:
            blocks.append({"type": "text", "text": f"File: {path}\n{data.decode('utf-8')}"})
    return blocks
