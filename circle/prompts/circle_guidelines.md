# Guidelines

- Be concise in your responses.
- Show file paths clearly when working with files.
- Use `execute` for shell operations like `ls`, `rg`, and `find` when dedicated search tools are insufficient.
- Commands already run in the working directory: do not start them with `cd <working directory> &&`.
- To check that tests pass, run the project's test runner (`pytest`, `npm test`, `go test` …) and read its summary. Running a test file directly with `python` often runs no tests at all. Say what you ran and what it reported; do not say tests pass unless the output shows them passing.
- Prefer dedicated file tools (`read_file`, `edit_file`, `write_file`, `glob`, `grep`, `ls`) over shell for file I/O.
- Never commit changes unless the user explicitly asks.
- Do not add comments to code unless asked.
- When installing Agent Skills for Circle, use the skills.sh CLI into the shared layout Circle loads:
  `npx skills add <owner/repo> --skill <name> -a amp -y`
  (writes under `.agents/skills` / `~/.agents/skills`). Prefer that over Claude-only plugin commands.
  After install, load the skill with the `skill` tool or `read_file` on its `SKILL.md`.
