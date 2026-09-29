# Keyboard and mouse

Press `?` in an empty input box, or run `/hotkeys`, to see the shortcuts in the terminal. That list leaves out a few keys, so this page is the complete one.

## Input box

| Key | Action |
|---|---|
| `enter` | Send. While Circle works, the message is queued and sent when the turn ends. |
| `shift+enter`, `ctrl+j` | Insert a line break, shown as `↵`. |
| `esc` | While Circle works: stop the turn. Otherwise: clear the input box. |
| `ctrl+c` | While Circle works: stop the turn. Otherwise: press twice within 1.5 seconds to exit. |
| `ctrl+d` | Exit at once. |
| `←` `→` | Move the cursor. |
| `home` or `ctrl+a`, `end` or `ctrl+e` | Go to the start or end of the line. With an empty input box these scroll the conversation instead. |
| `backspace`, `delete` | Delete. |
| `ctrl+u` | Clear the line. |
| `↑` `↓` | Walk through earlier messages. With an empty input box and no more history, they scroll the conversation by 3 rows. |
| `tab` | Complete a `/command` name. |
| `?` | With an empty input box: show the shortcuts. |
| `ctrl+r` | Search earlier messages. See below. |
| `ctrl+s` | Enter a secret that a task is waiting for. |

The input box is a single line that scrolls sideways. There are no word-wise movement or delete keys.

**Pasting.** A short paste goes in as it is, with line breaks shown as `↵`. A paste of more than 800 characters or more than two line breaks becomes a placeholder such as `[Pasted text #1 +9 lines]`. In this version the placeholder is sent to the model as it is, not replaced by the text. See [Known issues](known-issues.md).

**Queue a follow-up.** `alt+enter` is meant to queue a message for after the current turn, but real terminals send it as `shift+enter`, so it does not work.

## Reading

| Key | Action |
|---|---|
| `ctrl+o` | Expand or collapse tool output. |
| `ctrl+t` | Expand or collapse the model's thinking. |
| `ctrl+l` | Redraw the screen. |
| `pageup`, `pagedown` | Scroll the conversation by half a screen (empty input box). |
| `home`, `end` | Jump to the top or bottom (empty input box). |

## Cards

The card that asks you to approve something or answers a question from the model.

| Key | Action |
|---|---|
| `1`-`9` | Choose that option. |
| `y` | Approval: the first option. Not shown on screen. |
| `a` | Approval: allow for this session, when offered. Not shown on screen. |
| `n`, `esc` | Approval: reject. |
| `↑` `↓` `←` `→`, `tab`, `ctrl+p` `ctrl+n`, `k` `j` `h` `l` | Move between options. |
| `enter` | Confirm the marked option. |
| `ctrl+c` | Stop the turn. |

Letters other than these are ignored while a card is showing, so a key you were typing cannot answer for you.

In the row `Reject and explain`, type the reason and press `enter`. `esc` returns to the options.

A question from the model adds:

| Key | Action |
|---|---|
| `space` | Tick or untick an answer, when several are allowed. |
| `o` | Type your own answer. `enter` sends it, `esc` goes back. |
| `←` `→`, `shift+tab`, `tab` | Move between several questions. |
| `ctrl+o`, `ctrl+t` | Expand or collapse, as in the conversation. |
| `esc` | Cancel the question. The first press warns you. |

## The popup of `/approvals`

`↑` `↓` (or `k` `j`) move, a digit picks a row, `enter` removes the marked rule or closes, `esc` closes.

## Search

`ctrl+r` opens a search over your earlier messages.

| Key | Action |
|---|---|
| typing | Narrow the search. |
| `ctrl+r` | Next match. |
| `enter` | Send the match. |
| `esc`, `ctrl+c` | Leave, and put back what you were typing. |

Any other key leaves the search and does what it normally does.

## Secret entry

`ctrl+s` starts it. Type the value (up to 512 characters, masked), `enter` to submit, `esc` to cancel. An empty value is refused.

## Subagents

While subagents run, `↓` in an empty input box selects the strip below the footer.

| Key | Action |
|---|---|
| `↑` `↓` | Move between subagents. |
| `enter` | Open the selected subagent's record. |
| `esc` | Leave the strip. |
| A letter | Leave the strip and start typing. |

In a subagent's record: `esc` or `backspace` go back, `←` `→` move to the previous or next subagent, `pageup` `pagedown` `home` `end` scroll.

## Mouse

| Action | Effect |
|---|---|
| Wheel | Scroll the conversation by 3 rows. Over the plan box, scroll the plan. |
| Drag | Select text and copy it when you let go. |
| Drag to the top or bottom edge | Scroll while selecting. |
| Double-click | Select a word. |
| Triple-click | Select a line. |
| Click a subagent row | Open its record. |
| `ctrl+c` with a selection | Copy it again. |
| `esc` with a selection | Clear the selection. |

Copying uses the OSC 52 escape sequence. Some terminals ask for permission or ignore it.

## Which key wins

When several places could take a key, the first of these does: a card, a question, the `/approvals` popup, search, secret entry, `ctrl+s`, a selection, the subagent strip or page, the global keys, then the input box. This is why `ctrl+c` still stops a turn while a card is up, and why plain letters do not.
