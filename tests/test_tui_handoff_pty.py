"""Real terminal regression for the gate/session reader handoff; localhost mock only.

Set CIRCLE_TEST_BINARY to exercise a frozen release instead of the source checkout.
"""
import errno
import json
import os
import re
import select
import signal
import struct
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX PTY; Windows reader uses kernel32 tests")
if os.name != "nt":
    import fcntl
    import pty
    import termios

ROOT = Path(__file__).resolve().parents[1]
COMMAND = [str(Path(os.environ["CIRCLE_TEST_BINARY"]).resolve())] if os.environ.get("CIRCLE_TEST_BINARY") else [sys.executable, "-m", "circle"]
KEY = "local-handoff-test-placeholder"
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')

class Terminal:
    def __init__(self, args, home, ws, tui=False):
        env = {'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8','TERM':'xterm-256color',
               'PYTHONUTF8':'1','CIRCLE_HOME':str(home),'CIRCLE_NO_UPDATE_CHECK':'1',
               'CIRCLE_NO_MODELS_REFRESH':'1',
               'NO_PROXY':'localhost,127.0.0.1', 'COLORFGBG': '0;15'}
        if not tui: env['CIRCLE_NO_TUI']='1'
        self.pid, self.fd = pty.fork()
        if not self.pid:
            os.chdir(ROOT)
            os.execve(COMMAND[0], [*COMMAND, *args], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH',40,160,0,0))
        self.text=''; self.mark=0; self.ended=False
    def read(self, delay=.1):
        ready,_,_=select.select([self.fd],[],[],delay)
        if ready:
            try: data=os.read(self.fd,65536)
            except OSError as e:
                if e.errno==errno.EIO: return
                raise
            self.text += data.decode('utf-8','replace')
    def expect(self, needle, timeout=20):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            chunk = self.text[self.mark:]
            clean, positions, cursor = '', [], 0
            for escape in ANSI.finditer(chunk):
                segment = chunk[cursor:escape.start()]
                clean += segment
                positions.extend(range(cursor, escape.start()))
                cursor = escape.end()
            clean += chunk[cursor:]
            positions.extend(range(cursor, len(chunk)))
            kept = [i for i, ch in enumerate(clean) if not ch.isspace()]
            positions = [positions[i] for i in kept]
            clean = "".join(clean[i] for i in kept)
            needle = "".join(needle.split())
            index = clean.find(needle)
            if index >= 0:
                self.mark += positions[index+len(needle)-1]+1
                return clean[:index+len(needle)]
            self.read(.05)
        raise AssertionError(f'waiting for {needle!r}: {ANSI.sub("", self.text)[-2000:]}')
    def send(self, text): os.write(self.fd,text.encode())
    def finish(self, allowed_codes=(0,)):
        end=time.monotonic()+12
        while time.monotonic()<end:
            self.read(.05)
            pid,status=os.waitpid(self.pid,os.WNOHANG)
            if pid:
                self.ended=True
                assert os.waitstatus_to_exitcode(status) in allowed_codes, status
                os.close(self.fd)
                return
        raise AssertionError('program did not exit')
    def close(self):
        if not self.ended:
            os.kill(self.pid,signal.SIGKILL); os.waitpid(self.pid,0); os.close(self.fd)

class ModelsAPI(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append(self.path)
        assert self.headers.get("Authorization") == "Bearer " + KEY or self.headers.get("x-api-key") == KEY
        raw = json.dumps({"data": [] if self.server.kind == "empty" else [{"id": "handoff-a"}, {"id": "handoff-b"}]}).encode()
        self.send_response(500 if self.server.kind == "failed" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def discover_once(terminal, server):
    before = len(server.requests)
    terminal.send("/models\r")
    deadline = time.monotonic() + 5
    while len(server.requests) == before and time.monotonic() < deadline:
        terminal.read(.05)
    assert len(server.requests) > before, "first /models was lost after gate/session handoff"
    terminal.expect({"valid": "discovered 2 models", "empty": "empty model list", "failed": "model discovery failed"}[server.kind])
    # Close the model list before the next command; a lone esc is read as the esc key
    # only once nothing follows it for a moment
    terminal.send("\x1b")
    settle = time.monotonic() + .5
    while time.monotonic() < settle:
        terminal.read(.05)


@pytest.mark.parametrize("kind", ["valid", "empty", "failed"])
def test_first_command_after_init_and_repeated_handoffs(kind, tmp_path):
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModelsAPI)
    server.kind, server.requests = kind, []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    home = tmp_path / "home"
    try:
        for iteration in range(2):
            workspace = tmp_path / str(iteration)
            workspace.mkdir()
            terminal = Terminal(["--init", str(workspace)], home, workspace, tui=True)
            try:
                terminal.expect("API URL + KEY"); terminal.send("\r")
                terminal.expect("An OpenAI-style or Anthropic-style API")
                terminal.send(f"http://127.0.0.1:{server.server_port}/v1/\r")
                terminal.expect("What is the API key?"); terminal.send(KEY + "\r")
                if kind == "failed":
                    terminal.expect("Which kind of API is it?")
                    terminal.send("2\r")
                    terminal.expect("(anthropic); model is unverified")
                elif kind == "empty":
                    terminal.expect("returned an empty model list")
                    terminal.send("\r")
                    terminal.expect("Enter a model id")
                else:
                    terminal.expect("2 models at 127.0.0.1")
                    terminal.expect("handoff-b")
                # The list is searched by typing; enter takes the marked row (the first) or
                # the id typed when no listed model has it
                terminal.send(("" if kind == "valid" else "manual-handoff") + "\r")
                terminal.expect("Trust this folder?"); terminal.send("y\r")
                terminal.expect("for shortcuts", 30)
                # No retry or settling sleep: the very first command must work.
                discover_once(terminal, server)
                discover_once(terminal, server)
                terminal.send("\x04"); terminal.finish()
                auth = json.loads((home / "settings.json").read_text())["auth"]
                assert auth["model"] == ("handoff-a" if kind == "valid" else "manual-handoff")
                assert auth["protocol"] == ("anthropic" if kind == "failed" else "openai")
                assert not any("/v1/v1/" in path for path in server.requests)
            finally:
                terminal.close()
            # Restart without gates; command and terminal shutdown must still work.
            terminal = Terminal([str(workspace)], home, workspace, tui=True)
            try:
                terminal.expect("for shortcuts", 30)
                discover_once(terminal, server)
                terminal.send("\x04"); terminal.finish()
            finally:
                terminal.close()
    finally:
        server.shutdown()
        server.server_close()


def test_cancel_initialization_repeatedly_exits_without_another_key(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    for _ in range(2):
        terminal = Terminal(["--init", str(workspace)], tmp_path / "home", workspace, tui=True)
        try:
            terminal.expect("API URL + KEY")
            terminal.send("\x03")
            terminal.finish(allowed_codes=(0, 1))
        finally:
            terminal.close()


def test_declining_trust_exits_without_starting_a_session(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "settings.json").write_text(json.dumps({
        "initialized": True,
        "auth": {"mode": "api_key", "protocol": "openai",
                 "base_url": "http://127.0.0.1:1/v1", "model": "unused-mock-model"},
        "trusted_folders": [], "update_check": False,
    }))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    for _ in range(2):
        terminal = Terminal([str(workspace)], home, workspace, tui=True)
        try:
            terminal.expect("Trust this folder?")
            terminal.send("n\r")
            terminal.finish(allowed_codes=(1,))
            assert "for shortcuts" not in ANSI.sub("", terminal.text)
            assert json.loads((home / "settings.json").read_text())["trusted_folders"] == []
        finally:
            terminal.close()
