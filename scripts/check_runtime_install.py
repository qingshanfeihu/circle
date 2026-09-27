"""Exercise the real installer against a loopback artifact server on its target OS."""
from __future__ import annotations

import argparse
import functools
import http.server
import os
import platform
import subprocess
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", type=Path, default=ROOT / "dist-release")
    args = parser.parse_args()
    corrupt_checksum = threading.Event()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if corrupt_checksum.is_set() and self.path.endswith(".sha256"):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"0" * 64 + b"  invalid\n")
            else:
                super().do_GET()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
        functools.partial(Handler, directory=str(args.artifacts.resolve())))
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="circle-install-check-") as temporary:
            root = Path(temporary)
            prefix, bin_dir = root / "install with spaces", root / "bin with spaces"
            env = {**os.environ, "CIRCLE_DOWNLOAD_BASE_URL": f"http://127.0.0.1:{server.server_port}",
                   "CIRCLE_VERSION": "ci-check", "CIRCLE_PREFIX": str(prefix),
                   "CIRCLE_BIN_DIR": str(bin_dir), "CIRCLE_HOME": str(root / "home"),
                   "PATH": str(bin_dir) + os.pathsep + os.environ.get("PATH", ""),
                   "LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"}
            if platform.system() == "Windows":
                command = ["pwsh", "-NoProfile", "-File", str(ROOT / "install.ps1"),
                           "-Version", "ci-check", "-Prefix", str(prefix),
                           "-BinDirectory", str(bin_dir), "-NoPathUpdate"]
                launcher = ["cmd", "/c", str(bin_dir / "circle.cmd")]
                pointer = bin_dir / "circle.cmd"
            else:
                command = ["bash", str(ROOT / "install.sh")]
                launcher = [str(bin_dir / "circle")]
                pointer = bin_dir / "circle"

            subprocess.run(command, env=env, check=True)
            subprocess.run([*launcher, "--version"], env=env, check=True)
            before = pointer.read_bytes()
            first_generations = set((prefix / "versions").iterdir())
            subprocess.run(command, env=env, check=True)
            assert all(path.exists() for path in first_generations), "Upgrade removed the previous install"
            assert pointer.read_bytes() != before, "Upgrade did not select a new generation"
            subprocess.run([*launcher, "--list-models"], env=env, stdout=subprocess.DEVNULL, check=True)
            current = pointer.read_bytes()
            corrupt_checksum.set()
            rejected = subprocess.run(command, env=env, capture_output=True, check=False)
            assert rejected.returncode != 0, "Invalid checksum was accepted"
            assert pointer.read_bytes() == current, "Failed upgrade changed the active install"
            subprocess.run([*launcher, "--version"], env=env, check=True)
            print("INSTALL_UPGRADE_REJECTED_CHECKSUM_OK")
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


if __name__ == "__main__":
    main()
