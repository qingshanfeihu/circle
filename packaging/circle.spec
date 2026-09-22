# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for Circle.

Build (CI):
  pyinstaller packaging/circle.spec --noconfirm --clean

Asset name convention (install.sh):
  circle-<os>-<arch>.tar.gz  containing onedir folder ``circle/`` with binary ``circle``.
"""

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = []

for pkg in ("deepagents", "langgraph", "langchain", "langchain_core", "langsmith"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:  # noqa: BLE001 — optional collect; build still proceeds
        hiddenimports += collect_submodules(pkg)

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
    ["../circle/__main__.py"],
    pathex=[".."],
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
