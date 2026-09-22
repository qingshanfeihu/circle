Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When `custom` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" to the end of the label

Secrets (passwords, tokens, credentials):
- For any secret, add `secret: true` plus `key` (ENV-style name, e.g. `JUMPHOST_PASS`) and
  `target_file` (the env file the value should land in, e.g. `~/.config/compile-excel/env`).
- The user types the value in a masked input (Ctrl+S when prompted); the harness writes
  `KEY=value` (file mode 600) and the tool result only confirms collection — the value
  NEVER enters this conversation. Do not ask for secrets in plain questions.
- If secret collection reports unavailable/failed, tell the user to write the credential
  into the target file themselves; never fall back to collecting it in chat.
