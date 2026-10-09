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

- Give it a `name` and a `description`. Without a `name`, or with one that is not lowercase letters, digits and hyphens, the folder name is used; without a `description`, the model sees only `Skill from <folder>`.
- The name should match the folder name.
- The description is what Circle reads to decide whether the skill applies, so say **what it does and when to use it**. Descriptions are cut at 1,024 characters.
- Put scripts, templates and references next to `SKILL.md` and mention them in the text by relative path. When the skill is loaded, the model is told the skill's folder, so it can find them. Circle never runs bundled scripts by itself.

A skill is a folder below the skills folder, `skills/changelog/SKILL.md`, or one level deeper inside a folder that has no `SKILL.md` of its own, `skills/team/changelog/SKILL.md`.

## How Circle uses skills

Circle puts each skill's name and description in the system prompt. When a task matches, the model calls the `skill` tool (or reads the file), and follows it. Skills load only what a task needs.

You can also load one yourself:

```text
/skill                     list the skills Circle can see
/skill changelog           load one for the rest of the conversation
/skill:changelog v0.2.0    load it and pass an argument
```

A skill loaded this way is added to the conversation without starting a turn; the model reads it with your next message and follows it "until the user says otherwise". Typing `/skill:` in the input box lists the skills too.

Circle reads the skill folders again each time it builds the system prompt: when a session starts, on `/new`, `/resume`, `/reload`, a change of model or thinking depth, and `/plan`. The list in the prompt and the model's `skill` tool always come from the same reading. `/skill` reads them each time, so a skill added during a session can be loaded at once.

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

Project skills apply once you trust the folder, and the `.agents/skills` folders above it apply with them. A skill can tell the model to do anything, so read the skills in a repository before you trust it.

## Install skills

Skills from the [skills.sh](https://skills.sh) ecosystem install with `npx`. Circle is not yet in that tool's list of agents, so install as the `amp` agent, which writes to `.agents/skills`, a folder Circle reads:

```bash
npx skills add <owner/repo> --skill <name> -a amp -y
```

To share a skill with several tools at once, add them to the list: `-a amp,cursor,codex`.

For a skill only you use, copy it into `~/.circle/skills/<name>/`.
