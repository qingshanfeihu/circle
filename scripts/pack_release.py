#!/usr/bin/env python3
"""Pack the PyInstaller output into the release asset that install.sh, install.ps1 and
`circle update` expect, and write its sha256 next to it.

    python scripts/pack_release.py linux x86_64

reads dist/circle/ and writes circle-<os>-<arch>.tar.gz (circle-windows-x86_64.zip on Windows)
and the same name plus .sha256, in the current folder. The archive holds one top folder, circle/.
"""

from __future__ import annotations

import hashlib
import sys
import tarfile
import zipfile
from pathlib import Path


def pack(os_tag: str, arch: str, dist: Path = Path("dist"), out: Path = Path(".")) -> Path:
    tree = dist / "circle"
    if not tree.is_dir():
        raise SystemExit(f"pack_release: {tree} does not exist; run pyinstaller first")
    if os_tag == "windows":
        asset = out / f"circle-{os_tag}-{arch}.zip"
        with zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(tree.rglob("*")):
                zf.write(path, path.relative_to(dist).as_posix())
    else:
        asset = out / f"circle-{os_tag}-{arch}.tar.gz"
        with tarfile.open(asset, "w:gz") as tf:
            tf.add(tree, arcname="circle")
    digest = hashlib.sha256(asset.read_bytes()).hexdigest()
    Path(f"{asset}.sha256").write_text(f"{digest}  {asset.name}\n", encoding="utf-8")
    return asset


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    asset = pack(argv[0], argv[1])
    print(f"{asset} ({asset.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
