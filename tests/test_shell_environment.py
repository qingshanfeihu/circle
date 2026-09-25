"""Commands the model runs get the user's environment minus secrets.

They used to run with an empty environment (inherit_env=False, no env): no HOME, the shell's
default PATH (so the user's venv python was ignored) and no SSL_CERT_FILE, which broke HTTPS to a
server behind a private CA (compile-excel's run_device.py: "server unreachable"). Keeping API keys
out of model-run commands is still the point, so secret-looking names are removed.
"""

from __future__ import annotations

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
    monkeypatch.setenv("SSL_CERT_FILE", "/ca/bundle.pem")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("PATH", "/opt/venv/bin:/usr/bin:/bin")
    out = sandbox_backend(tmp_path).execute(
        'printf "%s|%s|%s|%s" "$HOME" "$SSL_CERT_FILE" "$PATH" "$ANTHROPIC_API_KEY"')
    home, cert, path, key = str(getattr(out, "output", out)).strip().split("|")
    assert home and cert == "/ca/bundle.pem" and path.startswith("/opt/venv/bin")
    assert key == ""
