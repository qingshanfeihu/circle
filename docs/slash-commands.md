# Slash commands

Type `/` at the start of the input box to run a command. The commands it can become are listed above the box as you type: built-in, custom, extension, and `skill:<name>`, each with its description. `↑` `↓` move, `tab` takes the marked command, `enter` takes it and runs it, `esc` closes the list. With the list closed, `tab` completes what the matches share and lists them in the footer. `/help` lists the built-in, [custom](custom-commands.md) and [extension](extensions.md) commands.

A message that looks like a command but is not one, such as `/modles`, is **not sent**. The footer says `Unknown command /modles · did you mean /models?` and the text stays in the box to fix. A path such as `/usr/bin/env is missing` goes to the model as a message, and so does a mistyped command with a space before it.

## While Circle is working

Most commands wait until the turn ends and answer `Busy · wait for the current turn to finish`. These work at any time:

`/help`, `/hotkeys`, `/exit`, `/yolo`, `/settings`, `/approvals`, `/jobs`, `/session`, `/name`, `/tree`, `/themes`, `/thinking`, `/details`, `/copy`, `/export`, `/share`, `/unshare`, `/mcp` (listing only)

Going back with `/tree` while a turn runs stops the turn first. A [custom command](custom-commands.md) also works: its text is queued like any message.

## Session

| Command | Aliases | What it does |
|---|---|---|
| `/new` | `/clear` | Start a new session. |
| `/resume [n\|id]` | `/sessions` | Choose a session from a list, or open one by its number in that list or the end of its id. The list can show every folder's sessions, rename and delete. |
| `/continue` | | Switch back to the previous session. |
| `/name [title]` | | Set the session title, or show it. |
| `/session` | | Show the session id and title, the folder, the model, where it is kept, how many messages, and the tokens used in this run. |
| `/tree [words]` | | List every message of the session, all branches, and go back to one. The next message starts a branch from there. `esc` twice on an empty input box does the same. |
| `/fork [words]` | | Choose one of your messages; a new session starts with everything before it, and the message comes back to the input box. |
| `/clone` | | Start a new session with the current branch of this one. |
| `/undo` | | Undo the last turn on screen. |
| `/redo` | | Bring it back. |
| `/compact [hint]` | `/summarize` | Summarize older messages now. |
| `/jobs [id]` | `/tasks` | List the session's [background jobs](background-jobs.md), running ones first, or open one's page. `enter` opens a job's page with the end of its output; `ctrl+d` stops a running job (after asking) or removes one that has ended. |

What these do and do not do is on [Sessions](sessions.md). Several have limits in this version.

## Output

| Command | What it does |
|---|---|
| `/copy` | Copy the last answer to the clipboard. Without a clipboard tool, it is written to `exports/last-copy.txt` in the data folder. |
| `/export [html\|jsonl\|path]` | Write the conversation as Markdown (the default, as the screen shows it), HTML or JSONL; a file name's ending picks the format. Without a path the file goes to `exports/` in the data folder. |
| `/import <path>` | Start a new session from an exported file. A JSONL export comes back exactly; any other text file is shown, and its first 8,000 characters are given to the model. |
| `/share` | Write a Markdown copy under `shares/` in the data folder and copy its path. Nothing is uploaded. |
| `/unshare` | Delete that copy. |
| `/editor` | Edit the draft in `$VISUAL` or `$EDITOR`, which may include arguments such as `code -w`; without either, `nvim`, `vim` or `nano` (`notepad` on Windows). The result is put back in the input box, not sent. `ctrl+g` does the same. |
| `/thinking [level]` | Hide or show the model's thinking rows. With a level, the same as `/effort <level>`. |
| `/effort [level]` | Choose how hard the model thinks from a list, or set it: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Applies for the rest of this run; `ctrl+s` in the list also saves it. See [Choose a model](models.md#thinking-depth). |
| `/details` | Expand or collapse tool output, the same as `ctrl+o`. |

## Safety and mode

| Command | Aliases | What it does |
|---|---|---|
| `/plan [on\|off]` | `/plan-mode` | Turn `read-only` mode on or off. With no argument it switches. |
| `/yolo [off]` | `/auto` | Stop asking before commands and file changes in this session. `/yolo off` asks again. Anything else, including no argument, turns it on. |
| `/approvals [revoke N]` | | List the "always allow" rules of this session, with the last decisions under the title; `enter` on a rule revokes it. `revoke N` removes rule N directly. |
| `/trust` | | Trust this folder. It is saved in your settings; nothing is written into the folder. The full-screen interface asks before it opens a folder you have not trusted, so there it only confirms. |

See [Security](security.md).

## Model and account

| Command | Aliases | What it does |
|---|---|---|
| `/models [name]` | `/model` | Choose a model from what the endpoint offers, or use one by its id, for this session. `ctrl+s` in the list also saves it as the default. |
| `/login [anthropic\|openai]` | `/connect` | Change the endpoint, key and model. A list offers **API URL + KEY** and **OAuth sign-in**, which is marked `not available yet` and cannot be chosen. **API URL + KEY** asks as setup does: the base URL and the key (shown as dots), each filled in with the saved one, then the model. The session switches to them and they are saved; nothing is saved before a model is given. `/login anthropic` and `/login openai` only say that OAuth is not available yet. |
| `/logout` | | Clear the saved credentials and mark Circle as not set up. |
| `/settings` | | A list of the settings: theme, whether thinking is shown, what `esc` `esc` opens, and the model, thinking depth, endpoint, trusted folders, MCP servers and data folder. `enter` changes the marked one and saves it at once; the model, depth and MCP rows open `/models`, `/effort` and `/mcp`, and the endpoint row opens `/login`. |
| `/themes [auto\|dark\|light]` | | Show or set the theme. It applies at once and is saved. `auto` follows your terminal live; `dark` or `light` overrides it. |

See [Choose a model](models.md).

## Extend

| Command | Aliases | What it does |
|---|---|---|
| `/skill [name] [args]` | `/skills` | List skills, or load one into the conversation for your next message. `/skill:name` also works. |
| `/mcp [reload]` | | List MCP servers and tools, or reconnect them. |
| `/extensions [reload]` | `/ext` | List extensions, or reload them. |
| `/reload` | | Re-read `settings.json` (yours and the project's) and `keybindings.json`, reconnect MCP servers, reload extensions and rebuild the agent. |
| `/init [focus]` | | Ask Circle to write `AGENTS.md` for the project. |

## Help and exit

| Command | Aliases | What it does |
|---|---|---|
| `/help` | | List commands. |
| `/hotkeys` | | Show the keyboard shortcuts. `?` on an empty prompt does the same. |
| `/exit` | `/quit`, `/q` | Quit. |

## Line mode

Line mode understands only `/help` and `/exit` (and `/quit`, `/q`). Other commands are not sent to the model; standard error says so. See [CLI](cli.md#full-screen-and-line-mode).

## Name clashes

A custom command replaces a built-in command of the same name, except `/help`, `/hotkeys` and `/exit`. An extension command cannot take the name of a built-in or a custom command. See [Custom commands](custom-commands.md#things-to-know).
