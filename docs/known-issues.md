# Known issues

This development build has not completed full compatibility or release acceptance.

- RPC compatibility envelopes, job commands/events, model/thinking changes and input-close task cleanup have focused runtime checks and frozen serialization samples. Remaining streamed usage/notice details and several terminal/account interactions need further compatibility checks. Usage is persisted with completed model messages.
- Several account interactions remain under development. Question panels and masked secret collection now have focused behavior and terminal validation.
- Markdown presentation, find/history search and external-editor input ownership have scoped tests and real terminal validation. Configurable picker actions, plan scrolling, queue display, remaining shortcuts and more terminal/Unicode boundary cases still need parity work.
- Background shell/subagent jobs, extension watches, cancellation, output, bare-sleep wakeups and persisted notices/reminders have scoped runtime tests. Remaining wake/card ordering cases and Windows adoption after a shell exits still need compatibility work.
- Indexed legacy SQLite sessions and child namespaces are migrated read-only into owned native records. Basic live/restored child details have runtime and terminal checks; complete subagent presentation and interaction parity remains under development. Python extension code must be rewritten.
- Workspace mentions, image/PDF file reads, MCP media results and durable attachment bytes have controlled OpenAI/Anthropic protocol tests. Audio/video, remote legacy media URLs, media token estimation and additional provider/terminal recovery cases still need parity work. Catalog refresh, model-profile fitting, usage/pricing, compaction progress, retry, parameter downgrade and raw-history projections have focused runtime tests. Native JSONL bundles retain branches, context and child/summary accounting; old clients need version 3 support to read them.
- Source checks run on Linux, macOS and Windows. Runtime packages, one-command installers and update support have native implementations; per-target distribution checks run separately. The first public release is not published until full acceptance finishes.
- OAuth is unavailable. There is no operating-system sandbox.

Current checks cover strict TypeScript compilation, controlled protocol streams, command cancellation, approvals, raw history, branch selection, file effects and core terminal component behavior. They do not establish all-provider or all-terminal compatibility.
