Run a shell command in the workspace.

Prefer specialized file tools over shell for reading, writing, editing, searching, or finding files (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`).

Use this tool for terminal work such as git, package managers, builds, tests, and process control.

# Long-running commands
- Start dev servers, watchers, long builds and anything that does not end by itself with `background: true`. The call returns at once with a job id and the file its output goes to; read that file with `read_file`.
- Do not end a command with `&` to run it in the background; use `background: true`.
- Circle adds a notice to the conversation when a background job ends. Do not poll, sleep, or re-read its output to wait for it. If you have nothing else to do, end your turn; you are woken when the job ends.
- To wait for something without polling, run a command that ends when it happens, in the background:
  - a timer: `sleep 600`
  - a condition: `until curl -sf localhost:3000 >/dev/null; do sleep 2; done`, with a `timeout` so it gives up
  - a line in a log: `until grep -qE 'ready|error' <log>; do sleep 1; done`
- With `background`, `timeout` is the longest the job may run. Without `background`, a command still running at the default timeout continues as a background job; an explicit `timeout` ends it instead.
- `list_jobs` shows your jobs; `stop_job` stops one with everything it started. Stop servers you no longer need.

# Git and GitHub
- Only commit, amend, push, or create PRs when the user explicitly asks.
- Before committing, inspect `git status`, `git diff`, and recent log; stage only intended files and never commit secrets.
- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.
- Prefer `gh` for GitHub tasks when available.
