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
