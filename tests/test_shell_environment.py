"""Commands the model runs get the user's environment minus secrets.

They used to run with an empty environment (inherit_env=False, no env): no HOME, the shell's
default PATH (so the user's venv python was ignored) and no SSL_CERT_FILE, which broke HTTPS to a
server behind a private CA (compile-excel's run_device.py: "server unreachable"). Keeping API keys
out of model-run commands is still the point, so secret-looking names are removed.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys

from circle.harness import sandbox_backend
from circle.sandbox import shell_environment


def test_secret_looking_names_are_removed_and_the_rest_kept():
    env = shell_environment({
        "PATH": "/venv/bin:/usr/bin", "HOME": "/Users/u", "PWD": "/w", "LANG": "zh_CN.UTF-8",
        "SSL_CERT_FILE": "/ca/bundle.pem", "SSH_AUTH_SOCK": "/tmp/agent", "CEX_PYTHON": "/venv/bin/python",
        "ANTHROPIC_API_KEY": "sk-x", "OPENAI_API_KEY": "sk-y", "ANTHROPIC_AUTH_TOKEN": "t",
        "GITHUB_TOKEN": "g", "AWS_SECRET_ACCESS_KEY": "a", "IST_JUMPHOST_PASS": "p", "SSHPASS": "p",
        "DB_PASSWORD": "p", "GOOGLE_APPLICATION_CREDENTIALS": "/c.json", "SESSION_COOKIE": "c",
        "TLS_PRIVATE_KEY_FILE": "/k", "KEYCHAIN_PATH": "/kc"})
    assert env == {"PATH": "/venv/bin:/usr/bin", "HOME": "/Users/u", "PWD": "/w", "LANG": "zh_CN.UTF-8",
                   "SSL_CERT_FILE": "/ca/bundle.pem", "SSH_AUTH_SOCK": "/tmp/agent",
                   "CEX_PYTHON": "/venv/bin/python", "KEYCHAIN_PATH": "/kc"}


def test_execute_sees_path_home_and_trust_but_no_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("VIRTUAL_ENV", raising=False)  # Circle's own venv: see the tests below
    monkeypatch.setenv("SSL_CERT_FILE", "/ca/bundle.pem")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    expected_path = str(tmp_path / "venv-bin") + os.pathsep + os.environ["PATH"]
    monkeypatch.setenv("PATH", expected_path)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    script = tmp_path / "inspect_environment.py"
    script.write_text('import json, os; print(json.dumps([os.environ.get(k, "") for k in '
                      '["HOME", "SSL_CERT_FILE", "PATH", "ANTHROPIC_API_KEY"]]))')
    argv = [sys.executable, str(script)]
    command = subprocess.list2cmdline(argv) if os.name == "nt" else shlex.join(argv)
    out = sandbox_backend(tmp_path).execute(command)
    assert out.exit_code == 0, out.output
    home, cert, path, key = json.loads(out.output.strip())
    assert home == str(tmp_path / "home") and cert == "/ca/bundle.pem" and path == expected_path
    assert key == ""


def test_circles_own_venv_is_not_the_projects(tmp_path):
    """Started from a shell with Circle's venv active, the model's python and pip would be
    Circle's: that venv leaves PATH and VIRTUAL_ENV goes."""
    own = os.path.join(sys.prefix, "Scripts" if os.name == "nt" else "bin")
    env = shell_environment({"VIRTUAL_ENV": sys.prefix, "VIRTUAL_ENV_PROMPT": "(circle)",
                             "PATH": os.pathsep.join([own, "/usr/local/bin", "/usr/bin"])},
                            workspace=tmp_path)
    assert env == {"PATH": os.pathsep.join(["/usr/local/bin", "/usr/bin"])}


def test_another_venv_or_one_inside_the_project_stays(tmp_path):
    other = {"VIRTUAL_ENV": str(tmp_path / "project-venv"),
             "PATH": os.pathsep.join([str(tmp_path / "project-venv" / "bin"), "/usr/bin"])}
    assert shell_environment(other, workspace=tmp_path) == other
    mine = {"VIRTUAL_ENV": sys.prefix, "PATH": os.pathsep.join([sys.prefix, "/usr/bin"])}
    # working on the folder the venv is in (Circle's own checkout): it is the project's venv
    assert shell_environment(mine, workspace=os.path.dirname(sys.prefix)) == mine
