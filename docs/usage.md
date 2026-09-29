# Use Circle in the terminal

This page covers working in a session: sending messages, answering questions, stopping work, and getting output out. For what the screen shows, see [The interface](interface.md).

## Send a message

Type in the box at the bottom and press `enter`. The box is a single line that scrolls sideways. To put a line break in a message, press `shift+enter` or `ctrl+j`; it shows as `↵`.

Type `/` to see commands. `tab` completes a command name. `?` on an empty prompt shows the shortcuts. Everything else you type goes to the model. A message that starts with `/` but is not a command is also sent to the model as ordinary text.

Circle has no `@file` mentions. Name the file in your message and Circle will read it.

## Answer a question

When Circle needs a decision, a card takes over the input box and the frame turns yellow and stops moving. The card is either an approval or a question from the model.

- Press the number of the option. For an approval, `y`, `a` and `n` also work, though they are not shown.
- `↑` `↓` move, `enter` confirms, `esc` gives the most cautious answer: reject, or cancel.
- `Reject and explain` turns the last row into an input. Type what Circle should do instead and press `enter`. An empty `enter` is a plain rejection.
- Keys you type while a card is up do not go to the input box, so a stray letter cannot answer for you. If you were typing a message, the card waits until you have paused for a second, and it puts your draft back when you are done.

A question from the model can have several questions. `←` and `→` move between them, `space` ticks an answer when several are allowed, and `o` lets you type your own answer.

What each approval option does is explained in [Security](security.md#approvals).

## Interrupt and queue

Press `esc` to stop a turn. Circle marks it `✖ Interrupted` and puts back any message you were typing. A command that is already running keeps running until it finishes or times out.

You can type while Circle works. Press `enter` and the message is queued; the footer says `Queued steering · 1`. Queued messages are sent as new turns when the current one ends. `ctrl+c` also stops a turn. When Circle is idle, `ctrl+c` twice exits.

## Modes

Two modes change what Circle is allowed to do. The current one is shown in the bottom-right corner of the input box. Normal mode shows nothing.

| Mode | Turn on | What it does |
|---|---|---|
| `read-only` | `/plan` | Circle can read, search and write only `plan.md`. It cannot run commands or change other files. It writes its plan to `plan.md` for you to review. |
| `auto` | `/yolo` or `/auto` | Circle stops asking. Every command and file change runs without a card. Use `/yolo off` to go back. |

`read-only` wins when both are on. Auto mode applies only to the current conversation and is forgotten when you start a new one. Read [Security](security.md#auto-mode) before you use it.

## The plan

When Circle plans with `write_todos`, a box above the input shows the steps: green lamp for done, yellow for the one in progress. It shows five rows and follows the current step. Scroll it with the mouse wheel. It is hidden while a card is up and comes back afterwards.

## Subagents

While `task` subagents run, a strip below the footer lists them. Press `↓` in an empty prompt to select one, `↑` `↓` to move, `enter` to open its record, `←` `→` to switch between subagents, `esc` to go back. You can also click a row.

## See more, or less

| Key | Effect |
|---|---|
| `ctrl+o` | Expand or collapse tool output. Long output is folded by default: `… +15 lines · ctrl+o`. |
| `ctrl+t` | Expand or collapse the model's thinking. |
| `/thinking` | Hide or show thinking rows altogether. |
| `ctrl+l` | Redraw the screen. |
| `pageup`, `pagedown`, `home`, `end` | Scroll the conversation when the prompt is empty. |

## Get text out

- **Select with the mouse.** Dragging selects and copies at once. Double-click selects a word, triple-click a line. Dragging past the top or bottom edge scrolls.
- `/copy` copies the last answer. It uses `pbcopy`, `wl-copy` or `xclip`. If none is installed it writes the text to `exports/last-copy.txt` in the data folder.
- `/export` writes the whole conversation as Markdown. `/share` writes a copy under `shares/` and copies its path. Nothing is uploaded.
- `/editor` opens the draft in `$VISUAL` or `$EDITOR`. What you save comes back into the input box. It is not sent until you press `enter`. The editor variable must be a single command without arguments.

## Search your history

`↑` and `↓` walk through earlier messages. `ctrl+r` searches them: type to search, `ctrl+r` for the next match, `enter` to send the match, `esc` to put back what you were typing. History holds the last 1,000 messages and is kept between runs.

## Secrets

When a task needs a password or token, Circle can ask for it without it entering the conversation. Press `ctrl+s`, type the value (it is masked), and press `enter`. The value is written straight to the file the task named. The model is told it was collected, not what it was.

The footer shows `N secret(s) waiting · ctrl+s to enter` only when Circle is idle. If a task asks for a secret while Circle is still working, no hint is shown: press `ctrl+s` when the task says it needs one.
