"""Reject partial, mismatched or corrupt release artifacts before publication."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tarfile

TARGETS = (("linux", "x86_64"), ("darwin", "arm64"))


def verify(directory: Path, commit: str, version: str) -> None:
    expected = {f"circle-{os_name}-{arch}.tar.gz" for os_name, arch in TARGETS}
    assert {p.name for p in directory.glob('*.tar.gz')} == expected, "incomplete or unexpected platform archives"
    for os_name, arch in TARGETS:
        name = f"circle-{os_name}-{arch}.tar.gz"
        archive = directory / name
        digest, recorded_name = (directory / f"{name}.sha256").read_text().strip().split()
        assert recorded_name == name
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == digest, f"checksum mismatch: {name}"
        with tarfile.open(archive) as package:
            stream = package.extractfile('circle/BUILD_INFO.json')
            assert stream is not None
            info = json.load(stream)
            assert info == {'commit': commit, 'version': version, 'os': os_name, 'arch': arch}, info
            assert package.getmember('circle/circle').mode & 0o111
            assert package.getmember('circle/_internal/circle/prompts/session/gpt.md').isfile()
    print("all platform archives match the release commit, version and checksums")


if __name__ == '__main__':
    verify(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
