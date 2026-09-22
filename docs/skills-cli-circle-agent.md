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

There is **no** local agent registry under `~/.agents` — agents are hardcoded in
`vercel-labs/skills`. To add Circle (same pattern as open PRs for other agents):

1. Add `| 'circle'` to `AgentType` in `src/types.ts`
2. Add to the `agents` map in `src/agents.ts`:

```ts
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

3. Run `pnpm run -C scripts validate-agents.ts` and `pnpm run -C scripts sync-agents.ts`

After that lands:

```bash
npx skills add <owner/repo> --skill <name> -a circle -y
```

| Scope | Path |
|-------|------|
| Project | `./.agents/skills/` |
| Global (`-g`) | `~/.circle/skills/` |

`skillsDir === '.agents/skills'` makes Circle a universal agent (canonical project
layout, no per-agent symlink). Circle also discovers `~/.agents/skills` and
`.agent/skills`, so installs via `-a amp` / `-a cursor` remain visible without
re-install.
