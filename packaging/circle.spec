# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for Circle.

Build (CI):
  pyinstaller packaging/circle.spec --noconfirm --clean

Asset name convention (install.sh):
  circle-<os>-<arch>.tar.gz  containing onedir folder ``circle/`` with binary ``circle``.
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH).parent

datas = []
binaries = []
hiddenimports = []

for pkg in ("deepagents", "langgraph", "langchain", "langchain_core", "langsmith",
            "langchain_openai", "langchain_anthropic", "sqlite_vec"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:  # noqa: BLE001 — optional collect; build still proceeds
        hiddenimports += collect_submodules(pkg)

datas += collect_data_files("circle", includes=["prompts/**/*.md"])
datas += copy_metadata("circle")
hiddenimports += collect_submodules("circle")
hiddenimports += [
    "circle",
    "circle.cli",
    "circle.harness",
    "circle.init_flow",
    "circle.main_session",
    "circle.model",
    "circle.oauth",
    "circle.paths",
    "circle.probe",
    "circle.settings",
    "circle.trust",
    "circle.trust_flow",
    "circle.tui",
    "circle.tui.app",
    "circle.tui.controllers",
    "circle.tui.session",
    "circle.tui.session_app",
    "circle.tui.slash_commands",
    "circle.tui.harness_bridge",
    "circle.tui.content_blocks",
    "circle.ink",
    "circle.ink.app",
]

a = Analysis(
    [str(root / "circle" / "__main__.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="circle",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="circle",
)
