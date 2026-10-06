# Built-in tools

The main agent has these seventeen tools. MCP servers and [extensions](extensions.md) add more.

"Asks" means Circle shows an approval card before the call runs. See [Security](security.md).

## Reading and searching

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `ls` | List a folder. | no | |
| `read_file` | Read a text file, an image or a PDF. Arguments: `file_path`, `offset`, `limit`. | no | 100 lines by default. Content over 80,000 characters is cut. Lines over 5,000 characters are split. |
| `glob` | Find files by pattern. | no | 10 second timeout. |
| `grep` | Search file contents for **literal text**, not a regular expression. Modes: files with matches, matching lines, counts. | no | |
| `lsp` | Ask a language server: go to definition, find references, hover, symbols, implementations. Positions are 1-based. | no | Needs `pylsp` (Python), `typescript-language-server` (TypeScript and JavaScript), `gopls` (Go) or `rust-analyzer` (Rust) on your `PATH`. |
| `webfetch` | Fetch a URL. Formats: `markdown` (the default; HTML with the tags stripped), `text`, `html`. JSON is pretty-printed. | no | 500 KB, 30 seconds. Refuses local and private addresses. `http` becomes `https`. |
| `websearch` | Search the web through DuckDuckGo. No API key. | no | 1 to 10 results, 20 seconds. |

## Changing things

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `write_file` | Create or overwrite a file. | yes | |
| `edit_file` | Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`. | yes | |
| `apply_patch` | Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files. | yes, and always when it deletes | Not atomic: if a later section fails, earlier ones stay applied. |
| `delete` | Delete a file or a folder and everything in it. | always | |
| `execute` | Run a shell command in the workspace. | yes | 120 seconds by default, up to an hour if the model asks. Output over 100,000 characters is cut. |

## Working with you

| Tool | What it does | Asks |
|---|---|---|
| `write_todos` | Keep the plan shown in the plan box. | no |
| `question` | Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. | no |

## Extending itself

| Tool | What it does |
|---|---|
| `skill` | Load the full instructions of a [skill](skills.md) by name. |
| `task` | Run a subagent (`general-purpose` or `explore`) and return its answer. See [How Circle works](how-circle-works.md#subagents). |
| `compact_conversation` | Summarize older messages now. Used by `/compact`. |

## Display

Tool output in the conversation is shortened to a few lines; `ctrl+o` shows all of it. Very large results (over 80,000 characters) are saved in the data folder (`projects/<folder>-<id>/large_tool_results/`), and the model gets the start and end and a path, `/large_tool_results/…`, to read the rest.
