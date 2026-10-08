# Architecture

A map of the code for people who want to change it. For what Circle does, read [How Circle works](../how-circle-works.md) first.

Circle is a Python package, `circle/`. It assembles an agent from [deepagents](https://github.com/langchain-ai/deepagents), adds its own tools, middleware and safety policy, and runs it behind a terminal interface it renders itself.

## Layers

| Layer | Where | Job |
|---|---|---|
| Entry | `cli.py`, `__main__.py`, `main_session.py`, `headless.py`, `rpc.py`, `run_options.py` | Parse arguments, choose full-screen, print, JSON, RPC or line mode. `headless.py` runs turns without a screen, decides approvals by rule and emits the JSON events; `rpc.py` serves JSON commands; `run_options.py` carries what the command line chose for one run. |
| Updates | `update.py`, `net.py` | The daily release check and `circle update`. Shares its install layout with `install.sh` and `install.ps1`. `net.py` gives Circle's own HTTPS requests (model discovery, web fetch and search, updates) the system's certificates, or the bundled `certifi` ones where the system's cannot be found, as in the prebuilt program. |
| Setup | `init_flow.py`, `probe.py`, `oauth.py`, `trust.py`, `trust_flow.py`, `settings.py`, `paths.py`, `keybindings.py` | First run, endpoint probe, settings (yours and a project's) and credentials, workspace trust, your own keys. |
| Agent assembly | `harness.py`, `model.py`, `system_prompt.py`, `prompt_features.py`, `prompts/` | Build the model, the system prompt and the deepagents graph. |
| Tools | `sandbox.py`, `apply_patch.py`, `lsp_tool.py`, `websearch.py`, `secret_prompt.py`, `mcp_loader.py`, `skills.py`, `commands.py` | What the model can call, and what else Circle loads. |
| Safety | `approvals.py`, `plan_backend.py`, `trust.py` | Sort tool calls into allow, ask and refuse. Enforce read-only mode. |
| Middleware | `middleware/`, `model_guard.py`, `context_middleware.py`, `text_repetition.py`, `tool_recoverable.py` | Retries, stalls, loops, cancellation, repair of tool calls, redaction, pruning, summaries. |
| Sessions | `checkpoint_store.py`, `session_index.py`, `session_tree.py`, `events.py`, `session_export.py`, `git_info.py` | Persistent history in SQLite, the list of each folder's sessions (with titles, labels and the point `/tree` went back to), the message tree, the event bus, HTML and JSONL export. Messages written without a turn go through `context_middleware.append_messages`, so `/tree` can branch from them. |
| Extensions | `extensions.py` | The extension host. See [Build extensions](../extensions.md). |
| Interface | `tui/`, `ink/` | The full-screen interface. |

## The interface

`circle/ink/` is a small Python port of [Ink](https://github.com/vadimdemedes/ink), the terminal renderer: a tree of nodes, a layout pass, a screen buffer that is diffed and written as escape sequences, plus input parsing, selection and a set of components (`ink/components/`). `theme.py` is the only place colours are defined.

`circle/tui/` is the Circle interface built on it.

| Module | Job |
|---|---|
| `session_app.py` | The session screen: input, keys, commands, cards, mouse. The largest file. |
| `ink/termio/terminal.py`, `ink/termio/winconsole.py` | Raw input, output and window size. POSIX uses `termios`; Windows switches the console to escape-sequence input and output and reads and writes UTF-16. |
| `ink/escape_input.py` | Turns a lone ESC into the `esc` key after a short wait, on the setup screens and in the session. |
| `ink/theme.py`, `ink/theme_watch.py` | The palette, and the watcher that keeps it in step with the terminal's colours while the theme is `auto`. |
| `controllers.py` | Setup and trust: the questions, and the card each step shows in the session's frame before the session connects. |
| `ink/components/welcome.py` | The welcome block at the top of every session: the logo, the identity, what the folder brings, the recent sessions. |
| `harness_bridge.py` | Runs the agent graph on a worker thread and turns its stream into events. |
| `progress_handler.py`, `reducer.py`, `sink.py`, `message_model.py` | Events in, a snapshot of the conversation out. |
| `transcript_view.py`, `tool_display.py`, `content_blocks.py` | Draw the snapshot. |
| `replay.py` | Turn saved messages back into snapshots, for reopened, forked and cloned sessions; copy history into a new thread turn by turn. |
| `conversation_tree.py` | Read the conversation tree (every branch) from the checkpoints, for `/tree` and `/fork`. |
| `ink/components/picker.py` | The searchable list behind `/models`, `/effort`, `/resume`, `/tree`, `/fork` and `/settings`. |
| `agent_strip.py`, `agent_detail.py` | The subagent strip and record. |
| `slash_commands.py`, `input_history.py` | The command table and the history file. |

The rules for what is shown where are in [The TUI contract](tui-contract.md). Read them before you change anything on screen.

## A turn, in code

1. `session_app.py` takes your text and calls the bridge.
2. `harness_bridge.py` streams the graph. Middleware wraps every model and tool call.
3. Events flow through the reducer into a snapshot, and `transcript_view.py` draws it.
4. A gated tool call raises an interrupt. The bridge shows a card, waits for your answer, and resumes the graph with it.
5. When the turn ends, the checkpoint in `checkpoints.sqlite` holds the new state.

## Other files

| Path | What |
|---|---|
| `tests/` | The test suite. See [Contributing](../../CONTRIBUTING.md). |
| `scripts/` | `release.py`, `pack_release.py` and `smoke_frozen.py` run in the release workflow (see [Releasing](releasing.md)). The other files are manual and live drivers, not run in CI. |
| `packaging/circle.spec` | The PyInstaller recipe for release binaries. |
| `install.sh`, `install.ps1` | The installers attached to releases. They and `update.py` share one layout: `versions/<version>/` and a `current` link. Change the three together. |
| `.github/workflows/` | `check.yml` runs the tests on every push; `release.yml` builds, smoke-tests and publishes on a tag. |
| `circle_harness.py` | A compatibility shim that re-exports `circle.harness`. |
