# Sessions and context

A session is one conversation: its messages, tool calls and results. Circle keeps each session's history in `checkpoints.sqlite` in the data folder, so the model's memory of a conversation survives a crash. What the screen shows is a separate copy kept in memory.

This page also lists what the current build does not do. Read [What does not carry over](#what-does-not-carry-over) before you rely on resuming.

## Start, name and switch

| Command | What it does |
|---|---|
| `/new` (`/clear`) | Start a new session. The old one is kept in memory for this run. |
| `/resume [n or id]` (`/sessions`) | List the sessions from this run, or switch to one by number or id. |
| `/continue` | Switch back to the previous session. |
| `/name <title>` | Give the session a title. The first line of your first message is used until you do. |
| `/session` | Show the session id, title, model and sizes. |

Session ids look like `circle-3f9a1c2e`. Titles are not saved.

## Undo and redo

`/undo` removes your last message and Circle's reply from the screen and puts the screen back as it was. `/redo` brings them back. You can undo up to 40 turns.

`/undo` only changes what the screen shows. **The model still remembers the turn**, and files it changed stay changed. Use it to tidy the view.

## Branches

Each session keeps a tree of your messages.

- `/tree` shows the current branch, last 40 messages. `/tree <id>` moves the marker to a message.
- `/fork [id]` starts a new session from a message, `/clone` from the current one.

These commands currently start the new session with an empty model context, and `/tree <id>` does not rewind the model. See [What does not carry over](#what-does-not-carry-over).

## Compaction

Long conversations are summarized automatically when they pass about 85% of the model's context window (170,000 tokens if the model does not report one). Older messages are replaced by a summary and the recent ones are kept. The originals are saved under `conversation_history/` in your workspace.

`/compact [hint]` does it now. It asks the model to compact, then shows `— compacted (same thread) —` and the summary. It says `Nothing to compact yet` when the conversation is still short. The hint is added to the request as text; it is not passed to the summarizer.

The footer shows how full the context is: `ctx 12.5k/1.0M (1%)`.

Circle also shortens old tool output in the requests it sends, once there is a lot of it. The full text stays in the stored conversation.

## Export and import

| Command | What it does |
|---|---|
| `/export [path]` | Write the conversation as Markdown. Default: `exports/` in the data folder. A relative path is inside the workspace. |
| `/import <path>` | Start a new session from an exported file. The first 8,000 characters are given to the model as earlier context. |
| `/share` | Write a Markdown copy under `shares/` and copy its path. Nothing is uploaded. |
| `/unshare` | Delete that copy. |

## Prompt history

Your messages are saved in `history` in the data folder (last 1,000). `↑` and `↓` walk through them and `ctrl+r` searches.

## What does not carry over

These are limits of the current version:

- **Restarting Circle forgets the session list.** The model's history is still in `checkpoints.sqlite`, but `/resume` lists only sessions started since Circle opened, and there is no command to reopen an older one. Approval rules you saved with "for this session" are kept per session and so are unreachable after a restart too.
- **`/fork` and `/clone` give the model no history.** The new session appears with the earlier messages on screen, but the model starts empty.
- **`/tree <id>` does not rewind the model.** It moves the marker only. The next message goes to the same conversation with its full history.
- **`/undo` and `/redo` do not change the model's memory or your files.**
- **Titles, the tree and undo history are kept in memory only.**
