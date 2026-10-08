# CLI

Circle has one command, `circle`, and one subcommand, `circle update`. Without options `circle` opens the full-screen interface in a folder you choose. With `-p` it runs a prompt and prints the answer.

```bash
circle [options] [folder] [@file ...] [message ...]
circle -p "prompt" [folder]
```

## Folder, messages and files

The words after `circle` are a folder, files and messages, in any order of options:

- **The folder** Circle works in comes first. It defaults to the current folder. `~` is expanded and symlinks are resolved. It does not have to be a git repository. A first word without spaces is always read as a folder, so a mistyped folder name is an error and not a message. A message of one word goes after the folder: `circle . refactor`.
- **Messages** are sent when the session opens, one turn each, in order. A message with spaces needs quotes. `circle "fix the failing test"` works in the current folder; `circle "fix it" ~/code/app` works too.
- **`@path`** adds a text file to the first message, as `<file path="…">` after it. The path is looked for in the current folder, then in the folder Circle works in. A file that is missing or not text is an error. The conversation on screen shows `@path`; the model gets the text.
- **`--`** ends the options, so a message can start with `-`.

```bash
circle ~/code/app "explain how the router works" @src/router.py
circle -p "review this" @src/app.py "now list the risks"
```

## Arguments and options

| Argument | What it does |
|---|---|
| `-p`, `--print [PROMPT]` | Send the prompt, and any messages after it, one turn each; write the last answer to standard output and exit. See [Print mode](#print-mode). |
| `--mode json` | Like `-p`, but write every step to standard output as one JSON object per line. See [JSON events](#json-events). |
| `--mode rpc` | Run as a child process driven by JSON commands on standard input, until it closes. See [RPC mode](#rpc-mode). |
| `-c`, `--continue` | Go on with the most recent conversation in this folder. Works with the full-screen interface, `-p` and `--line`. See [Sessions](sessions.md). |
| `-r`, `--resume` | Choose a saved conversation from a list, then open it. Full-screen interface only. See [Sessions](sessions.md#pick-a-session). |
| `--session ID` | Reopen a saved conversation by its id, or by the end of it when only one matches. `/resume` lists the ids. |
| `--session-id ID` | Open the conversation whose id is exactly `ID`, or start a new one with that id. An id is letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. Useful in scripts that come back to the same conversation. |
| `--fork ID` | Start a new conversation in this folder with a copy of a saved one, from any folder. The original is not changed. Combine with `--session-id` to choose the new id. |
| `--no-session` | Keep the conversation in memory only. It is not saved and not listed in `/resume`. |
| `-n`, `--name NAME` | Give the conversation a title, as `/name` does. |
| `-m`, `--model NAME` | Use this model id for this run. It is not saved; `ctrl+s` in `/models` inside a session saves one. |
| `--thinking LEVEL` | The thinking depth for this run: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. See [Models](models.md#thinking-depth). |
| `--models PATTERNS` | The models `ctrl+p` switches between in this run, comma-separated, such as `step-3.7-flash,step-5-*`. In place of `enabled_models` in [settings](settings.md). |
| `--export ID [FILE]` | Write a saved conversation as HTML, or as JSONL when `FILE` ends in `.jsonl`, and exit. `FILE` defaults to `<id>.html` in the current folder. See [Sessions](sessions.md#export-and-import). |
| `--list-models [SEARCH]` | Print the models the endpoint offers and exit. With words, only the models that contain all of them. The current model is marked `(current)`. |
| `--system-prompt TEXT\|FILE` | Replace Circle's own instructions with this text, or with the file's text when it names a file. The project's `AGENTS.md`, the environment and anything appended still follow. See [Configuration](configuration.md#system-prompt). |
| `--append-system-prompt TEXT\|FILE` | Add this text, or the file's text, to the end of the system prompt. Can be given more than once. Replaces `APPEND_SYSTEM.md` for this run. |
| `-nc`, `--no-context-files` | Do not read `AGENTS.md` or `CLAUDE.md`, in the project or elsewhere. |
| `-t`, `--tools LIST` | The model gets only these tools, comma-separated. pi's names work too: `read`, `write`, `edit`, `bash` and `find` mean `read_file`, `write_file`, `edit_file`, `execute` and `glob`. |
| `-xt`, `--exclude-tools LIST` | The model does not get these tools. |
| `-nt`, `--no-tools` | The model gets no tools. |
| `--yolo` | With `-p` or `--line`: run commands and file changes without asking. See [Print mode](#print-mode). |
| `--verbose` | With `-p` or `--line`: show each tool call, retries and the tokens used on standard error. |
| `-v`, `--version` | Print the version and exit. |
| `--print-home` | Print the data folder (see [Configuration](configuration.md#where-circle-keeps-things)) and exit. Nothing is created. |
| `--init` | Run model setup again, even if Circle is already set up. See [Setting up again](#setting-up-again). |
| `--line` | Use the plain line-by-line mode instead of the full-screen interface. |
| `-h`, `--help` | Show usage. |

`-p` can also come first as a flag: in `circle -p -c "what changed?" ~/code/app` the first word after the options is the prompt and the second is the folder.

A tool left out with `--tools`, `--exclude-tools` or `--no-tools` is not offered to the model, and a call to it anyway is answered with an error instead of being run. The limit applies to the main agent; a subagent started with `task` keeps its own tools, so leave out `task` too when that matters. `compact_conversation` is always there, because `/compact` asks the model to call it.

Some options cannot go together, and Circle stops with exit code `2` when they are: `--fork` with `-c`, `-r`, `--session` or `--no-session`; `--session-id` with `-c`, `-r` or `--session`; `--no-session` with anything that opens a saved conversation; `-r` with `-p`, `--line` or messages; `--line` with messages.

## Print mode

`circle -p` runs one turn, or one per message, and exits. The last answer is the only thing written to standard output, so it can be piped or captured:

```bash
circle -p "Summarize README.md in one sentence"
git diff | circle -p "Review this change"
circle -p -c "Now write the tests for it"
```

Piped input is put before the prompt. When you give a prompt, Circle waits up to three seconds for piped input to start and then goes on without it, so a script that leaves standard input open does not hang it. Use `</dev/null` to skip the wait. With no prompt, the piped input is the prompt.

Nobody can answer an approval card in print mode, so each call that would ask is decided by a rule:

- Without `--yolo` it is not run. The model is told why, and that its own tools for listing, reading and searching files need no approval, so a question about the code can still be answered. It usually ends with what it would have run or changed. Standard error says how many calls were not run.
- With `--yolo` it runs, except the calls Circle always asks about: deleting, `rm -rf`, force-push and the other cases listed in [Security](security.md). Those are still not run.
- Commands the policy refuses (`sudo`, credential files) are refused as in a session.

Print mode does not load MCP servers, extensions or custom commands. It does apply `credential_files`. The conversation is saved, so `circle -c` (with or without `-p`) can go on with it.

| Exit code | When |
|---|---|
| `0` | The model answered. |
| `1` | No answer: the request failed, or the turn ended without text. The reason is on standard error. |
| `2` | A usage error: no prompt, an unknown `--session` or `--fork`, a missing `@file`, options that cannot go together, settings not initialized, or the folder not trusted. |
| `130` | Interrupted with `ctrl+c`. |

## JSON events

`circle --mode json "prompt"` runs like `-p` and writes one JSON object per line to standard output, for a program to read. Errors are also written to standard error.

| `type` | Fields | When |
|---|---|---|
| `session` | `id`, `workspace`, `model` | First. |
| `turn_start` | `message` | Before each prompt is sent. |
| `assistant` | `id`, `text`, `tool_calls` (each `id`, `name`, `args`), `usage` (`input_tokens`, `output_tokens`) | Each time the model answers, with or without tool calls. |
| `tool_result` | `id` (the call's), `name`, `status` (`success` or `error`), `output` | Each tool result. |
| `not_run` | `name`, `args`, `reason` (`needs --yolo` or `always asks`) | A call that was not run because nobody can approve it. |
| `turn_end` | `answer`, `usage` (this run so far) | When a prompt's turn ends. |
| `error` | `message` | The run stopped. |

```bash
circle --mode json "list the TODOs" | jq -r 'select(.type=="turn_end") | .answer'
```

The exit codes are those of [print mode](#print-mode).

## RPC mode

`circle --mode rpc [folder]` keeps running and takes one JSON command per line on standard input. Each command gets one `response` line on standard output, with the command's `id` when it had one:

```json
{"id": "1", "type": "prompt", "message": "Review src/app.py"}
{"type": "response", "command": "prompt", "success": true, "id": "1", "data": {"disposition": "started"}}
```

The work a prompt starts is written as the [JSON events](#json-events) (without `session`), with a `steer` event when the model reads a steering message, and ends with `{"type": "agent_settled"}` once nothing more will run on its own. A command that fails has `"success": false` and an `error`; a line that is not JSON gets a `response` with `"command": "parse"`. Closing standard input lets the current turn finish, then Circle exits. The commands follow pi's RPC mode where Circle has the same thing:

| `type` | Fields | What it does |
|---|---|---|
| `prompt` | `message`, `streamingBehavior` | Start a turn. While one runs, `streamingBehavior` must be `steer` (the model reads it before its next step) or `followUp` (sent when the turn ends). `data.disposition` is `started` or `queued`. |
| `steer` | `message` | A steering message for the running turn, or a new turn when none runs. |
| `follow_up` | `message` | A message for after the running turn, or a new turn when none runs. |
| `abort` | | Stop the running turn and drop the follow-ups; answers once the turn has stopped. |
| `clear_queue` | | Take back the waiting messages: `data.steering` and `data.followUp`. |
| `new_session` | | A new conversation (`data.sessionId`). Not while a turn runs. |
| `get_state` | | `model`, `thinkingLevel`, `isStreaming`, `sessionId`, `sessionName`, `messageCount`, `pendingMessageCount`. |
| `get_messages` | | Every message, as LangChain message dicts. |
| `get_last_assistant_text` | | `data.text`. |
| `get_session_stats` | | Message, tool call and token counts. |
| `set_session_name` | `name` | Give the conversation a title. |
| `get_available_models` | | What the endpoint lists. |
| `set_model` | `modelId` | Use another model for the rest of the process. Not while a turn runs. |
| `set_thinking_level` | `level` | `minimal` … `max`, for the rest of the process. Not while a turn runs. |
| `export_html` | `outputPath` | Write the conversation as HTML; `data.path`. |

Approvals are decided as in [print mode](#print-mode): without `--yolo`, calls that would ask are not run. `--model`, `--thinking`, `--tools`, `--system-prompt`, `--name`, `--session-id`, `--fork`, `-c` and `--no-session` apply as usual. Messages and `@files` on the command line are refused; send them as commands.

## Updating

```bash
circle update [--check] [--version X.Y.Z]
```

| Option | What it does |
|---|---|
| *(none)* | Install the newest release. |
| `--check` | Say whether a newer release exists. Install nothing. |
| `--version X.Y.Z` | Install that release instead, including an older one, to go back. |

`circle update` works on a copy that `install.sh` or `install.ps1` put in place. It finds the newest release on GitHub, downloads the file for your operating system and processor, checks its sha256 against the `.sha256` file published beside it, unpacks it next to the running version, and only then moves the `current` link. The newest three versions, the previously selected version, and the updating process's version stay on disk, so `circle update --version <old>` goes back without a download when that version is retained. Other versions are removed. Cleanup does not track every open session: close sessions from older versions before repeatedly updating (see [Known issues](known-issues.md#install-and-release)).

A copy that runs from a git checkout, or that was installed with `pip`, is not changed. `circle update` prints what to run instead. To open a folder that is called `update`, write `./update`.

| Code | When |
|---|---|
| `0` | Updated, already up to date, or `--check` finished. |
| `1` | It could not: GitHub was not reachable, no release matches, the checksum failed, or this copy was not installed by the installer. |
| `2` | `--version` is not a version like `0.2.0`. |

If GitHub is reached through a proxy that inspects HTTPS, set `SSL_CERT_FILE` to a PEM file with its certificate. On Windows the Windows certificate store is used.

### The reminder

When the full-screen interface starts, Circle checks once a day whether a newer release exists, and if it does, adds one faint line to the conversation: `Circle 0.2.0 is available (you have 0.1.0) · run circle update`. The check is a `HEAD` request to `github.com/<repo>/releases/latest`, made in the background; it sends nothing beyond what any web request carries (your address and `circle/<version>` as the user agent). The answer is kept in `update-check.json` in the [data folder](configuration.md#where-circle-keeps-things). Line mode never checks.

Turn it off with `"update_check": false` in [settings](settings.md#keys), or `CIRCLE_NO_UPDATE_CHECK=1` in the environment.

## Full-screen and line mode

Circle uses the full-screen interface when both standard input and standard output are terminals, `-p` and `--line` are not given, and `CIRCLE_NO_TUI` is not `1`, `true`, or `yes`. Otherwise it runs line mode.

Line mode reads one prompt per line and prints each answer, all in one conversation:

```bash
printf 'Summarize README.md in one sentence\nNow list its sections\n' | circle ~/code/my-project
```

Approvals follow the same rules as print mode, and `--yolo` and `--verbose` work the same way. Line mode needs a folder that is already trusted and settings that are already initialized, because it cannot show the setup screens without a terminal. It does not load MCP servers, extensions, or custom commands. `/exit` leaves and `/help` explains this. A line shaped like any other command, such as `/compact` or a misspelt one, is not sent: standard error says it works in the full-screen interface only, or is not a command. A path such as `/usr/bin/env is missing`, or a line that starts with a space, is sent as a message.

## Exit codes

| Code | When |
|---|---|
| `0` | Normal exit, `--version`, `--print-home`, `--help`. Pressing Esc or Ctrl+C on a setup screen also exits `0`. |
| `1` | You declined to trust the folder, setup was left incomplete in line mode, a turn failed in line mode, or Circle crashed. A malformed `settings.json` is one way to crash it. |
| `2` | A usage error. Without a terminal: settings not initialized, the folder does not exist, or the folder is not trusted. Also an unknown `--session`. |

Print mode has its own codes, listed [above](#print-mode).

## Setting up again

`circle --init` runs the same setup as the first start. Pressing `enter` on an empty line keeps the saved URL, and then the saved key, so you can fix one without typing the other again.

It replaces only the connection, `auth` in `settings.json`: endpoint, protocol and model. Everything else stays, including `trusted_folders`, `mcp_servers`, `extensions`, `credential_files`, `theme` and keys Circle does not know. When the endpoint changes, `enabled_models` is cleared, since it named the old endpoint's models. `credentials.json` is merged, so earlier keys stay.

Inside a session, `/login` asks the same questions and switches the session without a restart. See [Change the endpoint or the key](models.md#change-the-endpoint-or-the-key).

To change only the model, pick it in `/models` inside a session and press `ctrl+s` instead. See [Settings](settings.md).
