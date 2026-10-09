# Configuration

Circle is configured by files: a data folder for your account-level settings and resources, and folders inside each project for things that belong to that project.

## Where Circle keeps things

The data folder is `~/.circle`. Set `CIRCLE_HOME` to use another location, and run `circle --print-home` to see which one is in use. Circle 0.5.0 and older used the same folder, and what they left there carries over.

| Path | What it is |
|---|---|
| `settings.json` | Model, endpoint, trusted folders, MCP servers. See [Settings](settings.md). |
| `credentials.json` | Your API key. Readable only by you. |
| `history` | Your prompt history, last 1,000 messages. |
| `circle.sqlite` | Every session: its messages, branches and titles, for `/resume` and `circle -c`. See [Sessions](sessions.md). |
| `sessions.sqlite`, `checkpoints.sqlite`, `migration-backups/` | The sessions of 0.5.0 and older, which are imported into `circle.sqlite`, and a copy of what was imported. |
| `approvals/` | "Allow for this session" rules, one file per session. |
| `projects/<folder>-<id>/` | Per project: the messages a summary replaced (`conversation_history/`), tool output too long for the conversation (`large_tool_results/`), and the output of commands and [background jobs](background-jobs.md) (`background_jobs/`, one folder per run of Circle, removed a day after that run ended). |
| `cache/models-dev.json` | The copy of models.dev that context windows and prices come from. See [Models](models.md#cost-and-context-in-the-footer). |
| `update-check.json` | The answer of the daily [update check](cli.md#the-reminder). |
| `secret_requests/` | Requests for secrets waiting to be typed; each is removed once collected. |
| `exports/`, `shares/` | Output of `/export`, `/copy` (fallback) and `/share`. |
| `skills/` | Your [skills](skills.md). |
| `commands/`, `prompts/` | Your [custom commands](custom-commands.md). |
| `extensions/` | Your [extensions](extensions.md). |
| `AGENTS.md` and friends | Your personal [instruction files](#instruction-files). |
| `keybindings.json` | Your own keys for Circle's actions. See [Keyboard and mouse](keybindings.md#your-own-keys). |

Circle creates most of these when it first needs them. It keeps no log file.

## Instruction files

Instruction files tell Circle how to work: build commands, conventions, things to avoid. Circle reads them when a session opens and puts them in the system prompt, in this order:

| Where | Which files |
|---|---|
| The workspace, then each parent folder up to the git root | `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` (each up to 120,000 bytes) |
| The data folder | `AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `agents.md`, `memory/AGENTS.md` |
| Your home | `~/.agents/AGENTS.md`, `CLAUDE.md`, `MEMORY.md`, `agents.md`, and `~/.deepagents/AGENTS.md` |
| The workspace | `MEMORY.md`, `agents.md`, `.agent/AGENTS.md`, `.circle/AGENTS.md`, `.deepagents/AGENTS.md` |

If your workspace is itself the git root, or there is no git root above it, Circle keeps looking in the folders above it as far as the root of the disk, so a `CLAUDE.md` in your home folder can apply. Each file goes into the prompt once: a file reached under two names (as `AGENTS.md` and `agents.md` are on macOS) is read once.

Circle reads them again when you start a new session, open another one, or switch models.

To have Circle write a starting `AGENTS.md` for a project, run `/init`. It reads the repository and drafts one. Add a focus after it, for example `/init testing conventions`.

`circle --no-context-files` (`-nc`) leaves out every `AGENTS.md`, `AGENTS.override.md` and `CLAUDE.md` for one run. `MEMORY.md` is still read.

## System prompt

Circle's system prompt starts with its own instructions, then the instruction files, the environment (folder, platform, date) and anything appended. Two files in a project change it, the way pi's do:

| File | What it does |
|---|---|
| `.circle/SYSTEM.md` | Replaces Circle's own instructions and guidelines. The instruction files and the environment still follow. |
| `.circle/APPEND_SYSTEM.md` | Is added at the end of the prompt. |

They are read only in the project's `.circle/` folder; the data folder's are not read (see [Known issues](known-issues.md#configuration-and-skills)). On the command line, `--system-prompt` wins over `SYSTEM.md` and `--append-system-prompt` over `APPEND_SYSTEM.md`, for that run. See [CLI](cli.md#arguments-and-options).

Replacing the instructions also removes what they say about approvals, plans and tools, so the model may use its tools less well. Start from a copy of what you replace: Circle's own are in `src/prompts/session/` and `src/prompts/circle_guidelines.md` in its repository.

## Project folders

Inside a project, Circle looks in these folders. Circle works only in a folder you have [trusted](security.md#workspace-trust), and trusting it is what lets these apply.

| Folder | What |
|---|---|
| `.circle/skills`, `.agent/skills`, `.agents/skills` | Skills. See [Skills](skills.md) for all locations and their order. |
| `.circle/commands`, `.circle/prompts` | Custom commands |
| `.circle/extensions/<name>/extension.ts` (or `.mjs`, `.js`) | Extensions |
| `.circle/AGENTS.md`, `.agent/AGENTS.md` | Instructions |
| `.circle/SYSTEM.md`, `.circle/APPEND_SYSTEM.md` | The [system prompt](#system-prompt) for this project |
| `.circle/settings.json` | [Settings for this project](settings.md#project-settings) |

Trusting a folder writes nothing into it. The trusted folders are listed in `settings.json` in the data folder.

## Other tools' folders

Circle reads the folders of other agents, so what you set up once works in several tools: `.claude`, `.opencode`, `.pi` and `.agents` for skills, `.opencode` and `.pi` for commands. The exact list is in [Skills](skills.md#where-skills-live) and [Custom commands](custom-commands.md#where-commands-live).

## Reload

`/reload` re-reads `settings.json`, the project's settings, `keybindings.json` and the model credentials, reconnects MCP servers, reloads extensions, and rebuilds the model and the system prompt, which re-reads the instruction files. It does not re-read skills or `credential_files`. It is refused while a turn is running.
