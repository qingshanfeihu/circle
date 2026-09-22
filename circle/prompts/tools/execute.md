Run a shell command in the workspace.

Prefer specialized file tools over shell for reading, writing, editing, searching, or finding files (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`).

Use this tool for terminal work such as git, package managers, builds, tests, and process control.

# Git and GitHub
- Only commit, amend, push, or create PRs when the user explicitly asks.
- Before committing, inspect `git status`, `git diff`, and recent log; stage only intended files and never commit secrets.
- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.
- Prefer `gh` for GitHub tasks when available.
