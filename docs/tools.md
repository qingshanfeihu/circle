# Tools

The runtime registers tools with JSON Schema arguments and declared effects. Built-in file and command tools include `ls`, `read_file`, `write_file`, `edit_file`, `apply_patch`, `glob`, `grep` and `execute`. File edits require a prior read; ambiguous replacements fail unless `replace_all` is used. Patches validate their operations before changing files.

`read_file` uses a zero-based line offset and one-based displayed line numbers: `{ "file_path": "src/cli.ts", "offset": 20, "limit": 40 }` reads source lines 21–60. Omitted bounds read up to 2000 lines from the beginning; a non-positive limit requests no lines. Files and background logs are read as streams, with LF, CRLF and CR line endings accepted. An offset beyond the last line reports an error.

PNG, JPEG, GIF, WebP and PDF reads return media attachments instead of numbered binary text. The same formats can be supplied as workspace mentions, for example `Inspect @screenshot.png`. Credential-file rules apply to mentions as well as file tools. Each attachment is limited to 20 MiB, and a model request accepts up to 28 MiB of encoded media data. The selected model and endpoint must accept the media format; provider errors are reported without converting binary data into text.

Attachment bytes and SHA-256 receipts persist in SQLite and JSONL session bundles. HTML exports embed images and provide PDF download links. Terminal output shows file names and MIME types. Context summaries keep attachment metadata and archive the original bytes; preflight media token counts are estimates, while usage and prices come from API responses. Protocol formats follow [OpenAI images](https://developers.openai.com/api/docs/guides/images-vision), [OpenAI PDF inputs](https://developers.openai.com/api/docs/guides/file-inputs), and [Anthropic PDF inputs](https://platform.claude.com/docs/en/build-with-claude/pdf-support).

Model-facing tools also include plans, skills, questions, subagents, context compaction and web fetching. Tool results are saved in the session before the next model request. A rejected or cancelled call receives an error result with the original call ID.

`execute` and `task` accept `background: true`. `list_jobs` and `stop_job` manage the resulting jobs; subagents additionally have `wait_jobs`. See [background jobs](background-jobs.md) for output, timeout and completion behavior.

`--tools read,grep`, `--exclude-tools execute`, and `--no-tools` limit available tools for a run. The aliases `read`, `write`, `edit`, `bash` and `find` map to `read_file`, `write_file`, `edit_file`, `execute` and `glob`. Context compaction remains available. Limits apply to the main agent; subagents retain their configured tools, so omit `task` too when that matters.

Read-only mode permits plan-file changes subject to normal approval and blocks other mutations and shell execution. Mixed patches affecting non-plan files are rejected before effects. Deleting files uses forced approval and remains blocked in headless mode, including `--yolo`. `plan_exit` requires an affirmative interactive answer. Mode transitions are persisted as marked boundary messages.

`websearch` parses DuckDuckGo result pages and returns source URLs and snippets. `webfetch` accepts Markdown, text or HTML, formats JSON, bounds streamed responses and refuses private/local targets and redirects. See [questions](questions.md) for ordinary and secret input.

## LSP

`lsp` supports `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol` and `goToImplementation`. It reads the file, opens or updates it on the server, and sends the requested operation. `line` and `character` are one-based in tool arguments and converted to zero-based protocol positions.

Install the language server for the files being inspected: `pylsp` for Python, `typescript-language-server --stdio` for TypeScript/JavaScript, `gopls` for Go, or `rust-analyzer` for Rust. Servers are discovered through `PATH`; an unavailable server produces an explicit tool error.

Requests have a bounded response deadline and honor cancellation. `didOpen` and `didChange` are notifications. Server processes are closed when the runtime closes. The client does not accept server requests to edit the workspace.

See [MCP](mcp.md) and [extensions](extensions.md) for additional tool sources. All of them share the runtime's policy and read-only gate.
