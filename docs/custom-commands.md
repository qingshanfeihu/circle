# Custom commands

A custom command is a Markdown file that becomes a slash command. Use one for a prompt you send often.

Create `review.md` in one of the [command folders](#where-commands-live):

```markdown
---
description: Review the staged changes
---

Review the staged changes for bugs and unclear names. Focus on: $ARGUMENTS

Diff:
!`git diff --staged`
```

Then type:

```text
/review error handling
```

Circle expands the file and sends the result as your message.

## Front matter

Front matter is simple `key: value` lines between `---` markers.

| Key | Meaning |
|---|---|
| `name` | The command name. Defaults to the file name. Lowercased; anything except letters, digits, `_` and `-` becomes `-`. |
| `description` | Shown in `/help`. Defaults to `Custom command <name>`. Cut at 200 characters. |

`agent` and `model` are accepted for compatibility with OpenCode and ignored.

## Placeholders

| Placeholder | Replaced with |
|---|---|
| `$ARGUMENTS` | Everything after the command name |
| `$1`, `$2`, ... | The arguments one by one, split like a shell would (quotes group words) |
| `` !`command` `` | The output of a shell command, run when the command is used |

`$1` to `$9` work. `$10` is read as `$1` followed by `0`.

## Shell snippets run without asking

`` !`command` `` runs on your machine straight away, in the workspace, with your full environment, a 30 second limit, and **no approval card**. Circle does not check the command against the approval rules and does not check that the folder is trusted.

Only use `!` in commands you wrote yourself. Read the commands in a repository before you run Circle in it.

## Where commands live

If two commands have the same name, the one lower in the list wins.

| Folder | Scope |
|---|---|
| `~/.circle/commands` | You (in the data folder) |
| `~/.config/opencode/commands` | You, shared with OpenCode |
| `.circle/commands` | Project |
| `.opencode/commands` | Project |
| `.pi/commands` | Project |

Only `.md` files directly inside the folder are read. Commands are read at start and after `/reload` and other rebuilds. They show in `/help` under "Custom commands", but `tab` does not complete them.

## Things to know

- A custom command with the same name as a built-in command replaces it, except `/help`, `/hotkeys` and `/exit`. A file named `init.md` replaces `/init`; a file named after an alias such as `clear.md` is never reached.
- You can use a custom command while Circle is working. It is queued like any message.
- A message that starts with `/` and matches nothing is sent to the model as plain text. Circle does not say the command is unknown.
- Commands that add tools or change how Circle works belong in an [extension](extensions.md).
