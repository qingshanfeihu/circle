#!/usr/bin/env python3
"""Install the actual native archive twice using offline downloads and a scratch prefix."""
from __future__ import annotations

import os
import runpy
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main(os_tag: str, arch: str) -> None:
    from circle import __version__
    from scripts.smoke_frozen import main as smoke
    suffix = 'zip' if os_tag == 'windows' else 'tar.gz'
    asset = ROOT / f'circle-{os_tag}-{arch}.{suffix}'
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        if os_tag == 'windows':
            # Reuse the same download substitution tested by the installer regression suite.
            helpers = runpy.run_path(str(ROOT / 'tests/test_install_ps1.py'))
            release = root / 'release'
            release.mkdir()
            for path in (asset, Path(str(asset) + '.sha256')):
                shutil.copy2(path, release / path.name)
            def install():
                return helpers['_run'](root, FAKE_VERSION=__version__)
        else:
            helpers = runpy.run_path(str(ROOT / 'tests/test_install_sh.py'))
            box = helpers['Box'](root)
            for path in (asset, Path(str(asset) + '.sha256')):
                shutil.copy2(path, box.release / path.name)
            def install():
                return box.run(CIRCLE_VERSION=__version__, FAKE_UNAME_S='Darwin' if os_tag == 'darwin' else 'Linux', FAKE_UNAME_M=arch)
        for _ in range(2):
            result = install()
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
        installed = root / 'prefix/current/circle'
        assert smoke([str(installed)]) == 0, 'installed archive failed startup'
    print(f'install smoke ok: {os_tag}/{arch}, checksum, first install and repeat install')


if __name__ == '__main__':
    main(*sys.argv[1:])
