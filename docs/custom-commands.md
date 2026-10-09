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
| `description` | Shown in `/help`. Defaults to the first line of the text, cut at 60 characters. Cut at 200 characters. |
| `argument-hint` | Shown after the name in `/help`, such as `<path> [focus]`. |

`agent` and `model` are accepted for compatibility with OpenCode and ignored.

## Placeholders

The syntax is pi's, so pi prompt templates work unchanged.

| Placeholder | Replaced with |
|---|---|
| `$1`, `$2`, … `$10` … | That argument, or nothing when there are fewer |
| `$@`, `$ARGUMENTS` | All the arguments, joined by spaces |
| `${2:-default}` | Argument 2, or `default` when it is missing or empty |
| `${@:-default}`, `${ARGUMENTS:-default}` | All the arguments, or `default` when there are none |
| `${@:2}` | The arguments from the second on |
| `${@:2:3}` | Three arguments, from the second on |
| `` !`command` `` | The output of a shell command, run when the command is used |

Arguments are split like a shell: spaces separate them, and `"` or `'` keep words together (`/review src/app.ts "error handling"`). There is no backslash escaping. Placeholders are replaced once: an argument that itself contains `$1` stays as written. They are replaced before the shell snippets run, so an argument used inside `` !`…` `` becomes part of that command.

## Shell snippets run without asking

`` !`command` `` runs on your machine straight away, in the workspace, with your environment less the variables whose names look secret, a 30 second limit, and **no approval card**. Only the refusals apply: a snippet that uses `sudo` or names a credential file is not run. Nothing else in the approval rules is checked.

Only use `!` in commands you wrote yourself. Read the commands in a repository before you run Circle in it.

## Where commands live

If two commands have the same name, the one lower in the list wins.

| Folder | Scope |
|---|---|
| `~/.config/opencode/commands` | You, shared with OpenCode |
| `~/.pi/agent/prompts` | You, shared with pi |
| `~/.circle/commands`, `~/.circle/prompts` | You (in the data folder) |
| `.opencode/commands` | Project |
| `.pi/commands`, `.pi/prompts` | Project, shared with pi |
| `.circle/commands`, `.circle/prompts` | Project |

Only `.md` files directly inside the folder are read. Circle reads the folders each time you use a command or open the command list, so a new or changed file works at once. Commands show in `/help` under "Custom commands", and in the list that opens when you type `/`.

## Things to know

- A custom command with the same name as a built-in command replaces it, except `/help`, `/hotkeys` and `/exit`. A file named `init.md` replaces `/init`; a file named after an alias such as `clear.md` is never reached.
- Custom commands work only in the full-screen interface. In print mode, line mode and RPC mode, a message that starts with `/` is not expanded.
- You can use a custom command while Circle is working. It is queued like any message.
- A message shaped like a command that matches nothing, such as `/reveiw`, is not sent. The footer says it is unknown and suggests the closest name.
- Commands that add tools or change how Circle works belong in an [extension](extensions.md).
