import os
import subprocess
from pathlib import Path


def test_checksum_failure_preserves_current_install(tmp_path):
    commands = tmp_path / "commands"
    commands.mkdir()
    # The fake download is deliberately invalid. No extraction or PATH edits
    # should occur before its checksum fails.
    (commands / "curl").write_text("#!/bin/sh\nfor last; do :; done\nprintf invalid > \"$last\"\n")
    (commands / "curl").chmod(0o755)
    prefix = tmp_path / "install"
    prefix.mkdir()
    (prefix / "current").mkdir()
    marker = prefix / "current" / "working"
    marker.write_text("keep")
    result = subprocess.run(["bash", "install.sh"], cwd=Path(__file__).resolve().parents[1],
                            env={**os.environ, "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                                 "CIRCLE_VERSION": "test", "CIRCLE_PREFIX": str(prefix),
                                 "CIRCLE_BIN_DIR": str(tmp_path / "bin"), "CIRCLE_HOME": str(tmp_path / "home")},
                            capture_output=True, text=True)
    assert result.returncode != 0
    assert marker.read_text() == "keep"
    assert not (tmp_path / "bin" / "circle").exists()
