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
| `sessions.sqlite` | Each folder's sessions, with their titles, for `/resume` and `circle -c`. |
| `approvals/` | "Allow for this session" rules, one file per session. |
| `projects/<folder>-<id>/` | Per project: the messages a summary replaced (`conversation_history/`), tool output too long for the conversation (`large_tool_results/`), and the output of [background jobs](background-jobs.md) (`background_jobs/`, one folder per run of Circle, removed a day after that run ended). |
| `logs/circle.log` | Log file, 5 MB and three older copies. Full-screen mode only. |
| `exports/`, `shares/` | Output of `/export`, `/copy` (fallback) and `/share`. |
| `skills/` | Your [skills](skills.md). |
| `commands/` | Your [custom commands](custom-commands.md). |
| `extensions/` | Your [extensions](extensions.md). |
| `AGENTS.md` and friends | Your personal [instruction files](#instruction-files). |
| `SYSTEM.md`, `APPEND_SYSTEM.md` | Replace or extend Circle's [system prompt](#system-prompt). |
| `keybindings.json` | Your own keys for Circle's actions. See [Keyboard and mouse](keybindings.md#your-own-keys). |

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

Circle can also edit these files itself when it learns something worth keeping. Each file goes into the prompt once: a file reached under two names (as `AGENTS.md` and `agents.md` are on macOS) is read once, and a project instruction file is not added again as memory.

`circle --no-context-files` (`-nc`) leaves out every `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` for one run. `MEMORY.md` is still read.

## System prompt

Circle's system prompt starts with its own instructions and tool list, then the instruction files, the environment (folder, platform, date) and anything appended. Two files change it, the way pi's do:

| File | What it does |
|---|---|
| `SYSTEM.md` | Replaces Circle's own instructions and tool list. The instruction files and the environment still follow. |
| `APPEND_SYSTEM.md` | Is added at the end of the prompt. |

Each is looked for in the project's `.circle/` folder first, then in the data folder; the first one found is used, and the two are not combined. On the command line, `--system-prompt` wins over `SYSTEM.md` and `--append-system-prompt` over `APPEND_SYSTEM.md`, for that run. See [CLI](cli.md#arguments-and-options).

Replacing the instructions also removes what they say about approvals, plans and tools, so the model may use its tools less well. Start from a copy of what you replace.

## Project folders

Inside a project, Circle looks in these folders. Everything except extensions is read whether or not you have trusted the project.

| Folder | What |
|---|---|
| `.circle/skills`, `.agent/skills`, `.agents/skills` | Skills. See [Skills](skills.md) for all locations and their order. |
| `.circle/commands` | Custom commands |
| `.circle/extensions/<name>/extension.py` | Extensions. Loaded only in a trusted project. |
| `.circle/AGENTS.md`, `.agent/AGENTS.md` | Instructions |
| `.circle/SYSTEM.md`, `.circle/APPEND_SYSTEM.md` | The [system prompt](#system-prompt) for this project |
| `.circle/settings.json` | [Settings for this project](settings.md#project-settings) |

Trusting a folder writes nothing into it. The trusted folders are listed in `settings.json` in the data folder.

## Other tools' folders

Circle reads the folders of other agents, so what you set up once works in several tools: `.claude`, `.opencode`, `.pi` and `.agents` for skills, `.opencode` and `.pi` for commands. The exact list is in [Skills](skills.md#where-skills-live) and [Custom commands](custom-commands.md#where-commands-live).

## Reload

`/reload` re-reads the settings and the model credentials, reloads extensions, and rebuilds the agent, which reconnects MCP servers and re-reads skills and instruction files. It does not apply changes to `credential_files`. It waits until the current turn ends.
