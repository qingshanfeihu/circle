# Keyboard and mouse

Press `?` in an empty input box, or run `/hotkeys`, to see the shortcuts in the terminal. That list leaves out a few keys, so this page is the complete one.

## Input box

| Key | Action |
|---|---|
| `enter` | Send. While Circle works, the model reads the message after its current step, without stopping. See [Steer a running turn](usage.md#steer-a-running-turn). |
| `ctrl+q` | Queue the message as a follow-up: it is sent when the running turn ends, as a new turn. When Circle is idle it is sent at once. |
| `alt+↑` | Take back the messages the model has not read yet. They return to the input box. |
| `shift+enter`, `ctrl+j` | Insert a line break. |
| `\` then `enter` | Also a line break, for terminals that send `shift+enter` as `enter`. |
| `ctrl+g` | Edit the draft in `$VISUAL` or `$EDITOR`, the same as `/editor`. |
| `esc` | While Circle works: stop the turn. Otherwise: clear the input box. |
| `esc` `esc` | With an empty input box: open the session tree, the same as `/tree`. The `double_escape` setting can make it open `/fork` instead, or nothing. |
| `ctrl+c` | While Circle works: stop the turn. With text in the box: clear it (it stays in the history). With an empty box: press twice within 1.5 seconds to exit. |
| `ctrl+d` | With an empty box: exit at once. With text: delete the character after the cursor. |
| `ctrl+z` | Suspend Circle and go back to the shell. `fg` brings it back as it was. |
| `←` `→` | Move the cursor. |
| `alt+←` `alt+→`, `ctrl+←` `ctrl+→`, `alt+b` `alt+f` | Move by word. On macOS, option+arrow sends `alt+b` and `alt+f`. |
| `ctrl+w`, `alt+backspace` | Delete the word before the cursor. |
| `alt+d` | Delete the word after the cursor. |
| `ctrl+k` | Delete to the end of the line. |
| `ctrl+y` | Put back what the last of these deleted. |
| `home` or `ctrl+a`, `end` or `ctrl+e` | Go to the start or end of the line. With an empty input box these scroll the conversation instead. |
| `backspace`, `delete` | Delete. |
| `ctrl+u` | Clear the line. |
| `↑` `↓` | Walk through earlier messages. With an empty input box and no more history, they scroll the conversation by 3 rows. |
| `tab` | Take the marked entry of the completion list, or, with the list closed, complete a `/command` name or the `@path` before the cursor. |
| `?` | With an empty input box: show the shortcuts. |
| `ctrl+r` | Search earlier messages. See below. |
| `ctrl+s` | Enter a secret that a task is waiting for. |
| `ctrl+l` | Choose a model, the same as `/models`. Also redraws the screen. |
| `ctrl+x` | Copy the last answer, the same as `/copy`. |
| `ctrl+f` | Find text in the conversation. See [Find](#find). |
| `ctrl+p` | Switch to the next model for this session. See [Choose a model](models.md#switch-models). |
| `shift+tab` | Switch to the next thinking depth for this session. |

The input box grows with what you type: a line break starts a new row and a long line wraps at a space. It grows to 30% of the screen's height (at least five rows), then scrolls to keep the cursor in view. In a draft of several rows, `↑` and `↓` move between the rows; on the first row `↑` goes to earlier messages, and once you are going through them, `↑` and `↓` keep doing that.

**Pasting.** A short paste goes in as it is, line breaks included. A paste of more than 800 characters or more than two line breaks becomes a placeholder such as `[Pasted text #1 +9 lines]`. The model gets the pasted text in place of the placeholder; the conversation on screen keeps the placeholder.

**Queue a follow-up.** `ctrl+q` queues a message for after the current turn. `alt+enter` does the same in the few terminals that send it as its own key; most send it as `shift+enter`, so it inserts a line break instead.

## Reading

| Key | Action |
|---|---|
| `ctrl+o` | Expand or collapse tool output. |
| `ctrl+t` | Expand or collapse the model's thinking. |
| `pageup`, `pagedown` | Scroll the conversation by half a screen (empty input box). |
| `home`, `end` | Jump to the top or bottom (empty input box). |

## Cards

The card that asks you to approve something or answers a question from the model.

| Key | Action |
|---|---|
| `1`-`9` | Choose that option. |
| `y` | Approval: the first option. Not shown on screen. |
| `a` | Approval: the first "for this session" option (this command, or this kind of call), when offered. Not shown on screen. |
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

## Completion list

Typing `/` at the start of the input box, or `@` at the start of a word, lists what it can become above the box.

| Key | Action |
|---|---|
| `↑` `↓` | Move. The list wraps around. |
| `tab` | Take the marked entry. |
| `enter` | Take the marked entry. For a command, also run it. |
| `esc` | Close the list and keep the text. It opens again when you type. |

Any other key goes to the input box and narrows the list.

## Lists

`/models`, `/effort`, `/resume`, `/tree` and `/fork` open a list above the input box.

| Key | Action |
|---|---|
| typing | Search. Every word you type must appear in the row. |
| `backspace`, `ctrl+u` | Delete a character of the search, or all of it. |
| `↑` `↓`, `ctrl+p` `ctrl+n` | Move. The list wraps around. |
| `pageup`, `pagedown` | Move by a page. |
| `enter` | Choose the marked row. |
| `esc` | Clear the search, or close the list. |

Some lists add keys, shown under their title: `ctrl+s` in `/models` and `/effort` also saves the choice as the default; `tab` in `/models` adds the model to the ones `ctrl+p` goes through or takes it out; `tab`, `ctrl+r` and `ctrl+d` in `/resume` switch folders, rename and delete; `L` and `ctrl+u` in `/tree` label a message and show only yours.

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

## Find

`ctrl+f` looks for text in the conversation. The footer shows what you typed and `2/5` for the match you are at; the match is shown in reverse video and scrolled a third of the way down the view. Case and runs of spaces are ignored. It starts from the first match at or below what you are looking at.

| Key | Action |
|---|---|
| typing, `backspace` | Change what is looked for. |
| `enter`, `↓` | Next match. |
| `shift+enter`, `↑` | Match before. |
| `esc`, `ctrl+f`, `ctrl+c` | Close. The view stays where it is. |

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

## Your own keys

`keybindings.json` in the data folder gives Circle's actions other keys, as pi's file does. It maps an action to a key or to a list of keys:

```json
{"model.select": "ctrl+k", "find": ["ctrl+f", "f3"]}
```

A key named there does that action everywhere, in a card or a list too. The action's own key keeps working unless the file gives it to another action, so a binding cannot leave you without a way to stop a turn or close a list. Circle reads the file at start and on `/reload`, and names any action it does not know.

| Action | Default key |
|---|---|
| `interrupt` | `escape` |
| `clear` | `ctrl+c` |
| `exit` | `ctrl+d` |
| `suspend` | `ctrl+z` |
| `model.select` | `ctrl+l` |
| `model.cycle` | `ctrl+p` |
| `thinking.cycle` | `shift+tab` |
| `thinking.toggle` | `ctrl+t` |
| `tools.expand` | `ctrl+o` |
| `editor.external` | `ctrl+g` |
| `message.copy` | `ctrl+x` |
| `message.dequeue` | `alt+up` |
| `message.followup` | `ctrl+q` |
| `find` | `ctrl+f` |
| `history.search` | `ctrl+r` |
| `secret.enter` | `ctrl+s` |
| `newline` | `ctrl+j` |

Key names are written as on this page: `ctrl+k`, `alt+up`, `shift+tab`, `f1` to `f12`. `/hotkeys` lists the default keys.

## Which key wins

When several places could take a key, the first of these does: a card, a question, the `/approvals` popup, a list, find, search, secret entry, `ctrl+s`, a selection, the subagent strip or page, `ctrl+c` and `ctrl+d`, the completion list, the other global keys, then the input box. This is why `ctrl+c` still stops a turn while a card is up, and why plain letters do not.
