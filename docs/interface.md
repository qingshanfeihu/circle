# The interface

Circle's screen has a few parts, and each kind of information always goes to the same part. Once you know the parts and the three signals (lamps, tints, and the colour of the frame), you can read any screen at a glance.

```text
 circle 0.1.0 · qwen3.8-flash · ~/code/my-project             ? for shortcuts

 › add type hints to quicksort.py and write tests for it
 ∴ Thought 6.3s · read the file first
 ● Read(quicksort.py)
   ⎿ 31 lines
 ⏺ It is a three-way partition. I'll annotate it and add tests.
 ● Edit(quicksort.py)
   ⎿ +2 −1  def quicksort(arr: list[int]) -> list[int]:
 ● Write(tests/test_quicksort.py)
   ⎿ +18  tests/test_quicksort.py
     … +15 lines · ctrl+o
   12s · ↑ 24.1k · ↓ 451

┌─ ● Plan 3/8 ───────────────────────────────────────────────────────────────┐
│ ●  2  Read existing code                                                   │
│ ●  3  Add annotations                                                      │
│ ●  4  Write tests                                                          │
│    5  Run the tests                                                        │
│    6  Fix what fails                                                       │
└────────────────────────────────────────────────────────────────── 2–6 / 8 ─┘
╭────────────────────────────────────────────────────────────────────────────╮
│ ›                                                                          │
╰──────────────────────────────────────────────────────────────── read-only ─╯
 ↑ 36.6k · ↓ 560 · ¥0.0145 · cache 63.7% · ctx 12.5k/1.0M (1%)
```

## The parts

| Part | What it holds |
|---|---|
| **Header** | Version, model (with the thinking depth when it has one, such as `step-3.7-flash • high`), folder, and the git branch in brackets when the folder is in a repository. On the right, the one general shortcut hint. |
| **Conversation** | Everything that happened: your messages, Circle's answers, thinking, tool calls and their results, notices, and after each turn a line with time and tokens. It scrolls and never loses anything. |
| **Plan box** | Circle's own plan, when it has one. |
| **Waiting messages** | Above the input box, while a turn runs: each message you sent that the model has not read yet, `steering: …`, and each that waits for the turn to end, `follow-up: …`. See [Steer a running turn](usage.md#steer-a-running-turn). |
| **Input box** | The one framed box on the screen. It is where you type, and where questions appear. |
| **Footer** | One line of numbers: tokens sent and received, estimated cost, cache hit rate, how full the context is (yellow from 70%, red from 90%). A short confirmation such as `Copied 120 chars` shows at its right for a second or two, then goes. |
| **Subagent strip** | Below the footer, only while subagents run. |

A few things appear briefly and are not kept: the confirmations in the footer, the popup of `/approvals`, and the lists of `/models`, `/effort`, `/resume`, `/tree` and `/fork`, which open above the input box and close when you choose or press `esc`. Some views take over the whole conversation area, such as a subagent's record.

Circle also sets the terminal window's title to `circle - <folder>`, or `circle - <session title> - <folder>` once the session has a title (the first line of your first message, or what `/name` set), and gives the old title back when it exits, in terminals that keep a title stack.

## The frame says whose turn it is

The input box changes colour and behaviour depending on who has to act.

| Frame | Meaning |
|---|---|
| Faint and still | Idle. Type. |
| Rainbow, moving | The model is working. A label on the top edge shows the busy word, elapsed time and tokens: `Brewing… · 12.4s · ↓ 1.9k`. |
| Yellow and still | It is your turn. A card is showing and Circle is waiting for you. |

At the bottom-right corner a single word shows the mode, but only when it is not the default: `read-only` or `auto`. See [Use Circle in the terminal](usage.md#modes).

## Lamps

Every row that has a state gets one round lamp `●`.

| Lamp | Meaning |
|---|---|
| Yellow, blinking | Running |
| Green | Finished |
| Red | Failed |
| Cyan, steady | Waiting for you |
| None | Not run |

Lamps appear on tool calls, subagents, the plan and its steps, the title of a card, and the header of a subagent's page. Cyan, the "waiting for you" lamp, is the one to look for when nothing seems to be happening: something is waiting for your answer.

## Tints

A tinted background says what kind of work a block is.

| Tint | Kind |
|---|---|
| Blue | Reading: files, searches, the web, skills |
| Green | Changing: files and commands, including Bash |
| Magenta | Thinking, the plan, and questions the model asks you |
| Cyan | Subagents |

Answers from the model are never tinted.

## Marks at the start of a line

| Mark | Meaning |
|---|---|
| `›` (blue) | You |
| `⏺` | The model speaking |
| `∴` | Thinking |
| `⎿` | The result of the row above it |
| `✖` | An error (red) or a stop (dim, `Interrupted`) |

## What is shown, and what is hidden

Circle folds what is long or rarely needed, and always says how to open it:

- Long tool output ends with `… +N lines · ctrl+o`.
- A folded thought ends with `ctrl+t`.
- A file read shows `Read 31 lines · ctrl+o`.

There are no other key hints on the screen. The header's `? for shortcuts` lists them all.

## Questions in the frame

A tool approval or a question from the model does not open a second box. The input box itself changes: the frame turns yellow and still, the plan box steps out of the way, and the box shows a title with a cyan lamp, what is being asked, and numbered options. For a file change, what is being asked includes the lines it would add and remove. The tool row above it, in the conversation, carries the same lamp and tint, so you can see which call is asking. When you answer, the box returns to normal and your draft is put back.

If your screen is too short for a long command, the card shows the start of it and how many lines are hidden. Reject if you cannot see enough to approve.

## Dark and light terminals

The screen follows your terminal, and keeps following it. At start Circle asks the terminal for its foreground and background colours and for four of its palette colours, and derives every other colour from them. The tints are your terminal's own blue, green, magenta and cyan mixed into its background, and the lamps use its yellow, green, red and cyan. The same design therefore reads on a dark theme and on a light one.

When your terminal switches between a dark and a light theme while Circle is running, for example when the system changes appearance at sunset, Circle follows within a couple of seconds and shows `Theme → light` or `Theme → dark` at the right of the footer. Nothing has to be restarted. It works by asking the terminal for its colours every two seconds, and by listening when the terminal announces the change itself. The question is a few dozen bytes and changes nothing on screen.

Two things adapt to how light the background is. Secondary text (the footer, the header hint, dimmed lines) is kept at a readable contrast instead of a fixed fade. The rainbow frame is darkened just enough to stay visible on a light background, and is unchanged on a dark one.

`/themes` chooses how Circle decides:

| Command | Effect |
|---|---|
| `/themes` | Show the current setting. |
| `/themes auto` | Follow the terminal, live. This is the default. |
| `/themes dark`, `/themes light` | Assume that background and stop listening to the terminal. Colours the terminal reported are kept when they already match. |

The change applies at once and is saved in [settings](settings.md). `/themes terminal` still works and means `auto`.

Use `dark` or `light` when the terminal cannot be asked. Some `ssh` and `tmux` setups do not pass the question through, and Circle then reads `COLORFGBG`, or assumes dark. A terminal that never answers is asked three times and then left alone. Choosing `light` in a dark terminal does not paint the terminal light: it only makes Circle choose colours for a light background, which will be hard to read on a dark one.

## Narrow terminals

Circle reads the size of the terminal on every redraw. On a narrow screen the header drops its shortcut hint, then shortens the folder path from the left, then the model name. In the subagent strip the description column shrinks first, then the `tokens` word, and last the name. Text you and Circle wrote wraps rather than being cut; only rows that summarise something are shortened, and never the lamp, the name or the numbers.
