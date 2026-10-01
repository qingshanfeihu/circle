"""Publication rejects mixed commits and corrupted native archives."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def assets(tmp_path, monkeypatch):
    packer, verifier = load('pack_release'), load('verify_release')
    monkeypatch.delenv('GITHUB_SHA', raising=False)
    monkeypatch.setattr(packer.subprocess, 'check_output', lambda *a, **k: 'abc123\n')
    from circle import __version__
    for os_tag, arch in verifier.TARGETS:
        tree = tmp_path / 'dist/circle'
        tree.mkdir(parents=True, exist_ok=True)
        (tree / ('circle.exe' if os_tag == 'windows' else 'circle')).write_bytes(b'program')
        prompts = tree / '_internal/circle/prompts'
        prompts.mkdir(parents=True, exist_ok=True)
        (prompts / 'session.md').write_text('prompt')
        packer.pack(os_tag, arch, tmp_path / 'dist', tmp_path)
    return tmp_path, verifier, __version__


def test_complete_matching_archives_pass(assets):
    folder, verifier, version = assets
    verifier.verify(folder, 'abc123', version)


def test_mixed_source_commits_are_rejected(assets):
    folder, verifier, version = assets
    with pytest.raises(AssertionError):
        verifier.verify(folder, 'other-commit', version)


def test_corrupt_archive_is_rejected(assets):
    folder, verifier, version = assets
    with (folder / 'circle-linux-arm64.tar.gz').open('ab') as stream:
        stream.write(b'corrupt')
    with pytest.raises(AssertionError):
        verifier.verify(folder, 'abc123', version)


def test_missing_target_blocks_publication(assets):
    folder, verifier, version = assets
    (folder / 'circle-windows-x86_64.zip').unlink()
    with pytest.raises(FileNotFoundError):
        verifier.verify(folder, 'abc123', version)
