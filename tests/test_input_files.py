import base64

import pytest

from circle.input_files import prepare_content, file_candidates


def test_explicit_text_and_image_content_preserved(tmp_path):
    (tmp_path / "note.txt").write_text("TEXT_DATA")
    image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvS8AAAAASUVORK5CYII=")
    (tmp_path / "image.png").write_bytes(image)
    blocks = prepare_content("inspect @note.txt", tmp_path, files=["image.png"])
    assert any(block.get("text", "").endswith("TEXT_DATA") for block in blocks)
    attached = next(block for block in blocks if block["type"] == "image")
    assert base64.b64decode(attached["base64"]) == image


def test_credential_reference_is_not_an_alternate_read_route(tmp_path):
    (tmp_path / ".env").write_text("SYNTHETIC_SECRET")
    with pytest.raises(ValueError, match="Credential"):
        prepare_content("inspect @.env", tmp_path)


def test_fuzzy_file_completion_uses_existing_paths(tmp_path):
    (tmp_path / "target.py").write_text("pass")
    assert "target.py" in file_candidates(tmp_path, "targ")


def test_large_image_is_resized_with_coordinate_disclosure(tmp_path):
    import io
    from PIL import Image
    Image.new("RGB", (4000, 3000), "red").save(tmp_path / "large.png")
    blocks = prepare_content("inspect @large.png", tmp_path)
    attached = next(block for block in blocks if block["type"] == "image")
    with Image.open(io.BytesIO(base64.b64decode(attached["base64"]))) as image:
        assert image.size == (2000, 1500)
    assert any("original 4000x3000, submitted 2000x1500" in block.get("text", "") for block in blocks)


def test_inline_preview_is_bounded_and_keeps_model_attachment(tmp_path):
    from PIL import Image
    from circle.input_files import image_previews
    from circle.ink.string_width import string_width
    Image.new("RGB", (160, 80), "red").save(tmp_path / "preview.png")
    content = prepare_content("@preview.png", tmp_path)
    before = next(block["base64"] for block in content if block["type"] == "image")
    lines = image_previews(content, width=30)
    assert lines and all(string_width(line) <= 30 for line in lines)
    assert len(lines) <= 20 and any("\x1b[" in line for line in lines)
    assert next(block["base64"] for block in content if block["type"] == "image") == before
