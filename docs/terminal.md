# Terminal interface

The interface uses the terminal's foreground/background colors and a shared palette for messages, code, tools and panels. `/themes auto`, `/themes dark` and `/themes light` select the appearance.

## Reading

Answers, streamed answers, expanded thinking and subagent details render CommonMark/GFM headings, emphasis, links, code, lists, quotations and tables. Code uses the shared panel color. Ctrl+T shows thinking; Ctrl+O expands tool output. PageUp/PageDown scroll the current transcript.

Ctrl+F opens conversation find. Type to narrow the visible text; Enter/Down moves forward and Shift+Enter/Up moves backward. Esc closes find. The current match is highlighted without changing saved messages.

## Input

Up/Down browse earlier prompts and return to the unsent draft. Ctrl+R searches prompt history, newest first; another Ctrl+R cycles matches. Enter submits the selected prompt. Esc or Ctrl+C restores the draft. Multi-line prompts survive restart, with up to 1,000 entries and consecutive duplicates suppressed. `CIRCLE_HISTORY_PATH` overrides the history location.

Ctrl+J inserts a newline. Ctrl+G opens `$VISUAL`, then `$EDITOR`, or the platform default. The editor owns stdin while active. Returning restores raw input, mouse/paste handling and the full screen; edits replace the draft and are submitted with Enter.

Press Down with an empty prompt to select a running foreground subagent, then Enter for its details. Left/Right change the detail view; Esc returns. Click a saved task row to inspect earlier children. `/jobs` and Ctrl+B manage background work; see [background jobs](background-jobs.md).

Bindings can be overridden in `CIRCLE_HOME/keybindings.json`. `/hotkeys` shows the configured action names. Remaining interaction differences are recorded in [known issues](known-issues.md).
