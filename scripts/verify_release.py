#!/usr/bin/env python3
"""Verify all five archives, checksums and embedded source identity before publication."""
import hashlib
import json
import sys
import tarfile
import zipfile
from pathlib import Path

TARGETS = [('linux', 'x86_64'), ('linux', 'arm64'), ('darwin', 'x86_64'), ('darwin', 'arm64'), ('windows', 'x86_64')]


def verify(folder: Path, commit: str, version: str) -> None:
    for os_tag, arch in TARGETS:
        suffix = 'zip' if os_tag == 'windows' else 'tar.gz'
        asset = folder / f'circle-{os_tag}-{arch}.{suffix}'
        expected, name = Path(str(asset) + '.sha256').read_text().split()
        assert name == asset.name, (name, asset.name)
        assert hashlib.sha256(asset.read_bytes()).hexdigest() == expected, asset.name
        if suffix == 'zip':
            with zipfile.ZipFile(asset) as archive:
                info = json.loads(archive.read('circle/BUILD_INFO.json'))
                names = archive.namelist()
        else:
            with tarfile.open(asset) as archive:
                info = json.load(archive.extractfile('circle/BUILD_INFO.json'))
                names = archive.getnames()
        assert info == dict(commit=commit, version=version, os=os_tag, arch=arch), info
        executable = 'circle/circle.exe' if os_tag == 'windows' else 'circle/circle'
        assert executable in names, executable
        assert any(n.startswith('circle/_internal/circle/prompts/') and n.endswith('.md') for n in names), asset.name
        assert 'circle/_internal/circle/data/models_dev.json.gz' in names, asset.name
    print('verified five archives: checksums, commit, version, target, executable, prompts and '
          'the models.dev snapshot')


if __name__ == '__main__':
    verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
