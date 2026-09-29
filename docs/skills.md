# Skills

A skill is a folder with a `SKILL.md` file: instructions Circle loads only when a task needs them. Skills keep the system prompt small while giving Circle specialised knowledge, such as how to use a tool or how your team writes a changelog.

Circle uses the common Agent Skills format, so skills written for other agents work.

## Write a skill

Create `<name>/SKILL.md` in one of the [skill folders](#where-skills-live):

```markdown
---
name: changelog
description: Write a changelog entry in this project's format. Use when asked to update CHANGELOG.md or prepare a release.
---

# Changelog entries

Add entries under `## Unreleased`, newest first, one line each ...
```

- `name` and `description` are required. Circle skips a skill that lacks either.
- The name should match the folder name. Use lowercase letters, digits and hyphens.
- The description is what Circle reads to decide whether the skill applies, so say **what it does and when to use it**. Descriptions are cut at 1,024 characters.
- Put scripts, templates and references next to `SKILL.md` and mention them in the text. Circle lists up to ten of the folder's files when it loads the skill, and never runs bundled scripts by itself.

Each skill must be exactly one folder below the skills folder: `skills/changelog/SKILL.md`. A skill nested one level deeper can be loaded with `/skill` but does not appear in the list Circle shows the model.

## How Circle uses skills

At the start of a session Circle puts each skill's name and description in the system prompt. When a task matches, the model reads the full file (or calls the `skill` tool), and follows it. Skills load only what a task needs.

You can also load one yourself:

```text
/skill                     list the skills Circle can see
/skill changelog           load one for the rest of the conversation
/skill:changelog v0.2.0    load it and pass an argument
```

A skill loaded this way is added to the conversation without starting a turn. Circle follows it "until you say otherwise".

Skills are read when a session starts and again after `/reload`, `/models`, `/plan`, `/mcp reload` and similar commands.

## Where skills live

Circle looks in all of these. If two skills have the same name, the one lower in the table wins.

| Folder | Scope |
|---|---|
| `~/.agents/skills` | You, shared with other agents |
| `~/.claude/skills` | You, shared with Claude Code |
| `~/.config/opencode/skills` | You, shared with OpenCode |
| `~/.pi/agent/skills` | You, shared with pi |
| `~/.circle/skills` | You, Circle only (in the data folder) |
| `.agents/skills` in the workspace and each folder above it up to the git root | Project |
| `.opencode/skills` | Project |
| `.pi/skills` | Project |
| `.claude/skills` | Project |
| `.circle/skills` | Project, Circle only |
| `.agent/skills` | Project, highest priority |

One quirk: a skill in a parent folder's `.agents/skills` overrides one with the same name in the workspace's own.

Project skills are read whether or not you have trusted the folder. A skill can tell the model to do anything, so read the skills in a repository before you run Circle in it.

## Install skills

Skills from the [skills.sh](https://skills.sh) ecosystem install with `npx`. Circle is not yet in that tool's list of agents, so install as the `amp` agent, which writes to `.agents/skills`, a folder Circle reads:

```bash
npx skills add <owner/repo> --skill <name> -a amp -y
```

To share a skill with several tools at once, add them to the list: `-a amp,cursor,codex`.

For a skill only you use, copy it into `~/.circle/skills/<name>/`.
