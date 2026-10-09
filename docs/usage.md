# Use Circle in the terminal

This page covers working in a session: sending messages, answering questions, stopping work, and getting output out. For what the screen shows, see [The interface](interface.md).

## Send a message

Type in the box at the bottom and press `enter`. The box grows with your message, up to 30% of the screen, and wraps long lines. To put a line break in a message, press `shift+enter` or `ctrl+j`, or type `\` and then `enter`. For a longer message, press `ctrl+g` (or run `/editor`) to write it in your editor.

A long paste shows as `[Pasted text #1 +39 lines]` so the box stays readable, and the model gets the whole text. Your message in the conversation keeps the short form.

Type `/` and the commands it can become are listed above the input box, each with what it does; typing narrows the list. `↑` `↓` move in it, `tab` takes the marked command, `enter` takes it and runs it, and `esc` closes the list and keeps what you typed. `?` on an empty prompt shows the shortcuts. Everything else you type goes to the model. If what you type looks like a command but is not one, such as `/modles`, it is not sent: the footer says `Unknown command /modles · did you mean /models?` and your text stays in the box. A path such as `/usr/bin/env is missing` is sent as a message, and so is anything that starts with a space.

To point at a file, write `@` and part of its path. The files it can mean are listed above the input box: `@src/st` lists what is in `src/` starting with `st`, and `@stats` finds `stats.py` anywhere in the workspace (skipping `.git`, `node_modules`, build output and virtual environments). `tab` or `enter` takes the marked file; a folder lists what is in it. After `esc` closes the list, `tab` completes as far as the matches agree and lists them in the footer. When you send, each mentioned text file in the workspace of up to 64 KB is attached for the model, so it does not have to read it first, and a mentioned image or PDF goes as an attachment. [Credential files](security.md#credential-files) are left out. Your message on screen keeps the `@path`.

## Run a command yourself

Start a message with `!` to run a shell command yourself, without a card: `!git diff`, `!pytest -q`. It is drawn like Circle's own Bash calls, `esc` stops it, and its output becomes part of the conversation, so the model sees it with your next message. No turn starts. `!!command` runs it and shows the output to you only. `ctrl+b` moves it to the background (`/jobs` lists it); its output joins the conversation when it ends.

These commands follow the same refusals as the model's: `sudo` and credential files are refused, and nothing runs in `read-only` mode. A `!` command does not run while a turn runs. Messages you send while one runs are queued.

## Answer a question

When Circle needs a decision, a card takes over the input box and the frame turns yellow and stops moving. The card is either an approval or a question from the model.

- Press the number of the option. For an approval, `y`, `a` and `n` also work, though they are not shown.
- `↑` `↓` move, `enter` confirms, `esc` gives the most cautious answer: reject, or cancel.
- `Reject and explain` turns the last row into an input. Type what Circle should do instead and press `enter`. An empty `enter` is a plain rejection.
- Keys you type while a card is up do not go to the input box, so a stray letter cannot answer for you. If you were typing a message, the card waits until you have paused for a second, and it puts your draft back when you are done.

A question from the model can have several questions. `←` and `→` move between them, `space` ticks an answer when several are allowed, and `o` lets you type your own answer.

What each approval option does is explained in [Security](security.md#approvals).

## Interrupt

Press `esc` to stop a turn. Circle marks it `✖ Interrupted` until the next turn starts. A shell command that is running is ended, with everything it started, within about a second (on Windows with `taskkill`, not yet tried on a real machine). [Background jobs](background-jobs.md) keep running; a job that ends after you stopped the turn waits for your next message instead of starting a turn. `ctrl+c` also stops a turn. `ctrl+b` moves the command being waited on to the background instead of stopping it. When Circle is idle, `esc` and `ctrl+c` clear what you typed (`ctrl+c` keeps it in the history), and `ctrl+d` on an empty box leaves.

## Steer a running turn

You can type while Circle works. Press `enter` and the turn goes on; the model reads your message after its current step, before it decides what to do next. The message is listed above the input box as `steering: …` until the model reads it. It then appears in the conversation at the point where the model read it. If the model was about to finish, it reads the message first and goes on.

If you stop the turn with `esc` or `ctrl+c`, the messages still waiting are sent next, one turn each, steering first. Take them back with `alt+↑` before you stop it if you would rather change them.

`ctrl+q` instead of `enter` queues a follow-up: the model does not see it during the turn, and it is sent as a new turn when the turn ends. Waiting messages are listed above the input box as `steering: …` or `follow-up: …`. `alt+↑` takes back every message that has not been read yet and puts them in the input box, so you can change them or drop them.

## Modes

Two modes change what Circle is allowed to do. The current one is shown in the bottom-right corner of the input box. Normal mode shows nothing.

| Mode | Turn on | What it does |
|---|---|---|
| `read-only` | `/plan` | Circle can read and search, and change only a file named `plan.md`. It cannot run commands or change other files. It writes its plan to `plan.md` for you to review. The model can turn it on itself, and asks you before it turns it off. |
| `auto` | `/yolo` or `/auto` | Circle stops asking. Every command and file change runs without a card. Use `/yolo off` to go back. |

`read-only` wins when both are on. Auto mode applies only to the current conversation and is forgotten when you start a new one. Read [Security](security.md#auto-mode) before you use it.

## The plan

When Circle plans with `write_todos`, a box above the input shows the steps: green lamp for done, yellow for the one in progress. It shows five rows and follows the current step. Scroll it with the mouse wheel. It is hidden while a card is up and comes back afterwards.

## Subagents

While `task` subagents run, a strip below the footer lists them. Press `↓` in an empty prompt to select one, `↑` `↓` to move, `enter` to open its record, `←` `→` to switch between subagents, `esc` to go back. You can also click a subagent's row in the strip.

## See more, or less

| Key | Effect |
|---|---|
| `ctrl+o` | Expand or collapse tool output. Long output is folded by default: `… +15 lines · ctrl+o`. |
| `ctrl+t` | Expand or collapse the model's thinking. |
| `/thinking` | Hide or show thinking rows altogether. |
| `ctrl+l` | Choose a model. |
| `pageup`, `pagedown`, `home`, `end` | Scroll the conversation when the prompt is empty. |
| `ctrl+f` | Find text in the conversation; `enter` goes to the next match. |

## Get text out

- **Select with the mouse.** Dragging selects and copies at once. Double-click selects a word, triple-click a line. Dragging past the top or bottom edge scrolls.
- `/copy` (or `ctrl+x`) copies the last answer. It uses `pbcopy`, `wl-copy` or `xclip` (`clip` on Windows). If none works it writes the text to `exports/last-copy.txt` in the data folder.
- `/export` writes the whole conversation as Markdown. `/share` writes a copy under `shares/` and copies its path. Nothing is uploaded.
- `/editor` (or `ctrl+g`) opens the draft in `$VISUAL` or `$EDITOR`, else the first of `nvim`, `vim` and `nano` that is installed (then `notepad` on Windows). The variable may carry arguments, such as `code --wait`. What you save comes back into the input box. It is not sent until you press `enter`.

## Search your history

`↑` and `↓` walk through earlier messages. `ctrl+r` searches them: type to search, `ctrl+r` for the next match, `enter` to send the match, `esc` to put back what you were typing. History holds the last 1,000 messages and is kept between runs, in `history` in the data folder or where `CIRCLE_HISTORY_PATH` says.

## Secrets

When a task needs a password or token, the model can ask for it without it entering the conversation. A card names the variable and the file it will be written to, such as `API_TOKEN → /path/to/.env`. Press `ctrl+s` (or choose `enter secret`), type the value (it is masked), and press `enter`. The value is written straight to that file as `API_TOKEN=…`, keeping the file's other lines. The model is told it was collected, not what it was. `esc` cancels, and the model is told to ask you to put it in the file yourself; it never asks for the value in chat.

The value must fit on one line and in 4,096 bytes. A request nobody answers is dropped after ten minutes, and the model is told. Without the full-screen interface nobody can type it, so such a request waits out those ten minutes. Read the file name on the card before you enter a value: the model chooses it. See [Security](security.md#secrets).
