<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="Circle">
</p>

<h1 align="center">Circle</h1>

<p align="center">A terminal coding agent for your own model endpoint.</p>

<p align="center">
  <a href="docs/index.md">Docs</a> ·
  <a href="docs/quickstart.md">Quickstart</a> ·
  <a href="docs/known-issues.md">Known issues</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

Circle reads and edits the code in a folder you choose, and runs commands there. It works with any service or gateway that speaks the OpenAI or Anthropic API. It asks before it runs a command or changes a file, and the screen shows at a glance whether it is working or waiting for you.

**Circle is early software (0.2.1).** There is no operating-system sandbox, OAuth sign-in is not available, and sessions do not reopen after a restart. Read [Known issues](docs/known-issues.md) and [Run Circle safely](docs/security.md) before you point it at anything you care about.

## Install

Install a prebuilt release; no Python environment is needed.

**macOS** (Apple silicon or Intel):

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Linux** (x86_64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Windows** (x86_64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

The installers download the latest release for your platform, verify its SHA-256 and add Circle to your user PATH. macOS and Linux need `bash`, `curl`, `tar`, and `sha256sum` or `shasum`; Linux builds require glibc 2.35 or newer. Windows needs Windows 10 (1809) or newer and PowerShell 5.1 or newer. There is no native Windows ARM64 build; x86_64 emulation has not been verified.

Restart your terminal after installing, then run `circle`. Upgrade with `circle update`. If you have the old `v0.1.0` installation, close Circle and run the installer again once to switch to the new layout. See [Quickstart](docs/quickstart.md#1-install), [Releases](https://github.com/qingshanfeihu/circle/releases) and [Known issues](docs/known-issues.md#install-and-release). Windows console interaction still needs testing on a real machine.

## Run

```bash
cd ~/code/my-project
circle
```

The first time, Circle asks for a base URL, a key and a model, then asks you to trust the folder. After that, type a task and press `enter`. Type `/` to see the commands and `?` to see the keys.

The terminal interface uses conversation cards, status lamps and an `auto` theme that follows terminal colours. Use `/themes dark` or `/themes light` when your terminal cannot report its colours. See [The interface](docs/interface.md) for the signals and limits.

## Learn more

| | |
|---|---|
| [Quickstart](docs/quickstart.md) | Install, connect a model, run a first task. |
| [The interface](docs/interface.md) | What the lamps, tints and frame mean. |
| [Run Circle safely](docs/security.md) | What is asked, what is refused, what is not protected. |
| [Choose a model](docs/models.md) | Endpoints, switching, thinking depth. |
| [Skills](docs/skills.md), [Commands](docs/custom-commands.md), [MCP](docs/mcp.md), [Extensions](docs/extensions.md) | Make Circle yours. |
| [All documentation](docs/index.md) | Guides and reference. |

## Development

For a source or development installation, Python 3.11 or newer is required:

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
python -m pytest -q
```

On Windows, use `py -3 -m venv .venv` and `.venv\Scripts\Activate.ps1` in PowerShell. Code pushes do not publish a new version automatically: the release workflow runs when a `v*` tag is pushed. See [Releasing](docs/development/releasing.md).

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for coding agents, and the [architecture](docs/development/architecture.md). Report security problems as described in [SECURITY.md](SECURITY.md).

## License

No license has been chosen yet.
