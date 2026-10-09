# Terminal interface

The interface uses the terminal's foreground/background colors and a shared palette for messages, code, tools and panels. `/themes auto`, `/themes dark` and `/themes light` select the appearance.

## Reading

Answers, streamed answers, expanded thinking and subagent details render CommonMark/GFM headings, emphasis, links, code, lists, quotations and tables. Code uses the shared panel color. Ctrl+T shows thinking; Ctrl+O expands tool output. PageUp/PageDown scroll the current transcript.

Ctrl+F opens conversation find. Type to narrow the visible text; Enter/Down moves forward and Shift+Enter/Up moves backward. Esc closes find. The current match is highlighted without changing saved messages.

## Input

Up/Down browse earlier prompts and return to the unsent draft. Ctrl+R searches prompt history, newest first; another Ctrl+R cycles matches. Enter submits the selected prompt. Esc or Ctrl+C restores the draft. Multi-line prompts survive restart, with up to 1,000 entries and consecutive duplicates suppressed. `CIRCLE_HISTORY_PATH` overrides the history location.

Ctrl+J inserts a newline. Ctrl+G opens `$VISUAL`, then `$EDITOR`, or the platform default. The editor owns stdin while active. Returning restores raw input, mouse/paste handling and the full screen; edits replace the draft and are submitted with Enter.

Ctrl+L opens the model picker; Ctrl+P cycles its selected scope, and Shift+Tab cycles thinking depth. In `/models`, Enter uses the focused model for this session, Ctrl+S also saves the default, and Tab adds or removes it from the cycle scope. Empty scope uses every listed model. `--models` makes scope edits temporary for this run. In `/effort`, Enter changes this session and Ctrl+S saves the default. Pickers accept Ctrl+P/Ctrl+N as Up/Down.

The plan box shows five tasks, follows the current item and displays its visible range. Scroll over that box to move one task per wheel notch; scrolling elsewhere moves the transcript. A changed plan or new turn follows the current task again. Cards temporarily hide the box without changing task statuses.

Enter while busy queues steering for the next model step. Ctrl+Q queues a follow-up for the end of the turn, or sends it immediately while idle. Waiting messages appear above the input. Alt+Up takes every unsent steering/follow-up message back into the draft, ahead of its current contents.

Press Down with an empty prompt to select a running foreground subagent, then Enter for its details. Left/Right change the detail view; Esc returns. Click a saved task row to inspect earlier children. `/jobs` and Ctrl+B manage background work; see [background jobs](background-jobs.md).

Bindings can be overridden in `CIRCLE_HOME/keybindings.json`. `/hotkeys` shows the configured action names. Remaining interaction differences are recorded in [known issues](known-issues.md).
