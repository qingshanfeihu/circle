# Architecture

A map of the code for people who want to change it. For what Circle does, read [How Circle works](../how-circle-works.md) first.

Circle is a TypeScript program for Node.js 24, under `src/`, compiled with strict checks. The agent loop is its own: there is no LangChain, LangGraph or deepagents. Model access goes through the `openai` and `@anthropic-ai/sdk` packages, MCP through `@modelcontextprotocol/sdk`, and sessions are stored with `node:sqlite`.

## Entry points

| Module | What it does |
|---|---|
| `cli.ts` | Reads the command line (folder, `@files`, messages, options) and picks the full-screen interface, line mode, print mode, JSON events or RPC; also `circle update`. |
| `run_options.ts` | The options of one run that are not settings: tool limits, system prompt text, `--models` and the like. |
| `headless.ts` | Print mode, JSON events and line mode, and what they write to standard error. |
| `line_setup.ts` | Setup and the trust question asked line by line, for runs without the full-screen interface. |
| `rpc.ts`, `rpc_codec.ts` | RPC mode over standard input and output, and the messages and jobs as it sends them. |
| `exit_guard.ts` | Stops background jobs when the terminal closes or Circle is terminated. |

## The agent

| Module | What it does |
|---|---|
| `runtime.ts` | Puts a session together: the model, tools, MCP servers, extensions, policy, system prompt and session store. Switches, forks and imports sessions, and reloads integrations. |
| `harness.ts` | The loop: one model request, then the tool calls it asked for, until the model stops. Steering messages are read before the next request; follow-ups start a new turn when one ends. `task` calls next to each other run together, other calls one after another. |
| `system_prompt.ts` | Builds the system prompt from `prompts/`, the instruction files, skills, `SYSTEM.md` and `APPEND_SYSTEM.md`. |
| `memory_sources.ts` | Finds the instruction files (`AGENTS.md`, `CLAUDE.md` and the like) for a folder. |
| `skills.ts` | Finds skills in the user, project and `.agents/skills` folders and loads their text. |
| `commands.ts` | Custom commands: finds them and expands their templates. |
| `mentions.ts` | `@file` in a message: attaches the file, and completes paths for the input box. |
| `events.ts` | The event bus. A subscriber that throws cannot stop the agent. |
| `types.ts` | Messages, tool calls, usage and the tool contract. |
| `testing.ts` | `ScriptedModel`, the model the tests drive. |

## Models

| Module | What it does |
|---|---|
| `model.ts` | Talks to OpenAI-compatible and Anthropic-compatible endpoints and turns text, thinking, tool calls and usage into one form. |
| `model_guard.ts` | Retries by kind of failure, drops parameters an endpoint rejects, and catches stalled streams, repetition and a missing finish. |
| `text_repetition.ts` | Notices output that repeats itself, for `model_guard.ts`. |
| `tool_call_compat.ts` | Repairs tool names and arguments when the repair is unambiguous, and validates arguments before anything runs. |
| `model_media.ts`, `media.ts` | Images and PDFs: reading them, checking them and putting them into a request in each protocol's form. |
| `probe.ts` | Asks an endpoint for its models and works out its protocol and base URL, for setup and `/models`. |
| `model_catalog.ts` | Context windows and prices from models.dev: the snapshot in `data/models_dev.json.gz`, refreshed into the data folder once a day. |
| `model_profiles.ts` | Thinking depths and other capabilities per model, from `data/provider_profiles.json.gz`. |
| `model_scope.ts` | Which models `ctrl+p` goes through. |
| `pricing.ts` | The cost of each call and the totals the footer shows. |
| `compaction.ts` | The progress of a compaction and the line it leaves. |
| `context_middleware.ts` | What the model sees of a long session: large results kept in files, older messages summarized, and the originals read back when needed. |
| `middleware/` | Reminders added to a request: running and polled jobs (`job_notice.ts`), repeated tool calls (`loop_guard.ts`), the plan (`plan_tail.ts`), and pruning of old tool results (`tool_result_prune.ts`). |

## Tools and safety

| Module | What it does |
|---|---|
| `tools.ts` | The built-in tools: files, `execute`, `task`, `write_todos`, jobs, plan mode, `question`, the web, skills and compaction. `grep`, `apply_patch` and `lsp` have modules of their own. |
| `grep_tool.ts` | The `grep` tool: literal search, its output modes and limits. |
| `apply_patch.ts` | The `apply_patch` tool. |
| `file_read.ts` | Reads a window of lines without loading a whole file. |
| `lsp_tool.ts` | The `lsp` tool: language servers over standard input and output. |
| `websearch.ts` | `webfetch` and `websearch`. |
| `questions.ts` | The `question` tool and its answers. |
| `secret_prompt.ts` | Secret requests: the files a task and Circle exchange, and writing the value into its target file. |
| `approvals.ts` | Sorts commands and tool calls, keeps the session's rules and decides what needs your answer. |
| `sandbox.ts` | Resolves paths (including `/conversation_history/`, `/large_tool_results/` and `/background_jobs/`, which live in the data folder), refuses credential files, runs commands with secret variables stripped from their environment, and stops their process groups. It is a policy boundary, not an operating-system sandbox. |
| `redact.ts` | Hides passwords and tokens in command and job output. |
| `user_shell.ts` | Your own `!command` and `!!command`. |

## Sessions and data

| Module | What it does |
|---|---|
| `checkpoint_store.ts` | `circle.sqlite`: sessions, their messages as a tree of checkpoints, branches, labels and context versions. Stored messages are never rewritten. |
| `session_graph.ts` | Checks that a session's messages and branches fit together. |
| `session_export.ts` | `/export` and `--export`: Markdown, HTML and JSONL, and reading a JSONL export back. |
| `settings.ts` | `settings.json` and `credentials.json`: reading, project overrides in a trusted folder, and saving one change at a time. |
| `paths.ts` | The data folder and the paths inside it. |
| `keybindings.ts` | `keybindings.json`: the actions and their default keys. |
| `migration.ts`, `legacy_sessions.ts`, `legacy_codec.ts`, `legacy_message.ts` | Import of 0.5.0's `sessions.sqlite` and `checkpoints.sqlite`, read-only. See [Session data migration](migration-data.md). |
| `git_info.ts` | The folder's git branch. |

## Background work and integrations

| Module | What it does |
|---|---|
| `jobs.ts` | Background jobs: commands and subagents, their output files, their notices to the model, and stopping them. |
| `watch.ts` | `api.Watch`, which an extension tool returns to wait for something slow. |
| `mcp_loader.ts` | Connects MCP servers and offers their tools under the same policy as built-in ones. |
| `extensions.ts` | Loads extensions and what they register: tools, commands, middleware, renderers and event handlers. |
| `net.ts` | The proxy and certificate settings for every request Circle makes itself. |

## The terminal interface

`src/ink/` draws: it reads keys and terminal reports, builds the palette, and turns state into rows. `src/tui/` decides what is on screen and what a key does. The rules for both are in [The TUI contract](tui-contract.md).

| Module | What it does |
|---|---|
| `ink/parse_keypress.ts` | Turns terminal input into keys, pastes, mouse events and colour reports. |
| `ink/theme.ts` | The palette, built from the terminal's colours: text, tints, lamps and the rainbow. |
| `ink/theme_watch.ts` | Asks the terminal for its colours and follows a switch between dark and light. |
| `ink/screen.ts` | Writes only the rows that changed. |
| `ink/string_width.ts` | Display width, wrapping and cutting of text with colour codes. |
| `ink/selection.ts` | What a mouse selection covers on the painted screen. |
| `ink/clipboard.ts` | Copying: OSC 52, the system's clipboard tool and tmux's buffer. |
| `ink/components/dialog_card.ts` | The card in the input box's frame: title with its lamp, body, options, input row. |
| `ink/components/approval_card.ts`, `question_card.ts`, `secret_card.ts` | The approval, question and secret cards and their keys. |
| `ink/components/loop_frame.ts` | The input box's frame: rainbow, busy label and mode word. |
| `ink/components/picker.ts`, `popup.ts` | The lists above the input box, and the completion list's rows. |
| `ink/components/plan_panel.ts` | The plan box. |
| `ink/components/markdown_renderer.ts` | Markdown in answers, thinking and records. |
| `ink/components/welcome.ts` | The welcome block and its logo. |
| `tui/session_app.ts` | The full-screen session: input dispatch, cards, lists, the terminal's modes, and the commands that need its own state (`/models`, `/login`, `/reload`, `/editor`). |
| `tui/render.ts` | Lays out a frame: conversation, plan box, waiting messages, input box, footer and strip. |
| `tui/composer.ts` | The input box: editing, pastes, word keys, growth and the completion list. |
| `tui/input_history.ts` | The prompt history and `ctrl+r`. |
| `tui/slash_commands.ts` | The built-in commands, parsing, close matches, `/help` and `/hotkeys` text. |
| `tui/slash_handlers.ts` | What each built-in command does. |
| `tui/interaction_queue.ts` | One card at a time, the turn's own before a background agent's, none while you type. |
| `tui/approval_preview.ts` | What an approval card shows: the command, the file and its diff. |
| `tui/tool_rows.ts`, `tui/agent_rows.ts`, `tui/display_lexicon.ts` | Rows for tool calls, results, thinking and subagents, and the short names and phrases they use. |
| `tui/status_rows.ts` | The header, the busy label, the footer, the line under each turn, the compaction row and the window title. |
| `tui/strip_rows.ts` | The strip of subagents and jobs under the footer. |
| `tui/turn_status.ts` | Per-turn time, tokens and thinking time, from the event bus. |
| `tui/welcome_state.ts`, `tui/folder_inventory.ts` | What the welcome shows: the folder's own instruction files, skills, commands, extensions and settings, and its recent sessions. |
| `tui/subagents.ts` | Selecting a subagent in the strip and paging through records. |
| `tui/conversation_tree.ts` | The session as a tree, for `/tree` and `/fork`. |
| `tui/undo_history.ts` | What `/undo` and `/redo` put back on screen. |
| `tui/transcript_find.ts` | `ctrl+f`. |
| `tui/mouse_selection.ts` | Dragging, clicking and copying with the mouse. |
| `tui/external_editor.ts` | Which editor `/editor` runs. |
| `tui/exit_lines.ts` | What the terminal shows after Circle leaves: stopped jobs and the command that reopens the session. |

## Install and update

| Module | What it does |
|---|---|
| `install_layout.ts` | Release archives and the install folder: `versions/<version>/`, `current.ref`, `installation.json`, checksums and pruning. |
| `install_manager.ts` | Installs a release folder; run by `install.sh` and `install.ps1`. |
| `legacy_install.ts` | Finds and removes the Python circle (0.5.0 and older) before the first install. The data folder is left alone. |
| `update.ts` | The daily update reminder and `circle update`. |
| `version.ts` | The version and version comparison. |

`install.sh`, `install.ps1` and these modules share one layout; `tests/install-layout.test.ts`, `tests/legacy-install.test.ts` and `npm run release:smoke` pin it. See [Releasing](releasing.md).

## Other folders

- `src/prompts/`: the system prompts per model family, the tool descriptions, the subagent and summary prompts, and the `/init` template.
- `src/data/`: the models.dev snapshot and the provider profiles, compressed.
- `scripts/`: building and smoke-testing release packages, the release script, copying assets into `dist/`, and `port-status.ts` (see [The TypeScript port](migration.md)).
- `tests/`: one `*.test.ts` file per area, run with Node's test runner through `tsx`. They drive `ScriptedModel` or a local HTTP gateway and need no network.
