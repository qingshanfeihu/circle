# Built-in tools

The main agent has these twenty-one tools. MCP servers and [extensions](extensions.md) add more.

"Asks" means Circle shows an approval card before the call runs. See [Security](security.md). In `read-only` mode the tools that do not ask keep working; the others are refused, except changes to a plan file (see [Read-only mode](security.md#read-only-mode)).

## Reading and searching

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `ls` | List a folder. Folders end in `/`. | no | |
| `read_file` | Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`. | no | 2,000 lines by default. Lines over 2,000 characters are cut. PNG, JPEG, GIF, WebP and PDF files go to the model as attachments, up to 20 MB each and 28 MB in one request; the model and endpoint must accept them. Credential files are refused. |
| `glob` | Find files by pattern. | no | Skips `.git` and `node_modules`. 5,000 results. |
| `grep` | Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched. | no | 1,000 matches unless the call asks for more. Skips `.git`, `node_modules`, binary files, files over 10 MB and credential files. |
| `lsp` | Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based. | no | Needs `pylsp` (Python), `typescript-language-server` (TypeScript and JavaScript), `gopls` (Go) or `rust-analyzer` (Rust) on your `PATH`. 8 seconds per answer. |
| `webfetch` | Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed. | no | 500,000 bytes, 30 seconds. `http` becomes `https`. Refuses local and private addresses, also after a redirect. |
| `websearch` | Search the web through DuckDuckGo. No API key. | no | 1 to 10 results (5 by default), 20 seconds. |

## Changing things

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `write_file` | Create or overwrite a file. | yes | |
| `edit_file` | Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`. | yes | The file must have been read with `read_file` first. Text that occurs more than once needs `replace_all`. |
| `apply_patch` | Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files. | yes, and always when it deletes | Every part is checked before a file changes; if a write fails, the earlier ones are undone. |
| `delete` | Delete a file or a folder and everything in it. | always | |
| `execute` | Run a shell command in the workspace. With `background: true` it runs as a [background job](background-jobs.md) and returns at once. Standard output and standard error come back together, in the order they were written. | yes | A command still running at 120 seconds goes on as a background job; one the model gave a `timeout` (up to 600 seconds) is ended at that time. Processes a command leaves running become a job. The model gets the first 80,000 bytes of output and the path of the rest. With `background`, `timeout` is the longest the job may run (up to a day; `0` for no limit). |

The file tools refuse a credential file and a background job's output; `execute` refuses a command that names a credential file. See [Security](security.md#credential-files).

## Working with you

| Tool | What it does | Asks |
|---|---|---|
| `write_todos` | Keep the plan shown in the plan box. | no |
| `question` | Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. See [Answer a question](usage.md#answer-a-question) and [Secrets](usage.md#secrets). | no |
| `plan_enter` | Switch to `read-only` mode, as `/plan` does. | no |
| `plan_exit` | Ask you whether to leave `read-only` mode and implement the plan. Only you can say yes, so it fails without the full-screen interface. | no |

Without the full-screen interface, a `question` call returns the questions as text, and the model asks them in its answer.

## Background jobs

See [Background jobs](background-jobs.md).

| Tool | What it does | Asks |
|---|---|---|
| `list_jobs` | List this conversation's jobs: id, kind, state, time, what, and the file their output goes to. | no |
| `stop_job` | Stop a running job with everything it started. | no |
| `wait_jobs` | Wait until one of the given jobs ends (up to 600 seconds), and return how it ended. Only subagents have it: they cannot be woken by a notice. | no |

## Extending itself

| Tool | What it does |
|---|---|
| `skill` | Load the full instructions of a [skill](skills.md) by name. |
| `task` | Run a subagent (`general-purpose`, `explore`, or one an extension adds) and return its answer. Arguments: `description`, `subagent_type`, `background`. With `background: true` the subagent runs as a [background job](background-jobs.md#background-subagents) and its report comes as a notice. See [How Circle works](how-circle-works.md#subagents). |
| `compact_conversation` | Summarize older messages now. See [Compaction](sessions.md#compaction). |

## Limiting the tools

`--tools`, `--exclude-tools` and `--no-tools` choose the main agent's tools for one run; see [CLI](cli.md#arguments-and-options). `compact_conversation` is always kept. Subagents keep their own tools, so leave out `task` too when that matters.

## Calls the model gets wrong

A call to one of the tools that do not ask, with its name in the wrong case or with `-`, `_` or spaces in another place (`Read_File`, `readfile`), goes to the tool it clearly means; a tool that changes something must be named exactly. Argument names are matched the same way, and a JSON string given where a list or an object belongs is read as one. Then the arguments are checked against the tool's schema: a call that does not fit gets an error the model can correct, and nothing runs.

## Display

Tool output in the conversation is shortened to a few lines; `ctrl+o` shows all of it. Very large results (over 80,000 characters) are saved in the data folder (`projects/<folder>-<id>/large_tool_results/`), and the model gets the start and a path, `/large_tool_results/…`, to read the rest. Every command's output is kept the same way, under `background_jobs/`, and the model reads it at `/background_jobs/…`.
