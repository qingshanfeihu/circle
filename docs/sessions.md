# Sessions and context

A session is one conversation: its messages, tool calls and results. Circle keeps each session's history in `checkpoints.sqlite` in the data folder, saved after every step, so the model's memory of a conversation survives a crash and a restart. `sessions.sqlite` next to it lists each folder's sessions with their titles, so they can be reopened.

This page also lists what the current build does not do. Read [What does not carry over](#what-does-not-carry-over) before you rely on it.

## Start, name and switch

| Command | What it does |
|---|---|
| `/new` (`/clear`) | Start a new session. The old one stays in the folder's list. |
| `/resume` (`/sessions`) | Pick a session from a list. See [Pick a session](#pick-a-session). |
| `/resume <n or id>` | Open a session by its place in that list or by the end of its id. |
| `/continue` | Switch back to the previous session. |
| `/name <title>` | Give the session a title. The first line of your first message is used until you do. |
| `/session` | Show the session's id and title, its folder and model, where it is kept, how many messages and tool calls it holds, and the tokens this run has used. |

Session ids look like `circle-3f9a1c2e`. `circle --session-id <id>` opens or starts a session with an id you choose, `--name` gives it a title from the start, and `--no-session` keeps a conversation in memory only. See [CLI](cli.md#arguments-and-options).

## Pick a session

`/resume` and `circle -r` open a list of this folder's sessions, newest first, with how long ago each was used. Type to narrow it; every word you type must appear in the title, the id or the folder.

| Key | What it does |
|---|---|
| `enter` | Open the session. |
| `tab` | Switch between this folder's sessions and every folder's. |
| `ctrl+r` | Rename the session. |
| `ctrl+d` | Delete the session and its messages, after you confirm. The session you are in cannot be deleted. |
| `esc` | Clear the search, or close the list. |

A session from another folder is not moved. Picking one copies its messages into a new session in this folder, and the original stays where it was.

## Reopen a session after a restart

```bash
circle -c                      # the most recent session in this folder
circle -r                      # pick one from the list
circle --session 3f9a1c2e      # a session by its id, or the end of it
circle --fork 3f9a1c2e         # a copy of it, as a new session here
circle -p -c "and now the tests"   # go on with it in print mode
```

When you leave the full-screen interface, Circle prints the command that opens the conversation again, such as `To resume this session: circle --session circle-3f9a1c2e`. The folder is added when you started Circle from another one.

A reopened session is drawn again from its saved messages: your messages, the answers, thinking and tool calls, folded as they were, and `ctrl+o` and `ctrl+t` work on them. Sessions from `circle -p` and line mode are in the list too, so `circle -c` can pick up a scripted run in the full-screen interface.

## Undo and redo

`/undo` removes your last message and Circle's reply from the screen and puts the screen back as it was. `/redo` brings them back. You can undo up to 40 turns.

`/undo` only changes what the screen shows. **The model still remembers the turn**, and files it changed stay changed. Use it to tidy the view.

## Branches

You can go back to an earlier point of a session and continue from there. Nothing is lost: the earlier continuation stays in the session as another branch, and you can go back to it.

`/tree`, or `esc` twice on an empty input box, lists every message of the session, all branches, oldest first. A branch point shows its continuations under it, each marked `├`. `here` marks where the conversation is now. `/tree <words>` opens the list searching for those words.

| Key | What it does |
|---|---|
| `enter` | Go back to that message. |
| `L` | Give the message a label, shown as `[label]`. An empty label removes it. |
| `ctrl+u` | Show only your messages. |
| type | Search. |

Going back to one of Circle's answers shows the conversation up to that answer. Going back to one of your messages shows the conversation before it and puts the message back in the input box, so you can change it and send it again. Your next message starts a new branch from that point, and the model sees only the history up to it. Going back to your first message starts a new session, because there is nothing before it.

Circle remembers the point you went back to. Reopen the session after a restart and it is still there; send a message and the branch continues from it.

A point where a turn stopped on an approval card cannot be gone back to. Choose the message before it.

`/fork` and `/clone` make a new session instead:

- `/fork` lists your messages. Pick one and a new session starts with everything before it; the message is put back in the input box. `/fork <words>` opens the list searching for those words.
- `/clone` starts a new session with everything in the current one, up to the point you went back to if you did.

The original session stays in `/resume`.

## Compaction

Long conversations are summarized automatically when they pass 85% of the model's context window, the number the footer shows after `ctx`, or sooner when the room kept for the answer needs it (see [Models](models.md#cost-and-context-in-the-footer)). Older messages are replaced by a summary and the most recent tenth of the window is kept. The originals are saved in the data folder, under `projects/<folder>-<id>/conversation_history/`; the model can still read them at `/conversation_history/`.

While a compaction runs, automatic or not, a row above the input box shows it with a progress bar, the step and the time, for example `auto-compacting · ████████░░░░░░░░ summarizing · 12s`. It cannot be stopped. When it is done, one faint line stays in the conversation: `auto-compacted · ~171.0k → ~18.0k tokens · summarized 40 messages, kept 6 · 34s · history: /conversation_history/….md` (the token counts are estimates of the whole request, on the scale of the footer's `ctx`). A compaction during a turn leaves its line under the turn. When it fails, a red line says why.

`/compact [hint]` does it now. It asks the model to run the compaction; the row and the closing line are the same, reading `compacting` and `compacted`, followed by the model's answer. When the conversation still fits, `Nothing to compact yet` shows in the footer, and a red line says so when the model did not run the compaction. The hint is added to the request as text; it is not passed to the summarizer. The request and its answer are not drawn as a turn, now or when the session is reopened.

The footer shows how full the context is: `ctx 12.5k/1.0M (1%)`.

Circle also shortens old tool output in the requests it sends, once there is a lot of it. The full text stays in the stored conversation.

## Export and import

| Command | What it does |
|---|---|
| `/export [path]` | Write the conversation as Markdown, as it is on screen. Default: `exports/` in the data folder. A relative path is inside the workspace. |
| `/export html`, `/export <file>.html` | Write it as one web page: your messages, the answers, and thinking and tool calls folded. It follows the browser's light or dark setting. |
| `/export jsonl`, `/export <file>.jsonl` | Write every message as the model has it, tool calls and results included, one JSON object per line after a header line. |
| `/import <file>.jsonl` | Start a new session from a JSONL export. The model remembers it exactly, and `/tree`, `/fork` and `ctrl+o` work on it. |
| `/import <file>` | Any other file starts a new session with its text on screen; the first 8,000 characters are given to the model as earlier context. |
| `/share` | Write a Markdown copy under `shares/` and copy its path. Nothing is uploaded. |
| `/unshare` | Delete that copy. |

`circle --export <id> [file]` writes a saved session without opening it: HTML by default, as `<id>.html` in the current folder, or JSONL when the file name ends in `.jsonl`.

## Prompt history

Your messages are saved in `history` in the data folder (last 1,000). `↑` and `↓` walk through them and `ctrl+r` searches.

## What does not carry over

These are limits of the current version:

- **Going back does not undo file changes.** `/tree` and `/fork` change the conversation, not your files.
- **`/undo` and `/redo` do not change the model's memory or your files.** Use `/tree` to go back for the model.
- **The undo history is kept in memory only.** The tree is read from the saved messages, so it survives a restart; `/undo` does not.
- **`/fork` and `/clone` copy the messages only.** The plan, the files the agent noted and an earlier compaction are not carried over, so a long session may be compacted again sooner.
- **A session closed while a card was waiting** reopens without the card. Send a message to go on.
- **Background jobs end with Circle.** A reopened session has none running; when you left normally, the conversation has a note naming the jobs that were stopped. A job of another session goes on while you switch with `/resume` or `/new`, and its notice waits until that session is open again. See [Background jobs](background-jobs.md).
