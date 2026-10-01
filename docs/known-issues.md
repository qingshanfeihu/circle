# Known issues

This page lists what does not work as you might expect in the current version, with a way around each where there is one. It is written from the code and from running it, and it is updated as things are fixed.

## Install and release

- **Upgrading from `v0.1.0` needs the installer once.** That version only shipped for macOS on Apple silicon and has no `circle update`. Close Circle and run the current installer to migrate to the versioned layout; use `circle update` afterwards.
- **Windows console interaction still needs real-machine testing.** Automated tests exercise console modes, Unicode I/O and clipboard calls against stand-ins, command approvals, file locking, and the installer. Interactive drawing, keys, window resizing, `/copy` and user PATH changes still need checking in Windows Terminal, PowerShell and cmd. Windows ARM64 has no native build; running the x86_64 program under emulation is unverified.
- **On Windows the model's commands run in `cmd.exe`**, not in bash, and the system prompt says so. The approval rules recognise the common Windows delete, format and elevation commands, but they were written for a POSIX shell and are less tested against `cmd.exe` and PowerShell syntax. Read each command on the card.
- **On Windows `auto` theme cannot ask the console for its colours.** It falls back to `COLORFGBG`, then to dark. Set `/themes light` on a light terminal.
- **A terminal that is not a Windows console cannot show the full-screen interface.** MobaXterm, and the mintty window of Git Bash, are not consoles. Circle reports that the terminal is unsupported; use `circle --line` for line mode. Use Windows Terminal, PowerShell or cmd.

## Sign-in

- **OAuth sign-in is not available.** `/login` fails unless `CIRCLE_OAUTH_MOCK=1` is set. Use an API URL and key. See [Choose a model](models.md).
- **`circle --init` erases your settings**, including `mcp_servers` and `credential_files`. Keep a copy of `settings.json` first.

## Sessions

- **Restarting forgets the session list.** The conversation is still stored in `checkpoints.sqlite`, but nothing in the interface reopens it. See [Sessions](sessions.md#what-does-not-carry-over).
- **`/fork` and `/clone` start the model with no history.** The earlier messages show on screen, but the model does not have them. Work around it by asking Circle to recap the state, or by starting a fresh session with `/import` of an export.
- **`/tree <id>` does not rewind the model.** It moves a marker on screen.
- **`/undo` does not make the model forget, and does not revert files.**
- **`/yolo` turns itself off** on `/new`, `/fork`, `/clone`, `/import` and restart.

## Safety

These are gaps to know about before you trust Circle with a repository or a machine you do not fully control. The complete list is in [Security](security.md#what-is-not-protected).

- **`/yolo` also skips the questions Circle always asks**, such as `rm -rf` and force-push.
- **Reading a credential file is not checked.** The shell rules protect `credentials.json` and `.env`, but `read_file` can read them. Use `credential_files` and keep secrets out of the workspace.
- **Custom commands can run shell snippets without asking**, and project commands and skills load before you have trusted the folder. Read a repository's `.circle/`, `.opencode/`, `.pi/` and `.claude/` folders before you open Circle there.
- **MCP tools never ask for approval** and are not stopped by `read-only` mode.
- **`apply_patch` and the approval check can disagree about a path.** A relative path such as `../x` can be written outside the workspace. Circle asks each time, so read the path on the card.
- **`esc` does not stop a shell command that is running.** It keeps going until it finishes or times out (120 seconds by default), and messages you queued wait for it.
- **A secret can be written to any path the model names.** Check the file on the card before you enter the value.

## Input

- **A long paste reaches the model as `[Pasted text #1 +9 lines]`**, not as the text. Line breaks in shorter pastes reach it as `↵`. To send a long text, save it in a file and ask Circle to read it, or use `/editor`.
- **`alt+enter` does not queue a follow-up.** Terminals send it as `shift+enter`.
- **`$10` in a custom command is `$1` followed by `0`.** Only `$1` to `$9` work.
- **`/editor` fails if `$EDITOR` has arguments**, for example `code -w`. Point it at a script that adds them.
- **`CIRCLE_HISTORY_PATH` is ignored** in the full-screen interface. History is always in the data folder.
- **The `auto` theme cannot follow a terminal that does not answer colour queries**, as with some `ssh` and `tmux` setups. Set `/themes dark` or `/themes light`.
- **A theme change is picked up within about two seconds**, unless the terminal announces it, in which case it is immediate.

## Tools

- **`grep` searches for literal text, not regular expressions,** although its description tells the model it supports regex. A pattern like `log.*Error` finds nothing. Ask for a literal string.
- **Several tool descriptions do not match how the tools work.** Circle repairs most misspelt argument names, but not the regular expression case above.
- **Circle writes into your project.** Automatic summaries go to `conversation_history/` and long results to `large_tool_results/`. Add both to `.gitignore`.
- **On a case-insensitive file system, `AGENTS.md` can appear in the prompt more than once**, which wastes context. This is the default on macOS.

## MCP and extensions

- **MCP tools probably fail when the model calls them.** See [MCP servers](mcp.md).
- **If one MCP server fails, none of the tools load, and nothing tells you.** Look at `logs/circle.log`.
- **`/mcp reload` ignores changes to `settings.json`.** Use `/reload`.
- **`/mcp` and `/extensions` print Chinese**, unlike the rest of the interface.
- **`/plan` rebuilds the agent**, so MCP servers reconnect, which can take up to 30 seconds, and rejected-parameter workarounds are forgotten.

## Read-only mode

Any file whose name is `plan.md` or `plan` can be written in any folder. `edit_file` on it and `apply_patch` are still refused; only `write_file` works.

## Slow failures

If your endpoint is unreachable, a turn can take minutes to give up. Circle retries up to six times within about five minutes, and each try waits up to 45 seconds.
