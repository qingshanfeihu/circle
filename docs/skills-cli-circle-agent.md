# Register Circle in skills.sh / `npx skills`

Circle already **consumes** the universal Agent Skills layout (`.agents/skills`,
`~/.agents/skills`), same as Amp / Cursor / Codex / Cline. Until Circle is listed
as its own agent in [vercel-labs/skills](https://github.com/vercel-labs/skills),
install with any agent that writes that layout:

```bash
npx skills add <owner/repo> --skill <name> -a amp -y
```

Any skill package works as the install target; the skill name is incidental.

## Proposed upstream agent entry

Add to the `agents` map in `src/agents.ts` (same shape as `amp` / `cursor`):

```js
circle: {
  name: "circle",
  displayName: "Circle",
  skillsDir: ".agents/skills",
  globalSkillsDir: join(home, ".circle/skills"),
  detectInstalled: async () => {
    return existsSync(join(home, ".circle"));
  },
},
```

After that lands:

```bash
npx skills add <owner/repo> --skill <name> -a circle -y
```

| Scope | Path |
|-------|------|
| Project | `./.agents/skills/` |
| Global (`-g`) | `~/.circle/skills/` |

Circle also continues to discover `~/.agents/skills` and `.agent/skills`, so
skills installed via `-a amp` / `-a cursor` remain visible without re-install.
