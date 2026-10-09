# The interface

Circle's screen has a few parts, and each kind of information always goes to the same part. Once you know the parts and the three signals (lamps, tints, and the colour of the frame), you can read any screen at a glance.

```text
 circle 1.0.0 · qwen3.8-flash · ~/code/my-project             ? for shortcuts

 › add type hints to quicksort.py and write tests for it
 ∴ Thought 6.3s · read the file first  ctrl+t
 ● Read(quicksort.py)
   ⎿ Read 31 lines · ctrl+o
 ● It is a three-way partition. I'll annotate it and add tests.
 ● Edit(quicksort.py)
   ⎿ Edited /home/me/code/my-project/quicksort.py
 ● Write(tests/test_quicksort.py)
   ⎿ Wrote /home/me/code/my-project/tests/test_quicksort.py
   12s · ↑ 24.1k · ↓ 451

┌─ Plan 3/8 ─────────────────────────────────────────────────────────────────┐
│ ●  2  Read existing code                                                   │
│ ●  3  Add annotations                                                      │
│    4  Write tests                                                          │
│    5  Run the tests                                                        │
│    6  Fix what fails                                                       │
└────────────────────────────────────────────────────────────────── 2–6 / 8 ─┘
╭────────────────────────────────────────────────────────────────────────────╮
│ ›                                                                          │
╰──────────────────────────────────────────────────────────────── read-only ─╯
 ↑ 36.6k · ↓ 560 · $0.0145 · cache 63.7% · ctx 12.5k/1.0M (1%)
```

## The parts

| Part | What it holds |
|---|---|
| **Header** | Version, model (with the thinking depth when it has one, such as `step-3.7-flash • high`), folder, and the git branch in brackets when the folder is in a repository, once the welcome has scrolled off the screen. While the welcome is on screen the header shows only, on the right, the one general shortcut hint. While setup or the trust question is asking, it is empty. |
| **Welcome** | The first block of the conversation. See [The welcome](#the-welcome). |
| **Conversation** | Everything that happened: your messages, Circle's answers, thinking, tool calls and their results, notices, and after each turn a line with its time and tokens. The time leaves out what the turn spent waiting for your answer on a card. A notice stays where it came, after the message before it, and later turns go under it. Answers are drawn from their Markdown: headings, emphasis, links, code, lists, quotations and tables. It scrolls and never loses anything. |
| **Lists** | The lists that commands and keys open, such as `/models` or `/resume`, appear above the plan box and the input box. They close when you choose or press `esc`. A list that needs a line of text or a yes or no, such as a new name in `/resume`, asks on the line under its title. |
| **Plan box** | Circle's own plan, when it has one: five steps at a time, following the current step, with the range at the bottom right (`2–6 / 8`) when there are more. Nothing is drawn behind the steps, and the frame has the input box's resting colour. The mouse wheel over it scrolls it. It stays above a card, so the plan-exit card's question has the plan right above it. It belongs to the session: `/new` starts without one, and a resumed session brings its own back. |
| **Waiting messages** | Above the input box, while a turn runs: a compaction under way, with its progress bar (see [Compaction](sessions.md#compaction)); each message you sent that the model has not read yet, `steering: …`; and each that waits for the turn to end, `follow-up: …`. More than fit end in `+N queued · alt+up edits all`. See [Steer a running turn](usage.md#steer-a-running-turn). |
| **Input box** | The one framed box on the screen. It is where you type, and where questions appear. Above it, while you type `/` or `@`, the completion list. |
| **Search line** | Under the input box, only while you search your history (`ctrl+r`) or find text in the conversation (`ctrl+f`): what you typed and, for find, which match you are at, such as `2/5`. |
| **Footer** | One line of numbers: tokens sent and received, estimated cost in US dollars, cache hit rate, how full the context is (yellow from 70%, red from 90%). A cost or context window Circle does not know reads `N/A`; see [Models](models.md#cost-and-context-in-the-footer). A short confirmation such as `Copied 120 chars` shows at its right for a second or two, then goes. Before a session is connected there is no footer. |
| **Subagent strip** | Below the footer, only while subagents or [background jobs](background-jobs.md) run: a header such as `Agents · 2 · Jobs · 1`, a row per running subagent (lamp, name, task, time and tokens), then a row per job with its lamp, id, command or agent, what it is doing, and how long it has run; a background subagent's row adds its tokens. A subagent row has no background until you select it or point at it with the mouse. Six subagents are shown at a time and the rest counted as `… +N more`; the mouse wheel over the strip scrolls through them. At most four jobs are listed; the rest are counted as `… +N more jobs`. |

A few things appear briefly and are not kept: the confirmations in the footer, the completion list, and the lists of `/models`, `/effort`, `/resume`, `/tree`, `/fork`, `/jobs`, `/settings`, `/login` and `/approvals`. Some views take over the whole conversation area: a subagent's record and a background job's page.

Circle also sets the terminal window's title to `circle - <folder>`, or `circle - <session title> - <folder>` once the session has a title (the first line of your first message, or what `/name` set), and gives the old title back when it exits, in terminals that keep a title stack.

## The welcome

Every session starts with a welcome block at the top of the conversation. It is the folder's home page:

```text
    ▄▟████▙▄
  ▗██▀    ▀██▖   circle 1.0.0
  ██▘      ▝██   glm-5.3 · open.bigmodel.cn
  ██▖      ▗██   ~/code/compile-excel-skills (main)
  ▝██▄    ▄██▘
    ▀▜████▛▀

 ● instructions  AGENTS.md
 ● skills        3 in .circle/skills
 ● commands      2 in .circle/commands
 ● extensions    1 in .circle/extensions

   recent
   why does the export test fail on windows?    2h
   add the sheet diff to compile-excel          1d
   clean up the adapters folder                 3d
   … +6 more · /resume
```

- **The logo** is Circle's rainbow ring, three rows tall, drawn with the sextant block characters of Unicode 13 (a font without them shows boxes instead). Beside it: the version, the model and the endpoint it runs on (`not connected yet` while setup is asking), the folder and its git branch.
- **What the folder brings**: its instruction files (`AGENTS.md`, `CLAUDE.md` and the like), skills (including `.agents/skills` up to the git root), custom commands, extensions and project settings. Each row has a lamp: unlit before you trust the folder, yellow and blinking while Circle loads it, green once loaded. The extensions row turns red when one failed to load, with the reason under it. Only what the folder itself holds is listed, not your own skills, commands or extensions. A folder that holds none of these shows no rows.
- **recent**: the folder's three most recently used other sessions and how long ago. More are folded into `… +N more · /resume`.

The welcome is not part of the conversation's record: it is not saved and not exported, and `/new` draws a fresh one. Your first message goes right under it. Once the welcome scrolls away, the header takes over the version, model and folder.

## The frame says whose turn it is

The input box changes colour and behaviour depending on who has to act.

| Frame | Meaning |
|---|---|
| Faint and still | Idle. Type. |
| Rainbow, moving | The model is working. A label on the top edge shows the busy word, elapsed time and tokens: `Brewing… · 12.4s · ↓ 1.9k`. `CIRCLE_TUI_SHIMMER=0` keeps the frame still. |
| Yellow and still | It is your turn. A card is showing and Circle is waiting for you. |

A card that only says what Circle is doing, such as `Looking for models…` during setup, keeps a faint frame.

At the bottom-right corner a single word shows the mode, but only when it is not the default: `read-only` or `auto`. When both are on, it shows `read-only`. See [Use Circle in the terminal](usage.md#modes).

## Lamps

Every row that has a state gets one round lamp `●`.

| Lamp | Meaning |
|---|---|
| Yellow, blinking | Running |
| Green | Finished |
| Red | Failed |
| Cyan, steady | Waiting for you |
| None | Not running |

Lamps appear on tool calls, subagents, background jobs, the plan and its steps, the title of a card, the folder's rows in the welcome, and the band of a subagent's page or a job's page. A plan step or a call is lit only while a turn works on it: when nothing runs, a step in progress and a call that an interrupted turn left without a result stay unlit. Cyan, the "waiting for you" lamp, is the one to look for when nothing seems to be happening: something is waiting for your answer.

## Tints

A tinted background says what kind of work a block is.

| Tint | Kind |
|---|---|
| Blue | Reading: files, searches, the web, skills, the language server |
| Green | Changing: files and commands, including Bash |
| Magenta | Questions the model asks you |
| Cyan | Subagents |

Thinking and the plan box are not tinted. The folded line is italic blue, the terminal's own blue, and the text behind `ctrl+t` is faint. Both sit on the terminal background, so they read on a dark theme and on a light one. Answers from the model are never tinted.

## Marks at the start of a line

| Mark | Meaning |
|---|---|
| `›` (blue) | You, including a `!command` you ran |
| `●` | The model speaking |
| `∴` | Thinking |
| `⎿` | The result of the row above it. Under a call that went on as a background job: `in background · j3`, `moved to background · j4`, or `left running · j5` for processes a command left running |
| `◆` | A background job ended: ` ◆ j3 done · npm test · 12s`, green when it is done, red when it failed, dim when it was stopped. When it opens a turn, it stands where your message would |
| `✖` | An error (red) or a stop (dim, `Interrupted`) |

## What is shown, and what is hidden

Circle folds what is long or rarely needed, and always says how to open it:

- Long tool output ends with `… +N lines · ctrl+o`, and a very long line with `… +N chars · ctrl+o`.
- A folded thought ends with `ctrl+t`.
- A file read shows `Read 31 lines · ctrl+o`.
- A running subagent shows its last calls under its row, and `… +N earlier · ctrl+o` for the others.

Elsewhere, keys are named only where you entered something with keys of its own: under a list's title, on the line where a list asks for text or a yes or no, and on the search line. The header's `? for shortcuts` lists the keys; [Keyboard and mouse](keybindings.md) has them all.

## Questions in the frame

A tool approval, a question from the model, a secret a task asks for, and the first run's setup and trust questions do not open a second box. The input box itself changes: the frame turns yellow and still, the plan box stays above it, and the box shows a title with a cyan lamp, what is being asked, and numbered options. When a subagent asks, the title starts with the subagent's name as the strip shows it, such as `general-purpose·1a2b3c4d · Bash needs your permission`. For a file change, what is being asked includes the lines it would add and remove, up to 40 of them. The tool row above it, in the conversation, carries the same lamp and tint, so you can see which call is asking. A card does not appear while you are typing: it waits until you have paused for a second. When you answer, the box returns to normal and your draft is put back.

If your screen is too short for a long command, the card shows the start of it and how many lines are hidden. Reject if you cannot see enough to approve.

Setup asks one thing at a time on its card. The URL and the key are typed in the card's input row, the key as dots; when Circle was set up before, the empty row says `enter keeps …` and an empty `enter` keeps the saved one. The model is a list of what the endpoint offers, with no numbers: type to search it, and a model it does not list gets a row of its own, `use "…"`, marked `not listed`.

## Dark and light terminals

The screen follows your terminal, and keeps following it. At start Circle asks the terminal for its foreground and background colours and for four of its palette colours, and derives every other colour from them. The tints are your terminal's own blue, green, magenta and cyan mixed into its background, and the lamps use its yellow, green, red and cyan. The same design therefore reads on a dark theme and on a light one.

When your terminal switches between a dark and a light theme while Circle is running, for example when the system changes appearance at sunset, Circle follows within a couple of seconds and shows `Theme → light` or `Theme → dark` at the right of the footer. Nothing has to be restarted. It works by asking the terminal for its colours every two seconds, and by listening when the terminal announces the change itself. The question is a few dozen bytes and changes nothing on screen.

Two things adapt to how light the background is. Secondary text (the footer, the header hint, dimmed lines) is kept at a readable contrast instead of a fixed fade. The rainbow frame is darkened just enough to stay visible on a light background, and is unchanged on a dark one. The logo in the welcome keeps its own colours on both.

`/themes` chooses how Circle decides:

| Command | Effect |
|---|---|
| `/themes` | Show the current setting. |
| `/themes auto` | Follow the terminal, live. This is the default. |
| `/themes dark`, `/themes light` | Assume that background and stop asking the terminal. Colours the terminal reported are kept when they already match. |

The change applies at once and is saved in [settings](settings.md). `/themes terminal` still works and means `auto`.

Use `dark` or `light` when the terminal cannot be asked. Some `ssh` and `tmux` setups do not pass the question through, and Circle then reads `COLORFGBG`, or assumes dark. A terminal that never answers is asked three times and then left alone. Choosing `light` in a dark terminal does not paint the terminal light: it only makes Circle choose colours for a light background, which will be hard to read on a dark one.

## Narrow terminals

Circle reads the size of the terminal on every redraw. On a narrow screen the header drops its shortcut hint (below 60 columns, or when it does not fit), then shortens the folder path from the left, then the model name. Below 50 columns the welcome leaves out the logo. In the subagent strip the task column shrinks first, then the `tokens` word, and last the name; a job's row gives up the last line it printed first. Text you and Circle wrote wraps rather than being cut; only rows that summarise something are shortened, and never the lamp, the name or the numbers.
