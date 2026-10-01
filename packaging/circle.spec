# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for Circle.

Build (CI):
  pyinstaller packaging/circle.spec --noconfirm --clean

Asset name convention (install.sh, install.ps1, ``circle update``):
  circle-<os>-<arch>.tar.gz  (zip on Windows) holding the onedir folder ``circle/``
  with the program ``circle`` (``circle.exe`` on Windows).
"""

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

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

# Everything under circle/ (modules that are only imported by name, extensions, the TUI), and the
# prompt files the agent reads at start: they are data, not imports, so nothing else finds them.
hiddenimports += collect_submodules("circle")
datas += collect_data_files("circle", includes=["prompts/**/*.md"])

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
