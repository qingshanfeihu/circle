# Configuration

Circle is configured by files: a data folder for your account-level settings and resources, and folders inside each project for things that belong to that project.

## Where Circle keeps things

The data folder is `~/.circle`. Set `CIRCLE_HOME` to use another location, and run `circle --print-home` to see which one is in use.

| Path | What it is |
|---|---|
| `settings.json` | Model, endpoint, trusted folders, MCP servers. See [Settings](settings.md). |
| `credentials.json` | Your API key. Readable only by you. |
| `history` | Your prompt history, last 1,000 messages. |
| `checkpoints.sqlite` | The model's history for each session. |
| `approvals/` | "Allow for this session" rules, one file per session. |
| `logs/circle.log` | Log file, 5 MB and three older copies. Full-screen mode only. |
| `exports/`, `shares/` | Output of `/export`, `/copy` (fallback) and `/share`. |
| `skills/` | Your [skills](skills.md). |
| `commands/` | Your [custom commands](custom-commands.md). |
| `extensions/` | Your [extensions](extensions.md). |
| `AGENTS.md` and friends | Your personal [instruction files](#instruction-files). |

Circle creates most of these when it first needs them.

## Instruction files

Instruction files tell Circle how to work: build commands, conventions, things to avoid. Circle reads them at the start of a session and puts them in the system prompt.

It looks in these places:

| Where | Which files |
|---|---|
| The workspace and each parent folder up to the git root | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` (each up to 120,000 bytes) |
| The workspace | `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `agents.md`, `.agent/AGENTS.md`, `.circle/AGENTS.md`, `.deepagents/AGENTS.md` |
| Your home | `~/.agents/AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `agents.md`, and `~/.deepagents/AGENTS.md` |
| The data folder | `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `agents.md`, `memory/AGENTS.md` |

Later files in that order take priority. If your workspace is itself the git root, Circle keeps looking in the folders above it as well, so a `CLAUDE.md` in your home folder can apply.

To have Circle write a starting `AGENTS.md` for a project, run `/init`. It reads the repository and drafts one. Add a focus after it, for example `/init testing conventions`.

Circle can also edit these files itself when it learns something worth keeping. On macOS the same `AGENTS.md` can end up in the prompt more than once; see [Known issues](known-issues.md).

## Project folders

Inside a project, Circle looks in these folders. Everything except extensions is read whether or not you have trusted the project.

| Folder | What |
|---|---|
| `.circle/skills`, `.agent/skills`, `.agents/skills` | Skills. See [Skills](skills.md) for all locations and their order. |
| `.circle/commands` | Custom commands |
| `.circle/extensions/<name>/extension.py` | Extensions. Loaded only in a trusted project. |
| `.circle/AGENTS.md`, `.agent/AGENTS.md` | Instructions |

When you trust a folder, Circle creates `.agent/` with a `README.md` and a `settings.json`. Nothing reads those two files yet.

## Other tools' folders

Circle reads the folders of other agents, so what you set up once works in several tools: `.claude`, `.opencode`, `.pi` and `.agents` for skills, `.opencode` and `.pi` for commands. The exact list is in [Skills](skills.md#where-skills-live) and [Custom commands](custom-commands.md#where-commands-live).

## Reload

`/reload` re-reads the settings and the model credentials, reloads extensions, and rebuilds the agent, which reconnects MCP servers and re-reads skills and instruction files. It does not apply changes to `credential_files`. It waits until the current turn ends.
