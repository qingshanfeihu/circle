"""An editor executable for the native shell, including Windows batch invocation."""
import os
from pathlib import Path


def write_editor(folder: Path, text: str) -> Path:
    if os.name == 'nt':
        editor = folder / 'editor.cmd'
        editor.write_text(f'@echo off\r\necho {text}>"%~1"\r\n', encoding='utf-8')
    else:
        editor = folder / 'editor.sh'
        editor.write_text(f'#!/bin/sh\nprintf \'{text}\\n\' > "$1"\n', encoding='utf-8')
        editor.chmod(0o755)
    return editor
