# Known issues

This page lists what does not work as you might expect in the current version, with a way around each where there is one. It is written from the code and from running it, and it is updated as things are fixed.

## Install and release

- **Very old sessions can lose their installed files after several updates.** Cleanup keeps the newest three versions and the previously selected one; `circle update` also keeps the version its own process runs from. It does not track every other open session. Close sessions from older versions before repeatedly updating or reinstalling.
- **`circle update` and `install.ps1` do not start a new version before switching to it**, unlike `install.sh`. The first `circle` after them takes a few seconds longer, and a build that cannot start on your machine replaces the working one. To go back, run the installer again with `CIRCLE_VERSION` set to the old version.
- **Upgrading from `v0.1.0` needs the installer once.** That version only shipped for macOS on Apple silicon and has no `circle update`. Close Circle and run the current installer to migrate to the versioned layout; use `circle update` afterwards.
- **Windows console interaction still needs real-machine testing.** Automated tests exercise console modes, Unicode I/O and clipboard calls against stand-ins, command approvals, file locking, and the installer. Interactive drawing, keys, window resizing, `/copy` and user PATH changes still need checking in Windows Terminal, PowerShell and cmd. Windows ARM64 has no native build; running the x86_64 program under emulation is unverified.
- **On Windows `esc` does not stop a command that is running**, the model's or a `!command` of yours. It keeps going until it finishes or times out (120 seconds by default), and messages you send meanwhile wait for it.
- **On Windows the model's commands run in `cmd.exe`**, not in bash, and the system prompt says so. The approval rules recognise the common Windows delete, format and elevation commands, but they were written for a POSIX shell and are less tested against `cmd.exe` and PowerShell syntax. Read each command on the card.
- **On Windows `auto` theme cannot ask the console for its colours.** It falls back to `COLORFGBG`, then to dark. Set `/themes light` on a light terminal.
- **A terminal that is not a Windows console cannot show the full-screen interface.** MobaXterm, and the mintty window of Git Bash, are not consoles. Circle reports that the terminal is unsupported; use `circle --line` for line mode. Use Windows Terminal, PowerShell or cmd.

## Sign-in

- **OAuth sign-in is not available.** `/login` lists it as `not available yet`, and `/login anthropic|openai` fails unless `CIRCLE_OAUTH_MOCK=1` is set. Use an API URL and key. See [Choose a model](models.md).

## Sessions

- **Slow storage adds latency between agent steps.** Checkpoints finish writing synchronously to avoid stalled multi-step turns.
- **Going back with `/tree` does not undo file changes.** It changes what the model remembers, not your files.
- **The first `/tree` in a very long session takes a moment**, about three seconds after 200 turns with several tool calls each, because every turn's end is read once. Later opens read only what is new.
- **`/fork` and `/clone` copy only the messages**, not the plan or an earlier compaction. See [Sessions](sessions.md#what-does-not-carry-over).
- **`/undo` does not make the model forget, and does not revert files.**
- **`/yolo` turns itself off** on `/new`, `/fork`, `/clone`, `/import` and restart.
- **`projects/` in the data folder is never cleaned up.** It keeps the messages that summaries replaced and very long tool results, for every project. Delete old folders by hand.

## Safety

These are gaps to know about before you trust Circle with a repository or a machine you do not fully control. The complete list is in [Security](security.md#what-is-not-protected).

- **`/yolo` also skips the questions Circle always asks**, such as `rm -rf` and force-push.
- **Reading a credential file is not checked.** The shell rules protect `credentials.json` and `.env`, but `read_file` can read them. Use `credential_files` and keep secrets out of the workspace.
- **Custom commands can run shell snippets without asking**, and project commands and skills load before you have trusted the folder. Read a repository's `.circle/`, `.opencode/`, `.pi/` and `.claude/` folders before you open Circle there.
- **MCP tools never ask for approval** and are not stopped by `read-only` mode.
- **`apply_patch` and the approval check can disagree about a path.** A relative path such as `../x` can be written outside the workspace. Circle asks each time, so read the path on the card.
- **A secret can be written to any path the model names.** Check the file on the card before you enter the value.

## Input

- **`alt+enter` does not queue a follow-up** in most terminals, which send it as `shift+enter`. Use `ctrl+q`.
- **`CIRCLE_HISTORY_PATH` is ignored** in the full-screen interface. History is always in the data folder.
- **The `auto` theme cannot follow a terminal that does not answer colour queries**, as with some `ssh` and `tmux` setups. Set `/themes dark` or `/themes light`.
- **A theme change is picked up within about two seconds**, unless the terminal announces it, in which case it is immediate.

## Tools

- **`grep` searches for literal text, not regular expressions.** Its description says so and points the model to `rg` in the shell for a regular expression, which asks for approval like any command.

## MCP and extensions

- **MCP tools probably fail when the model calls them.** See [MCP servers](mcp.md).
- **If one MCP server fails, none of the tools load, and nothing tells you.** Look at `logs/circle.log`.
- **`/mcp reload` ignores changes to `settings.json`.** Use `/reload`.
- **`/plan` rebuilds the agent**, so MCP servers reconnect, which can take up to 30 seconds, and rejected-parameter workarounds are forgotten.

## Read-only mode

Any file whose name is `plan.md` or `plan` can be written in any folder. `edit_file` on it and `apply_patch` are still refused; only `write_file` works.

## Slow failures

If your endpoint is unreachable, a turn can take minutes to give up. Circle retries up to six times within about five minutes, and each try waits up to 45 seconds.
