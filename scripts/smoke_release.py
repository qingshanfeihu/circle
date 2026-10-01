"""Exercise a frozen executable with scratch settings and no model requests."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def smoke_tui(executable: Path, workspace: Path, env: dict[str, str], model: str) -> None:
    import fcntl
    import pty
    import select
    import struct
    import termios
    import time

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
    tui_env = dict(env, TERM="xterm-256color")
    tui_env.pop("CIRCLE_NO_TUI", None)
    process = subprocess.Popen([str(executable), str(workspace)], env=tui_env,
                               stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = b""
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output += os.read(master, 65536)
                except OSError:
                    break
            if model.encode() in output and b"shortcuts" in output:
                os.write(master, b"\x04")
                assert process.wait(timeout=10) == 0
                print("frozen TUI startup and exit passed")
                return
            if process.poll() is not None:
                break
        raise AssertionError("frozen TUI did not reach the ready screen: " + output.decode(errors="replace"))
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        os.close(master)


def main() -> None:
    executable = Path(sys.argv[1]).resolve()
    expected_version = sys.argv[2]
    with tempfile.TemporaryDirectory(prefix="circle-smoke-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        for protocol, model in (("openai", "gpt-4.1"), ("anthropic", "claude-sonnet-4-5")):
            home = root / protocol
            home.mkdir()
            env = dict(os.environ, CIRCLE_HOME=str(home), CIRCLE_NO_TUI="1")
            # Loopback is intentionally unusable. /exit must build the model and
            # harness (including prompt resources), but never send a model request.
            settings = {"initialized": True, "trusted_folders": [str(workspace)],
                        "auth": {"mode": "api_key", "protocol": protocol,
                                 "base_url": "http://127.0.0.1:9", "model": model}}
            (home / "settings.json").write_text(json.dumps(settings))
            (home / "credentials.json").write_text('{"api_key":"release-smoke-dummy"}')
            assert subprocess.check_output([str(executable), "--version"], env=env, text=True).strip() == expected_version
            assert subprocess.check_output([str(executable), "--print-home"], env=env, text=True).strip() == str(home)
            result = subprocess.run([str(executable), "--line", str(workspace)], input="/exit\n",
                                    text=True, env=env, capture_output=True, timeout=45)
            if result.returncode:
                raise SystemExit(result.stdout + result.stderr)
            assert "you>" in result.stdout, result.stdout
            print(f"frozen {protocol} model and harness startup passed")
            if protocol == "openai":
                smoke_tui(executable, workspace, env, model)


if __name__ == "__main__":
    main()
