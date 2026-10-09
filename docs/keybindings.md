# Keyboard and mouse

Press `?` in an empty input box, or run `/hotkeys`, to see the shortcuts in the terminal. That list leaves out a few keys, so this page is the complete one.

## Input box

| Key | Action |
|---|---|
| `enter` | Send. While Circle works, the model reads the message after its current step, without stopping. See [Steer a running turn](usage.md#steer-a-running-turn). |
| `ctrl+q` | Queue the message as a follow-up: it is sent when the running turn ends, as a new turn. When Circle is idle it is sent at once. |
| `alt+↑` | Take back the messages the model has not read yet, steering and follow-ups. They return to the input box, ahead of what you were typing. |
| `shift+enter`, `ctrl+j` | Insert a line break. |
| `\` then `enter` | Also a line break, for terminals that send `shift+enter` as `enter`. |
| `ctrl+g` | Edit the draft in `$VISUAL` or `$EDITOR`, the same as `/editor`. |
| `esc` | While Circle works: stop the turn. Messages it had not read yet are sent next, one turn each. Otherwise: clear the input box. |
| `esc` `esc` | Twice within half a second with an empty input box: open the session tree, the same as `/tree`. The `double_escape` setting can make it open `/fork` instead, or nothing. |
| `ctrl+c` | While Circle works: stop the turn. With text in the box: clear it (it stays in the history). With an empty box: press twice within 1.5 seconds to exit; a second press right after stopping a turn also exits. |
| `ctrl+d` | With an empty box: exit at once. With text: delete the character after the cursor. |
| `ctrl+z` | Suspend Circle and go back to the shell. `fg` brings it back as it was. Not on Windows. |
| `ctrl+b` | Move the command being waited on to the [background](background-jobs.md): the model's, a subagent's, or your own `!command`. It goes on as a job. In tmux, `ctrl+b` is tmux's prefix: press it twice, or give the action another key (`job.background`, below). |
| `←` `→` | Move the cursor. |
| `alt+←` `alt+→`, `ctrl+←` `ctrl+→`, `alt+b` `alt+f` | Move by word. On macOS, option+arrow sends `alt+b` and `alt+f`. |
| `ctrl+w`, `alt+backspace` | Delete the word before the cursor. |
| `alt+d`, `alt+delete` | Delete the word after the cursor. |
| `ctrl+k` | Delete to the end of the draft. |
| `ctrl+y` | Put back what the last of these deleted. |
| `home` or `ctrl+a`, `end` or `ctrl+e` | Go to the start or end of the draft. With an empty input box, `home` and `end` scroll the conversation instead. |
| `backspace`, `delete` | Delete. |
| `ctrl+u` | Clear the input box. |
| `↑` `↓` | Walk through earlier messages. With an empty input box and no more history, they scroll the conversation by 3 rows. |
| `tab` | Take the marked entry of the completion list, or, with the list closed, complete a `/command` name or the `@path` before the cursor. |
| `?` | With an empty input box: show the shortcuts. |
| `ctrl+r` | Search earlier messages. See [Search](#search). |
| `ctrl+s` | Enter a secret that a task is waiting for. See [Secret entry](#secret-entry). |
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

A card asks you to approve a tool call, answer the model's questions, give a secret, or answer setup and the trust question. Printable keys other than the ones below are ignored while a card is showing, so a key you were typing cannot answer for you.

An approval:

| Key | Action |
|---|---|
| `1`-`9` | Choose that option. |
| `y` | The first option, `Allow once`. Not shown on screen. |
| `a` | The first "for this session" option (this command, or this kind of call), when offered. Not shown on screen. |
| `n`, `esc` | Reject. |
| `↑` `↓` `←` `→`, `tab`, `ctrl+p` `ctrl+n`, `k` `j` `h` `l` | Move between options. |
| `enter` | Confirm the marked option. |
| `pageup`, `pagedown` | Scroll the conversation behind the card. |
| `ctrl+c` | Stop the turn. It does not answer a background subagent's card (its title starts with the job, such as `j3 general-purpose`): the card stays. |

In the row `Reject and explain`, type the reason and press `enter`; an empty reason is a plain rejection. `esc` returns to the options.

Questions from the model:

| Key | Action |
|---|---|
| `1`-`9` | Choose that answer and go on to the next question; when several are allowed, tick it instead. |
| `↑` `↓`, `ctrl+p` `ctrl+n` | Move between answers. |
| `space` | Tick or untick an answer, when several are allowed. |
| `o` | Type your own answer, when the question allows one. `enter` sends it, `esc` goes back. |
| `←` `→`, `shift+tab`, `tab` | Move between several questions. |
| `enter` | Choose the marked answer; on the last question, send them all. |
| `ctrl+o`, `ctrl+t` | Show or fold a long question. |
| `esc` | Cancel the questions. When you had already chosen or typed something, the first press warns you and the second cancels. |

Other cards, such as setup, the trust question, or `stop j3` from `/jobs`: `↑` `↓` move, a digit or `enter` chooses, `y` takes the first option and `n` the last, and `esc` or `ctrl+c` take the last (`quit`, `keep running`, `cancel`). Where the card asks for text, type it and press `enter`; `esc` answers with nothing, which cancels.

## Completion list

Typing `/` at the start of the input box, or `@` at the start of a word, lists what it can become above the box, six entries at a time.

| Key | Action |
|---|---|
| `↑` `↓` | Move. The list wraps around. |
| `tab` | Take the marked entry. |
| `enter` | Take the marked entry. For a command, also run it. |
| `esc` | Close the list and keep the text. It opens again when the text changes. |

Any other key goes to the input box and narrows the list.

## Lists

`/models`, `/effort`, `/resume`, `/tree`, `/fork`, `/jobs`, `/settings`, `/login` and `/approvals` open a list above the input box.

| Key | Action |
|---|---|
| typing | Search. Every word you type must appear in the row. |
| `backspace` | Delete a character of the search. |
| `↑` `↓`, `ctrl+p` `ctrl+n` | Move. The list wraps around. |
| `enter` | Choose the marked row. |
| `esc` | Clear the search, or close the list. |

`ctrl+c` is not the list's: it does what it does in the input box, and the list stays open. `ctrl+d` exits from an empty input box unless the list uses it.

Some lists add keys, shown under their title: `ctrl+s` in `/models` and `/effort` also saves the choice as the default; `tab` in `/models` adds the model to the ones `ctrl+p` goes through or takes it out; `tab`, `ctrl+r` and `ctrl+d` in `/resume` switch folders, rename and delete; `L` and `ctrl+u` in `/tree` label a message and show only yours; `ctrl+d` in `/jobs` stops a job (after asking) or removes one that has ended; `k` `j` and the digits in `/approvals` move and pick a row, so they do not search there.

## Search

`ctrl+r` opens a search over your earlier messages, newest first, starting with what is in the input box. The line under the input box shows what you typed.

| Key | Action |
|---|---|
| typing, `backspace` | Change what is searched for. |
| `ctrl+r` | Next match. |
| `enter` | Send the match. |
| `esc`, `ctrl+c` | Leave, and put back what you were typing. |

Any other key leaves the search with the match in the box and does what it normally does.

## Find

`ctrl+f` looks for text in the conversation, or in a subagent's record when one is open. The line under the input box shows what you typed and `2/5` for the match you are at; the row with the match is shown in reverse video and scrolled a third of the way down the view. Case and runs of spaces are ignored. It starts at the first match from the top.

| Key | Action |
|---|---|
| typing, `backspace` | Change what is looked for. |
| `enter`, `↓` | Next match. |
| `shift+enter`, `↑` | Match before. |
| `esc`, `ctrl+f`, `ctrl+c` | Close. The view goes back to where it was. |

## Secret entry

When a task asks for a secret, a card names the variable and the file it goes to. Choose `enter secret`, or press `ctrl+s`, and a second card takes the value: up to 512 characters, masked, `enter` to submit, `esc` or `ctrl+c` to cancel. An empty value is refused. `ctrl+s` in the input box opens the oldest secret a task is waiting for.

## Subagents

While subagents run, `↓` in an empty input box selects the strip below the footer. Background jobs are listed under the subagents in the same strip, but are not selected there: `/jobs` opens them.

| Key | Action |
|---|---|
| `↑` `↓` | Move between subagents. |
| `enter` | Open the selected subagent's record. |
| `esc` | Leave the strip. |
| A letter | Leave the strip and start typing. |

In a subagent's record: `esc` or `backspace` go back, `←` `→` move to the previous or next subagent, and `pageup` `pagedown` `home` `end` scroll. The band at its top has `main`, `prev` and `next` to click. Typing a letter leaves the record and starts a message.

On a job's page (from `/jobs`): `esc` goes back to the list, `ctrl+d` stops the job (after asking) or removes one that has ended, and the mouse wheel scrolls. Other keys do nothing there, except `ctrl+c` and `ctrl+z`.

## Mouse

| Action | Effect |
|---|---|
| Wheel | Scroll the conversation by 3 rows. Over the plan box, scroll the plan. |
| Drag | Select text and copy it when you let go. |
| Drag to the top or bottom edge | Scroll while selecting. |
| Double-click | Select a word. |
| Triple-click | Select a line. |
| Click an `Agent(…)` row | Open that subagent's record; with several subagents, a list to choose from. |
| `ctrl+c` with a selection | Copy it again. |
| `esc` with a selection | Clear the selection. |

A selection is copied with the OSC 52 escape sequence, which some terminals ask permission for or ignore. Outside `ssh`, Circle also hands it to the system's clipboard tool (`pbcopy`; `wl-copy`, `xclip` or `xsel`; `clip` on Windows), and inside tmux to tmux's buffer.

## Your own keys

`keybindings.json` in the data folder gives Circle's actions other keys, as pi's file does. It maps an action to a key or to a list of keys:

```json
{"model.select": "ctrl+k", "find": ["ctrl+f", "f3"]}
```

A key named there does that action everywhere, in a card or a list too, and no longer does what it did before. The action's own key keeps working unless the file gives it to another action, so a binding cannot leave you without a way to stop a turn or close a list. Circle reads the file at start and on `/reload`, and names any action it does not know.

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
| `job.background` | `ctrl+b` |

Key names are written as on this page: `ctrl+k`, `alt+up`, `shift+tab`, `f1` to `f12`. `/hotkeys` lists the default keys.

## Which key wins

When several places could take a key, the first of these does: a card, a list, find, search, a selection, the subagent strip or a subagent's record, a job's page, `ctrl+s`, `ctrl+d` on an empty box, the completion list, the other global keys, then the input box. A card passes on the control keys it does not use, which is why `ctrl+c` still stops a turn while a card is up and plain letters do not.
