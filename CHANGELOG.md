# Changelog

All notable changes to Circle are listed here, newest first. Circle follows [Semantic Versioning](https://semver.org) once it reaches 1.0. Until then a minor version may change behaviour.

## Unreleased

### Added

- **Interface contract.** One set of rules decides where each piece of information appears: conversation, persistent lines, plan box, the input box that turns into a card, popup, page, or a one-second flash. Lamps show state, tints show the kind of work, and the frame shows whose turn it is. See [The interface](docs/interface.md).
- **Dark and light terminals.** Secondary text and the rainbow frame keep a readable contrast on any background. The `auto` theme follows the terminal while Circle runs, so a switch between a dark and a light theme is picked up without a restart. `/themes auto|dark|light` chooses. See [Dark and light terminals](docs/interface.md#dark-and-light-terminals).
- **Skills.** Agent Skills discovery, the `skill` tool and `/skill`.
- **MCP servers**, plan-mode write gates, more tools and a session tree.
- **Extensions.** Python modules that register tools, commands, middleware, subagents, result renderers and event handlers.
- **Approvals.** Commands are sorted into allow, ask and refuse. "Always allow" is remembered per session and managed with `/approvals`.
- **Auto mode.** `/yolo` (`/auto`) stops asking for the current session.
- **Model guard.** Retries with backoff and `Retry-After`, dropping a parameter the endpoint rejects, detection of stalled or repeating streams, and thinking depth chosen by model family.
- **Reliability middleware.** Tool errors return to the model instead of ending the turn, wrong-case tool names and argument shapes are repaired, loops are interrupted, and old tool output is shortened in requests.
- **Secrets.** The model can ask for a secret with `question`. You enter it masked with `ctrl+s`, and it is written to a file without entering the conversation.
- **Plan box, subagent strip and record, live footer meters, file diffs**, and rendering of GFM tables and task lists.
- `websearch`, and `~` expansion in file paths.
- New documentation in `docs/`, `CONTRIBUTING.md`, `AGENTS.md` and `SECURITY.md`.

### Changed

- Commands the model runs now inherit your environment with secret-looking variables removed, instead of an empty one.
- Models outside the built-in catalogue get a full output budget, and a reply that used the whole budget for thinking says so.
- Cancelling a turn is checked at every model and tool boundary, and a cancelled turn drains its queue in order.

### Fixed

- `/yolo` no longer drops an approval that arrives on the worker thread, and applies only to turns you can see.
- Approval policy is frozen for the length of a paused turn.
- Rebuilds of the MCP connection are refused while a turn is running.
- A stale context meter is cleared after a new session or a compaction.
- Reasoning text keeps its code fences when it is truncated, and expanded reasoning is cached per width and palette.
- Markdown emphasis boundaries and table delimiters render correctly.

## 0.1.0 - 2026-09-22

First release. A prebuilt binary for macOS on Apple silicon, an installer, a full-screen session built on a renderer modelled on Ink, and slash commands aligned with Pi and OpenCode.
