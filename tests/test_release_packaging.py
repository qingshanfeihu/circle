"""Release gates reject partial/corrupt builds; installer works without network."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

import pytest

from scripts.verify_release import TARGETS, verify


def archive(path, info):
    with tarfile.open(path, 'w:gz') as package:
        for name, data, mode in [
            ('circle/BUILD_INFO.json', json.dumps(info).encode(), 0o644),
            ('circle/circle', b'#!/bin/sh\nexit 0\n', 0o755),
            ('circle/_internal/circle/prompts/session/gpt.md', b'prompt', 0o644),
        ]:
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), mode
            package.addfile(member, io.BytesIO(data))
    path.with_name(path.name + '.sha256').write_text(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n')


def assets(tmp_path):
    for os_name, arch in TARGETS:
        archive(tmp_path / f'circle-{os_name}-{arch}.tar.gz',
                {'commit': 'abc123', 'version': '0.2.0', 'os': os_name, 'arch': arch})


def test_release_requires_every_target(tmp_path):
    assets(tmp_path)
    verify(tmp_path, 'abc123', '0.2.0')
    (tmp_path / 'circle-darwin-arm64.tar.gz').unlink()
    with pytest.raises(AssertionError, match='incomplete'):
        verify(tmp_path, 'abc123', '0.2.0')


def test_release_rejects_wrong_commit_and_corruption(tmp_path):
    assets(tmp_path)
    with pytest.raises(AssertionError):
        verify(tmp_path, 'different-commit', '0.2.0')
    path = tmp_path / 'circle-linux-x86_64.tar.gz'
    path.write_bytes(path.read_bytes() + b'corrupt')
    with pytest.raises(AssertionError, match='checksum'):
        verify(tmp_path, 'abc123', '0.2.0')


def test_installer_cleanup_succeeds_with_spaces_and_repeated_install(tmp_path):
    root = Path(__file__).resolve().parents[1]
    payload = tmp_path / 'payload.tar.gz'
    archive(payload, {})
    commands = tmp_path / 'commands'
    commands.mkdir()
    curl = commands / 'curl'
    curl.write_text('#!/bin/sh\ncp "$TEST_ARCHIVE" "$4"\n')
    curl.chmod(0o755)
    temporary = tmp_path / 'temporary files'
    temporary.mkdir()
    env = dict(os.environ, HOME=str(tmp_path), SHELL='/bin/bash', TMPDIR=str(temporary),
               CIRCLE_VERSION='0.2.0', CIRCLE_HOME=str(tmp_path / 'home'),
               CIRCLE_PREFIX=str(tmp_path / 'prefix'), CIRCLE_BIN_DIR=str(tmp_path / 'bin'),
               PATH=str(commands) + os.pathsep + os.environ['PATH'], TEST_ARCHIVE=str(payload))
    for _ in range(2):
        subprocess.run(['bash', str(root / 'install.sh')], env=env, cwd=tmp_path,
                       check=True, capture_output=True, text=True, timeout=10)
    assert not list(temporary.iterdir())
    assert (tmp_path / 'bin/circle').is_symlink()
    assert (tmp_path / '.bashrc').read_text().count('# circle path') == 1
