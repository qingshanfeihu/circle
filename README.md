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

**Circle is early software.** There is no operating-system sandbox and OAuth sign-in is not available. Read [Known issues](docs/known-issues.md) and [Run Circle safely](docs/security.md) before you point it at anything you care about.

## Install

Install a prebuilt release. It carries its own Node.js; nothing else needs to be installed first.

**macOS and Linux** (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

**Windows** (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

The installers download the latest release for your platform, verify its SHA-256, start it once, and put `circle` on your PATH. macOS and Linux need `bash`, `curl`, `tar`, and `sha256sum` or `shasum`. Windows needs PowerShell 5.1 or newer.

Restart your terminal after installing, then run `circle`. Upgrade with `circle update`. See [Installation and updates](docs/installation.md) and [Releases](https://github.com/qingshanfeihu/circle/releases).

**Coming from Circle 0.5.0 or older?** Those were written in Python. Run the install command above: it removes the Python version, keeps your settings, keys, skills and sessions, and installs 1.0 in its place. The old `circle update` cannot do this step. Python extensions have to be rewritten; see [Extensions](docs/extensions.md).

## Run

```bash
cd ~/code/my-project
circle
```

The first time, Circle asks for a base URL, a key and a model, then asks you to trust the folder. After that, type a task and press `enter`. Type `/` to see the commands and `?` to see the keys.

```bash
circle "fix the failing test"            # start with a message
circle -c                                # go on with the last conversation here
circle -r                                # pick a conversation from a list
circle -p "summarize README.md"          # one prompt, answer on stdout
git diff | circle -p "review this change"
```

While Circle works you can keep typing: `enter` steers the running turn. `esc` twice goes back to an earlier point of the conversation, `ctrl+l` switches models and `ctrl+f` finds text. The [CLI](docs/cli.md) also has a JSON event stream and an RPC mode for scripts and editors.

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

Circle is written in TypeScript and runs on Node.js 24 or newer. Up to 0.5.0 it was written in Python; that code is at the tag `v0.5.0`.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
npm ci
npm run check                                    # type check, tests, build
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

Code pushes do not publish a new version: the release workflow publishes when a `v*` tag is pushed. See [Releasing](docs/development/releasing.md).

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for coding agents, and the [architecture](docs/development/architecture.md). Report security problems as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Circle is released under the [MIT License](LICENSE). The model catalogs in `src/data/` carry metadata from models.dev under its own MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
