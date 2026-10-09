# Known issues

This page lists what does not work as you might expect in the current version, with a way around each where there is one. It is written from the code and from running it, and it is updated as things are fixed.

## Install and release

- **No release of this version is published yet.** The newest release is the Python 0.5.0, so the one-command installers stop with an error until 1.0.0 is published, and change nothing. See [Installation](installation.md).
- **Very old sessions can lose their installed files after several updates.** An installation keeps the newest three versions and the one it replaced. It does not track every other open session. Close sessions from older versions before repeatedly updating or reinstalling.
- **The Windows build has not been tried in a real console.** The release workflow builds it for x64 and arm64 and tests installing it, starting it and a scripted run. The full-screen interface, keys, window resizing, `/copy` and the user `PATH` change still need checking in Windows Terminal, PowerShell and cmd. A terminal window that is not a Windows console, such as the mintty window of Git Bash or MobaXterm, may not count as a terminal; use Windows Terminal, PowerShell or cmd.
- **Stopping commands on Windows has not been tried on a real machine.** `esc`, `ctrl+b`, a timeout, `/jobs` and leaving end a command with `taskkill /T /F`. Processes a command leaves running are not turned into a [background job](background-jobs.md) on Windows: Circle cannot see them.
- **On Windows the model's commands run in `cmd.exe`**, not in bash. The approval rules recognise the common Windows delete, format and elevation commands, but they were written for a POSIX shell and are less tested against `cmd.exe` and PowerShell syntax. Read each command on the card.
- **Circle does not read `HTTPS_PROXY` or `SSL_CERT_FILE` for its own requests** (the model, model lists, models.dev, `webfetch`, `websearch`, the update check and `circle update`). On a network that replaces HTTPS certificates, start Circle with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`, which the Node.js it runs on reads. The installers do use `HTTPS_PROXY` and `CURL_CA_BUNDLE`.

## Setup and sign-in

- **OAuth sign-in is not available.** `/login` lists it as `not available yet`, and `/login anthropic|openai` says the same. Use an API URL and key. See [Choose a model](models.md#oauth).
- **Setup in the full-screen interface saves the base URL as you typed it.** When an OpenAI-style endpoint answered only at `<url>/v1`, model requests then go to `<url>` and fail. Type the URL with `/v1`, or fix `auth.base_url` in [settings](settings.md). Setup in line mode saves the URL that answered.

## Sessions

- **Going back with `/tree` does not undo file changes.** It changes what the model remembers, not your files.
- **`/undo` does not make the model forget, and does not revert files.**
- **`/yolo` turns itself off** on `/new`, `/fork`, `/clone`, `/import` and restart.
- **`projects/` in the data folder is mostly not cleaned up.** It keeps the messages that summaries replaced and very long tool results, for every project; only command and job output is removed, a day after its run ended. Delete old folders by hand.
- **Circle 0.5.0 cannot import the JSONL exports of this version.** This version imports 0.5.0's.
- **Leaving does not print the command that reopens the session**, as 0.5.0 did. Use `circle -c`, or `circle -r` to pick one.

## Safety

These are gaps to know about before you trust Circle with a repository or a machine you do not fully control. The complete list is in [Security](security.md#what-is-not-protected).

- **`/yolo` also skips the questions Circle always asks**, such as `rm -rf` and force-push.
- **Custom commands can run shell snippets without asking**, and a trusted folder's commands, skills and instruction files apply at once. Read a repository's `.circle/`, `.opencode/`, `.pi/`, `.claude/` and `.agents/` folders before you trust it.
- **The credential-file check reads names, not contents.** File tools and commands refuse the listed names, but `ls` and `glob` show them, and a command that reaches a file without naming it (a script, a variable, a copy under another name) is not refused.
- **A secret can be written to any path the model names.** Check the file on the card before you enter the value.

## Subagents and tools

- **Several `task` calls in one reply run one after another**, not at the same time as in 0.5.0. To run subagents side by side, the model can start them with `background: true`.
- **`grep` searches for literal text, not regular expressions.** Its description says so and points the model to `rg` in the shell for a regular expression, which asks for approval like any command.

## Background jobs

- **A process that leaves its process group is not tracked.** `setsid`, a daemon that detaches, or a program that starts a service elsewhere is not part of the job: stopping the job, or leaving Circle, does not stop it.
- **If Circle is killed with `SIGKILL`, or crashes, its jobs keep running.** Find them with `ps` and stop them yourself.
- **Jobs do not outlive Circle.** A reopened session has none running; the note Circle leaves names the ones that were stopped (not after `SIGTERM`, `SIGHUP` or a closed terminal window).
- **A background subagent keeps the agent it started with.** After `/reload`, `/models` or a change of extensions it still uses the old tools and model until it ends; `/plan` reaches it.
- **The output a dev server prints may not show on its row**: many programs keep their output in a buffer when it does not go to a terminal (`python3 -u` and `PYTHONUNBUFFERED=1` help for Python).

## Configuration and skills

- **`SYSTEM.md` and `APPEND_SYSTEM.md` in the data folder are not read.** Only the project's `.circle/SYSTEM.md` and `.circle/APPEND_SYSTEM.md` are. For every project, use `--system-prompt` or `--append-system-prompt`. See [System prompt](configuration.md#system-prompt).
- **Skills are read once, when Circle starts.** A skill added or changed later can be loaded with `/skill <name>`, but the model's list and its `skill` tool see it only after a restart.
- **Switching models drops the skill list from the system prompt.** After `/models`, `ctrl+p`, `/login` or `/reload`, the model no longer sees which skills exist until the next `/new`, `/resume` or restart; `/skill <name>` still works.

## MCP and extensions

- **An MCP server name other than letters, digits, `_` and `-` (up to 32 characters) stops the full-screen interface from starting**, and makes `/reload` fail. 0.5.0 took any name. Rename the server in `settings.json`.
- **An MCP tool call is stopped after 30 seconds.**
- **`/mcp reload` and `/extensions reload` repeat the list of extension tools in the system prompt** each time they run. The tools themselves are not affected.

## Keys

- **`esc` drops the messages still waiting to be read**, where 0.5.0 sent them as the next turns. Take them back with `alt+↑` before you stop the turn.
- **`ctrl+z` does not suspend Circle, and `ctrl+c` twice on an empty box does not leave it**, although `/hotkeys` lists both. Use `ctrl+d` or `/exit` to leave.

## Read-only mode

Any file whose name is `plan.md` or `plan` can be written, edited or deleted in any folder, with the usual approval. Everything else that changes something is refused.

## Slow failures

If your endpoint is unreachable, a turn can take minutes to give up. Circle retries up to six times within about five minutes, and each try waits up to 45 seconds.
