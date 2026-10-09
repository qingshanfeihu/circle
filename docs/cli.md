# CLI

Circle has one command, `circle`, and one subcommand, `circle update`. Without options `circle` opens the full-screen interface in a folder you choose. With `-p` it runs a prompt and prints the answer.

```bash
circle [options] [folder] [@file ...] [message ...]
circle -p "prompt" [folder]
circle update [version] [--check]
```

## Folder, messages and files

The words after `circle` are a folder, files and messages, in any order of options:

- **The folder** Circle works in comes first. It defaults to the current folder. `~` is expanded and symlinks are resolved. It does not have to be a git repository. A first word without spaces is always read as a folder, so a mistyped folder name is an error and not a message. A message of one word goes after the folder: `circle . refactor`.
- **Messages** are sent when the session opens, one turn each, in order. A message with spaces needs quotes. `circle "fix the failing test"` works in the current folder; `circle "fix it" ~/code/app` works too. Without a terminal, messages run as [print mode](#print-mode).
- **`@path`** adds a text file to the first message, as `<file path="…">` after it. The path is looked for in the current folder, then in the folder Circle works in. An image or a PDF inside that folder goes as an attachment instead. A file that is missing or not text is an error. The conversation on screen shows `@path`; the model gets the text.
- **`--`** ends the options, so a message can start with `-`.

```bash
circle ~/code/app "explain how the router works" @src/router.ts
circle -p "review this" @src/app.ts "now list the risks"
```

## Arguments and options

| Argument | What it does |
|---|---|
| `-p`, `--print [PROMPT]` | Send the prompt, and any messages after it, one turn each; write the last answer to standard output and exit. See [Print mode](#print-mode). |
| `--mode json` | Like `-p`, but write every step to standard output as one JSON object per line. See [JSON events](#json-events). |
| `--mode rpc` | Run as a child process driven by JSON commands on standard input, until it closes. See [RPC mode](rpc.md). |
| `-c`, `--continue` | Go on with the most recent conversation in this folder. Works with the full-screen interface, `-p`, `--line` and `--mode`. See [Sessions](sessions.md). |
| `-r`, `--resume` | Choose a saved conversation from a list, then open it. Full-screen interface only. See [Sessions](sessions.md#pick-a-session). |
| `--session ID` | Reopen a saved conversation by its id, or by the end of it when only one matches. A conversation of another folder is copied into this one. `/resume` lists the ids. |
| `--session-id ID` | Open the conversation of this folder whose id is exactly `ID`, or start a new one with that id. An id is letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit. Useful in scripts that come back to the same conversation. |
| `--fork ID` | Start a new conversation in this folder with a copy of a saved one, from any folder. The original is not changed. Combine with `--session-id` to choose the new id. |
| `--no-session` | Keep the conversation in memory only. It is not saved and not listed in `/resume`. |
| `-n`, `--name NAME` | Give the conversation a title, as `/name` does. |
| `-m`, `--model NAME` | Use this model id for this run. It is not saved; `ctrl+s` in `/models` inside a session saves one. |
| `--thinking LEVEL` | The thinking depth for this run: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. It is not saved. See [Models](models.md#thinking-depth). |
| `--models PATTERNS` | The models `ctrl+p` switches between in this run, comma-separated, such as `step-3.7-flash,step-5-*`. In place of `enabled_models` in [settings](settings.md). |
| `--export ID [FILE]` | Write a saved conversation as HTML, or as a JSONL bundle when `FILE` ends in `.jsonl`, and exit. `FILE` defaults to `<id>.html` in the current folder. See [Sessions](sessions.md#export-and-import). |
| `--list-models [SEARCH]` | Print the models the endpoint offers and exit. With words, only the models that contain all of them. The current model is marked `(current)`. |
| `--system-prompt TEXT\|FILE` | Replace Circle's own instructions with this text, or with the file's text when it names a file. The instruction files, the environment and anything appended still follow. See [Configuration](configuration.md#system-prompt). |
| `--append-system-prompt TEXT\|FILE` | Add this text, or the file's text, to the end of the system prompt. Can be given more than once. Replaces `APPEND_SYSTEM.md` for this run. |
| `-nc`, `--no-context-files` | Do not read `AGENTS.md` or `CLAUDE.md`, in the project or elsewhere. |
| `-t`, `--tools LIST` | The model gets only these tools, comma-separated. pi's names work too: `read`, `write`, `edit`, `bash` and `find` mean `read_file`, `write_file`, `edit_file`, `execute` and `glob`. |
| `-xt`, `--exclude-tools LIST` | The model does not get these tools. |
| `-nt`, `--no-tools` | The model gets no tools. |
| `--yolo` | With `-p`, `--line` or `--mode`: run commands and file changes without asking. See [Print mode](#print-mode). |
| `--verbose` | With `-p` or `--line`: show each tool call, calls not run, failed results, retries and the tokens used on standard error. |
| `-v`, `--version` | Print the version and exit. |
| `--print-home` | Print the data folder (see [Configuration](configuration.md#where-circle-keeps-things)) and exit. Nothing is created. |
| `--init` | Run model setup again, even if Circle is already set up. See [Setting up again](#setting-up-again). |
| `--line` | Use the plain line-by-line mode instead of the full-screen interface. |
| `-h`, `--help` | Show usage. |

`-p` can also come first as a flag: in `circle -p -c "what changed?" ~/code/app` the first word after the options is the prompt and the second is the folder.

A tool left out with `--tools`, `--exclude-tools` or `--no-tools` is not offered to the model, and a call to it anyway is answered with an error instead of being run. The limit applies to the main agent; a subagent started with `task` keeps its own tools, so leave out `task` too when that matters. `compact_conversation` is always offered.

Some options cannot go together, and Circle stops with exit code `2` when they are: `--fork` with `-c`, `-r`, `--session` or `--no-session`; `--session-id` with `-c`, `-r` or `--session`; `--no-session` with anything that opens a saved conversation; `-r` with `-p`, `--line`, `--mode` or messages; `--line` with `--mode` or messages; `--mode rpc` with messages or `@files`.

## Print mode

`circle -p` runs one turn, or one per message, and exits. The last answer is the only thing written to standard output, so it can be piped or captured:

```bash
circle -p "Summarize README.md in one sentence"
git diff | circle -p "Review this change"
circle -p -c "Now write the tests for it"
```

Piped input is put before the prompt. When you give a prompt, Circle waits up to three seconds for piped input to start and then goes on without it, so a script that leaves standard input open does not hang it; standard error says so. Use `</dev/null` to skip the wait. With no prompt, the piped input is the prompt.

Nobody can answer an approval card in print mode, so each call that would ask is decided by a rule:

- Without `--yolo` it is not run, and the model is told it needs `--yolo` or approval. Listing, reading and searching need no approval, so a question about the code can still be answered. Standard error says how many calls were not run.
- With `--yolo` it runs, except the calls Circle always asks about: deleting, `rm -rf`, force-push and the other cases listed in [Security](security.md#how-commands-are-sorted). Those are still not run.
- Commands the policy refuses (`sudo`, credential files) are refused as in a session.

A question from the model comes back to it as text, and it asks the question in its answer.

[Background jobs](background-jobs.md) the model started (commands, subagents, watches) are waited for after its answer: when one ends, the model gets its notice and answers again, and that answer is the one printed. The wait lasts up to `CIRCLE_JOB_WAIT` seconds (1800 by default, `0` does not wait) and ten such answers; what still runs then is stopped. Processes a command left running, usually servers, are stopped at once. Background subagents follow the same approval rule.

Print mode does not load MCP servers, extensions or custom commands. It does apply `credential_files` and a project's `.circle/settings.json`. The conversation is saved, so `circle -c` (with or without `-p`) can go on with it.

Print mode, line mode and RPC mode need Circle set up and the folder trusted. When standard input is a terminal, they ask the setup and trust questions line by line first; otherwise they stop with exit code `2`.

| Exit code | When |
|---|---|
| `0` | The model answered. |
| `1` | No answer: the request failed, or the turn ended without text. The reason is on standard error. Also an unknown `--session`, or `-c` with nothing saved in this folder. |
| `2` | A usage error: no prompt, an unknown option, a missing `@file`, options that cannot go together, a folder that does not exist, a `settings.json` that cannot be read, and without a terminal: settings not set up or the folder not trusted. |
| `130` | Interrupted with `ctrl+c`. |

## JSON events

`circle --mode json "prompt"` runs like `-p` and writes one JSON object per line to standard output, for a program to read. Errors are also written to standard error.

| `type` | Fields | When |
|---|---|---|
| `session` | `id`, `workspace`, `model` | First. |
| `turn_start` | `message`, absent for a turn started for finished jobs | Before each prompt is sent. |
| `assistant` | `id`, `text`, `tool_calls` (each `id`, `name`, `args`), `usage` (`input_tokens`, `output_tokens`, `cache_read_tokens`, and `cache_write_tokens` when the endpoint reports it) | Each time the model answers, with or without tool calls. |
| `tool_result` | `id` (the call's), `name`, `status` (`success` or `error`), `output` | Each tool result. |
| `not_run` | `name`, `args`, `reason` (why the call would ask, such as `runs a shell command` or `destructive operation`) | A call that is not run because nobody can approve it. Its `tool_result` follows with the error. |
| `job` | `event` (`started`, `updated`, `ended`), `job` (`id`, `kind`, `title`, `status`, `reason`, `exitCode`, `startedBy`, `elapsed` in seconds, `output`, `sessionId`) | A [background job](background-jobs.md) started, changed or ended. |
| `compaction` | `phase`, `trigger`, and as the phase has them `tokens_before`, `tokens_after`, `summarized`, `kept`, `file`, `seconds`, `message` | A [compaction](sessions.md#compaction) started, moved on, ended or failed. |
| `subagent_event` | `event`, the event's fields, `tags` (`subagent`, `name`, and `job_id` for a background one) | Something a subagent did. |
| `turn_end` | `answer`, `usage` (this turn) | When a prompt's turn ends. |
| `error` | `message` | The run stopped. |

```bash
circle --mode json "list the TODOs" | jq -r 'select(.type=="turn_end") | .answer'
```

The exit codes are those of [print mode](#print-mode).

## RPC mode

`circle --mode rpc [folder]` keeps running and takes one JSON command per line on standard input: prompts, steering, follow-ups, stopping, switching models, listing and stopping jobs. The work it starts is written as the JSON events above. See [RPC mode](rpc.md) for the commands.

## Updating

```bash
circle update [version] [--check]
```

| Option | What it does |
|---|---|
| *(none)* | Install the newest release. |
| `--check` | Say whether a newer release exists. Install nothing. |
| `version`, `--version X.Y.Z` | Install that release instead, including an older one, to go back. |

`circle update` works on a copy that `install.sh` or `install.ps1` put in place. It asks GitHub for the newest release of the repository recorded at install time, then runs the copy of the installer that came with the running version, for that release and with the same folders: the installer downloads the file for your operating system and processor, checks its sha256, runs the new program once, and only then switches to it. See [Installation and updates](installation.md).

A copy that runs from a git checkout is not changed: `circle update` stops with `circle update requires an installer-managed installation`. Update a checkout with `git pull`, `npm ci` and `npm run build`. To open a folder that is called `update`, write `./update`.

| Code | When |
|---|---|
| `0` | Updated, already up to date, or `--check` finished. |
| `1` | It could not: GitHub was not reachable, no release matches, the version is not a version like `1.0.0`, the installer failed, or this copy was not installed by the installer. |

If GitHub is reached through a proxy that inspects HTTPS, give Circle its certificate with `SSL_CERT_FILE=/path/to/ca.pem`, and the installer with `CURL_CA_BUNDLE` (macOS, Linux); on Windows the Windows certificate store is used. See [Known issues](known-issues.md#install-and-release).

The Python versions' `circle update` (0.5.0 and older) cannot install this version. See [Installation](installation.md#replacing-the-python-circle).

### The reminder

When the full-screen interface starts, Circle checks once a day whether a newer release exists, and if it does, adds one faint line to the conversation: ``Circle 1.1.0 is available (you have 1.0.0) · run `circle update` ``. The check is a `HEAD` request to `github.com/<repo>/releases/latest`, made in the background; it sends nothing beyond what any web request carries. The answer is kept in `update-check.json` in the [data folder](configuration.md#where-circle-keeps-things). Print mode, line mode and RPC mode never check.

Turn it off with `"update_check": false` in [settings](settings.md#keys), or `CIRCLE_NO_UPDATE_CHECK=1` in the environment.

## Full-screen and line mode

Circle uses the full-screen interface when both standard input and standard output are terminals, `-p`, `--line` and `--mode` are not given, and `CIRCLE_NO_TUI` is not `1`, `true`, or `yes`. Otherwise it runs line mode, or print mode when there are messages.

Line mode reads one prompt per line and prints each answer, all in one conversation:

```bash
printf 'Summarize README.md in one sentence\nNow list its sections\n' | circle ~/code/my-project
```

Approvals follow the same rules as print mode, and `--yolo` and `--verbose` work the same way. When a [background job](background-jobs.md) ends, standard error says so (`Background job j3 ended.`); the model reads its notice with your next line. Leaving stops the jobs still running. It does not load MCP servers, extensions, or custom commands. `/exit` (`/quit`, `/q`) leaves and `/help` lists those two. Any other line shaped like a command, such as `/compact` or a misspelt one, is not sent: standard error says it works in the full-screen interface only. A path such as `/usr/bin/env is missing`, or a line that starts with a space, is sent as a message.

## Exit codes

| Code | When |
|---|---|
| `0` | Normal exit, `--version`, `--print-home`, `--help`. Leaving the setup or trust question of the full-screen interface also exits `0`. |
| `1` | Setup or the trust question was left unanswered in line mode, the last line's turn failed in line mode, an unknown `--session`, `-c` with nothing saved in this folder, or Circle crashed. |
| `2` | A usage error: an unknown option, options that cannot go together, a folder that does not exist, a `settings.json` that cannot be read, an unknown `--export` session. Without a terminal: settings not set up, or the folder not trusted. |
| `130` | Line mode stopped with `ctrl+c`. |

Print mode has its own codes, listed [above](#print-mode).

## Setting up again

`circle --init` runs the same setup as the first start, with the saved URL and key filled in, so you can fix one without typing the other again.

It replaces only the connection, `auth` in `settings.json`: endpoint, protocol and model. Everything else stays, including `trusted_folders`, `mcp_servers`, `extensions`, `credential_files`, `theme` and keys Circle does not know. When the endpoint changes, `enabled_models` is cleared, since it named the old endpoint's models. `credentials.json` is merged, so earlier keys stay.

Inside a session, `/login` asks the same questions and switches the session without a restart. See [Change the endpoint or the key](models.md#change-the-endpoint-or-the-key).

To change only the model, pick it in `/models` inside a session and press `ctrl+s` instead. See [Settings](settings.md).
