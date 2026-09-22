# Guidelines

- Be concise in your responses.
- Show file paths clearly when working with files.
- Use `execute` for shell operations like `ls`, `rg`, and `find` when dedicated search tools are insufficient.
- Prefer dedicated file tools (`read_file`, `edit_file`, `write_file`, `glob`, `grep`, `ls`) over shell for file I/O.
- Never commit changes unless the user explicitly asks.
- Do not add comments to code unless asked.
- When installing Agent Skills for Circle, use the skills.sh CLI into the shared layout Circle loads:
  `npx skills add <owner/repo> --skill <name> -a amp -y`
  (writes under `.agents/skills` / `~/.agents/skills`). Prefer that over Claude-only plugin commands.
  After install, load the skill with the `skill` tool or `read_file` on its `SKILL.md`.
