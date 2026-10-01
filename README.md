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

**Circle is early software (0.2.0).** There is no operating-system sandbox, OAuth sign-in is not available, and sessions do not reopen after a restart. Read [Known issues](docs/known-issues.md) and [Run Circle safely](docs/security.md) before you point it at anything you care about.

## Install

Prebuilt packages need no Python installation. Choose your platform:

**macOS — Apple silicon (arm64)**

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/v0.2.0/install.sh | CIRCLE_VERSION=0.2.0 bash
```

**Linux — x86_64 (glibc, built on Ubuntu 22.04)**

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/v0.2.0/install.sh | CIRCLE_VERSION=0.2.0 bash
```

Version 0.2.0 provides these two packages. Windows, Intel Mac, Linux ARM64 and Alpine/musl are not supported by this release. See [Releases](https://github.com/qingshanfeihu/circle/releases/tag/v0.2.0) for the archives and checksums.

The installer puts `circle` in `~/.local/bin` and adds that directory to your shell configuration when needed. Reopen your terminal, then run `circle --version`. See the [Quickstart](docs/quickstart.md#1-install) for installation details and limitations.

## Run

```bash
cd ~/code/my-project
circle
```

The first time, Circle asks for a base URL, a key and a model, then asks you to trust the folder. After that, type a task and press `enter`. Type `/` to see the commands and `?` to see the keys.

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

Source development requires Python 3.11 or newer.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -e '.[dev]'
python -m pytest -q
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for coding agents, and the [architecture](docs/development/architecture.md). Report security problems as described in [SECURITY.md](SECURITY.md).

## License

No license has been chosen yet.
