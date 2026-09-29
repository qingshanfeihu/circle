# Slash commands

Type `/` at the start of the input box to run a command. `tab` completes the name of a built-in command. `/help` lists everything, including [custom commands](custom-commands.md) and [extension](extensions.md) commands.

A message that starts with `/` but matches no command is **sent to the model as plain text**. Circle does not tell you the command was not found, so check the spelling if nothing seems to happen.

## While Circle is working

Most commands wait until the turn ends and answer `Busy · wait for the current turn to finish`. These work at any time:

`/help`, `/hotkeys`, `/exit`, `/yolo`, `/settings`, `/approvals`, `/session`, `/name`, `/tree`, `/themes`, `/thinking`, `/details`, `/copy`, `/export`, `/share`, `/unshare`, `/mcp` (listing only)

A [custom command](custom-commands.md) also works: it is queued like any message.

## Session

| Command | Aliases | What it does |
|---|---|---|
| `/new` | `/clear` | Start a new session. |
| `/resume [n\|id]` | `/sessions` | List the sessions from this run, or switch to one. |
| `/continue` | | Switch back to the previous session. |
| `/name [title]` | | Set the session title, or show it. |
| `/session` | | Show the session id, title, model and sizes. |
| `/tree [id]` | | Show the message tree, or move to a message. |
| `/fork [id]` | | Start a new session from a message. |
| `/clone` | | Start a new session from the current branch. |
| `/undo` | | Undo the last turn on screen. |
| `/redo` | | Bring it back. |
| `/compact [hint]` | `/summarize` | Summarize older messages now. |

What these do and do not do is on [Sessions](sessions.md). Several have limits in this version.

## Output

| Command | What it does |
|---|---|
| `/copy` | Copy the last answer to the clipboard. |
| `/export [path]` | Write the conversation as Markdown. |
| `/import <path>` | Start a new session from an exported file. |
| `/share` | Write a Markdown copy under `shares/` and copy its path. Nothing is uploaded. |
| `/unshare` | Delete that copy. |
| `/editor` | Edit the draft in `$VISUAL` or `$EDITOR`. The result is put back in the input box, not sent. |
| `/thinking` | Hide or show the model's thinking rows. |
| `/details` | Expand or collapse tool output, the same as `ctrl+o`. |

## Safety and mode

| Command | Aliases | What it does |
|---|---|---|
| `/plan [on\|off]` | `/plan-mode` | Turn `read-only` mode on or off. With no argument it switches. |
| `/yolo [off]` | `/auto` | Stop asking before commands and file changes in this session. `/yolo off` asks again. Anything else, including no argument, turns it on. |
| `/approvals [revoke N]` | | Show the "always allow" rules and the last decisions. `revoke N` removes rule N. |
| `/trust` | | Trust this folder. Creates `.agent/` in it. Does not load the folder's extensions until you `/reload`. |

See [Security](security.md).

## Model and account

| Command | Aliases | What it does |
|---|---|---|
| `/models [name]` | `/model` | List the models the endpoint offers, or switch to one and rebuild the agent. |
| `/login anthropic\|openai` | `/connect` | Sign in with OAuth. **Not available in this version:** it fails unless `CIRCLE_OAUTH_MOCK=1`. Set up an API URL and key instead. |
| `/logout` | | Clear the saved credentials and mark Circle as not set up. |
| `/settings` | | Show the current model, endpoint, trusted-folder count, MCP count and data folder. |
| `/themes [auto\|dark\|light]` | | Show or set the theme. It applies at once and is saved. `auto` follows your terminal live; `dark` or `light` overrides it. |

See [Choose a model](models.md).

## Extend

| Command | Aliases | What it does |
|---|---|---|
| `/skill [name] [args]` | `/skills` | List skills, or load one. `/skill:name` also works. |
| `/mcp [reload]` | | List MCP servers and tools, or reconnect. |
| `/extensions [reload]` | `/ext` | List extensions, or reload them. |
| `/reload` | | Re-read `settings.json`, reload extensions and rebuild the agent. |
| `/init [focus]` | | Ask Circle to write `AGENTS.md` for the project. |

## Help and exit

| Command | Aliases | What it does |
|---|---|---|
| `/help` | | List commands. |
| `/hotkeys` | | Show the keyboard shortcuts. `?` on an empty prompt does the same. |
| `/exit` | `/quit`, `/q` | Quit. |

## Line mode

Line mode understands only `/help` and `/exit`. Everything else is sent to the model as text. See [CLI](cli.md#full-screen-and-line-mode).

## Name clashes

A custom command replaces a built-in command of the same name, except `/help`, `/hotkeys` and `/exit`. An extension command cannot take the name of a built-in or a custom command. See [Custom commands](custom-commands.md#things-to-know).
