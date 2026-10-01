# Changelog

All notable changes to Circle are listed here, newest first. Circle follows [Semantic Versioning](https://semver.org) once it reaches 1.0. Until then a minor version may change behaviour.

## Unreleased

## 0.2.1 - 2026-10-01

### Fixed

- The first command after initialization or workspace trust now reaches the main interface. The previous screen finishes its input reader before the session takes over the terminal.
- Ctrl+C cancels initialization, and cancellation restores the terminal and stops its input reader.

## 0.2.0 - 2026-10-01

### Added

- **`circle update`.** Installs the newest release: it downloads the file for your system, checks its sha256, unpacks it beside the running version and moves the `current` link. `--check` only reports, `--version X.Y.Z` installs a given release or goes back. See [Updating](docs/cli.md#updating).
- **Update reminder.** Once a day, when the full-screen interface starts, Circle checks GitHub for a newer release and says so in one line. Turn it off with `update_check` in settings or `CIRCLE_NO_UPDATE_CHECK=1`.
- **Windows.** The interface runs in the Windows console (Windows 10 1809 or newer), with an `install.ps1` installer and a Windows build in the release workflow. Interactive console behaviour still needs real-machine testing; see [Known issues](docs/known-issues.md#install-and-release). The approval rules understand `del`, `Remove-Item`, `cmd /c`, `powershell -Command` and `C:\path\.env`, and the system prompt tells the model its commands run in `cmd.exe`.
- **Releases for macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64)**, built by a workflow that runs the tests, freezes the program, starts a session in it, and publishes only if every platform passed. `python scripts/release.py X.Y.Z` prepares a release. See [Releasing](docs/development/releasing.md).
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

- **The installer** decides the operating system before it touches the network, finds the newest release without the GitHub API (so no rate limit), checks the sha256 of what it downloaded, and explains a certificate failure, a missing file for your platform and an unreachable network instead of printing curl's error. In a Windows shell (Git Bash, MobaXterm, Cygwin) it installs the Windows program through PowerShell. It keeps the newest versions in `versions/<version>` with a `current` link, so installing or updating never removes the copy that is running (a version that is already installed is left alone). The one exception is moving a `v0.1.0` install to this layout, which has to replace its `current` folder: run the installer once with Circle closed.
- Commands the model runs now inherit your environment with secret-looking variables removed, instead of an empty one.
- Models outside the built-in catalogue get a full output budget, and a reply that used the whole budget for thinking says so.
- Cancelling a turn is checked at every model and tool boundary, and a cancelled turn drains its queue in order.

### Fixed

- Model discovery uses only valid IDs returned by the server, reports empty or failed responses, and supports explicit manual configuration. API paths no longer omit or duplicate `/v1`, and the original host is preserved.
- Timer snapshots and UI actions share a lock, preventing a cancelled turn from deadlocking the next queued message.
- Checkpoints finish writing between agent steps, preventing stalled multi-step turns.
- Windows redirected output remains Unicode-safe in the prebuilt program.
- Windows host drive paths and expanded home paths work with filesystem tools while traversal checks remain enforced. Non-console output uses default terminal dimensions.
- Frozen builds include both provider integrations and package metadata. Native archives are installed and started offline before publication; all five archives must match the release commit and pass checksum verification.

- The release workflow could not succeed: it ran `pytest` without installing it, so no release was ever built by CI and the only release was uploaded by hand. It now installs the test extras and runs on a tag, and can be run by hand to rehearse a release.
- The prebuilt program did not include the prompt files the agent reads at start. The PyInstaller recipe now bundles them, and every module under `circle/`.
- `install.sh` ended with `tmp: unbound variable`: its cleanup ran after the function that owned the variable had returned.
- `/yolo` no longer drops an approval that arrives on the worker thread, and applies only to turns you can see.
- Approval policy is frozen for the length of a paused turn.
- Rebuilds of the MCP connection are refused while a turn is running.
- A stale context meter is cleared after a new session or a compaction.
- Reasoning text keeps its code fences when it is truncated, and expanded reasoning is cached per width and palette.
- Markdown emphasis boundaries and table delimiters render correctly.

## 0.1.0 - 2026-09-22

First release. A prebuilt binary for macOS on Apple silicon, an installer, a full-screen session built on a renderer modelled on Ink, and slash commands aligned with Pi and OpenCode.
