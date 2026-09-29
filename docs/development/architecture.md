# Architecture

A map of the code for people who want to change it. For what Circle does, read [How Circle works](../how-circle-works.md) first.

Circle is a Python package, `circle/`. It assembles an agent from [deepagents](https://github.com/langchain-ai/deepagents), adds its own tools, middleware and safety policy, and runs it behind a terminal interface it renders itself.

## Layers

| Layer | Where | Job |
|---|---|---|
| Entry | `cli.py`, `__main__.py`, `main_session.py` | Parse arguments, choose full-screen or line mode. |
| Setup | `init_flow.py`, `probe.py`, `oauth.py`, `trust.py`, `trust_flow.py`, `settings.py`, `paths.py` | First run, endpoint probe, settings and credentials, workspace trust. |
| Agent assembly | `harness.py`, `model.py`, `system_prompt.py`, `prompt_features.py`, `prompts/` | Build the model, the system prompt and the deepagents graph. |
| Tools | `sandbox.py`, `apply_patch.py`, `lsp_tool.py`, `websearch.py`, `secret_prompt.py`, `mcp_loader.py`, `skills.py`, `commands.py` | What the model can call, and what else Circle loads. |
| Safety | `approvals.py`, `plan_backend.py`, `trust.py` | Sort tool calls into allow, ask and refuse. Enforce read-only mode. |
| Middleware | `middleware/`, `model_guard.py`, `context_middleware.py`, `text_repetition.py`, `tool_recoverable.py` | Retries, stalls, loops, cancellation, repair of tool calls, redaction, pruning, summaries. |
| Sessions | `checkpoint_store.py`, `session_tree.py`, `events.py` | Persistent history in SQLite, the message tree, the event bus. |
| Extensions | `extensions.py` | The extension host. See [Build extensions](../extensions.md). |
| Interface | `tui/`, `ink/` | The full-screen interface. |

## The interface

`circle/ink/` is a small Python port of [Ink](https://github.com/vadimdemedes/ink), the terminal renderer: a tree of nodes, a layout pass, a screen buffer that is diffed and written as escape sequences, plus input parsing, selection and a set of components (`ink/components/`). `theme.py` is the only place colours are defined.

`circle/tui/` is the Circle interface built on it.

| Module | Job |
|---|---|
| `session_app.py` | The session screen: input, keys, commands, cards, mouse. The largest file. |
| `ink/theme.py`, `ink/theme_watch.py` | The palette, and the watcher that keeps it in step with the terminal's colours while the theme is `auto`. |
| `app.py`, `controllers.py` | The setup and trust screens shown before a session. |
| `harness_bridge.py` | Runs the agent graph on a worker thread and turns its stream into events. |
| `progress_handler.py`, `reducer.py`, `sink.py`, `message_model.py` | Events in, a snapshot of the conversation out. |
| `transcript_view.py`, `tool_display.py`, `content_blocks.py` | Draw the snapshot. |
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
| `scripts/` | Manual and live drivers. Not run in CI. |
| `packaging/circle.spec` | The PyInstaller recipe for release binaries. |
| `install.sh` | The installer attached to releases. |
| `circle_harness.py` | A compatibility shim that re-exports `circle.harness`. |
