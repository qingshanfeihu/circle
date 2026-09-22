# Circle

Compile harness with a **zero-Python** install path.

## Install (release)

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

CI builds **PyInstaller onedir** assets per platform and attaches them to the GitHub Release. `install.sh` downloads the matching archive into `~/.local/share/circle` and links `~/.local/bin/circle`.

## First run

```bash
.venv311/bin/circle                 # or: circle /path/to/project
```

1. **User init** (once): API URL+KEY *or* OAuth → probe → model → `~/.circle/settings.json`
2. **Trust workspace**: confirm → `.agent/`
3. **Main session**: InfoTest-style ink shell（transcript + prompt + footer + 权限面板 + 流式刷新），沙箱根 = 已 trust 目录

Headless selftest:

```bash
.venv311/bin/pytest -q
CIRCLE_OAUTH_MOCK=1 .venv311/bin/python scripts/selftest_tui_demo.py
```

## Dev

```bash
python3.11 -m venv .venv311
source .venv311/bin/activate
pip install -r requirements.txt
pip install -e .
pytest -q
./install.sh --from-source   # editable entry on PATH
```

## Layout

| Path | Role |
|------|------|
| `~/.circle/settings.json` | User settings (model, trusted folders) |
| `~/.circle/credentials.json` | Secrets (0600) |
| `<project>/.agent/` | Project agent files (after trust) |
| `CIRCLE_HOME` | Override user home (tests / custom) |
