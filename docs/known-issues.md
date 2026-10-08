# Known issues

This development build has not completed full compatibility or release acceptance.

- RPC message serialization and several terminal/account interactions need further compatibility checks. Usage is persisted with completed model messages.
- Several account interactions remain under development. Question panels and masked secret collection now have focused behavior and terminal validation.
- TUI search, external-editor input ownership, configurable picker actions, plan scrolling, queue display, Markdown presentation and several shortcuts need further parity work.
- Background shell/subagent jobs, cancellation, output and persisted notices have runtime tests. Extension watches, job-trigger interruption of bare sleeps, reminder cadence, all background-card ordering cases and Windows adoption after a shell exits still need compatibility work.
- Indexed legacy SQLite sessions are migrated read-only into the native database. Legacy subagent namespace records are archived but their detail views need further migration work. Python extension code must be rewritten.
- Multimodal input and additional provider/terminal recovery cases still need parity work. Catalog refresh, model-profile fitting, usage/pricing, compaction progress, retry, parameter downgrade and raw-history projections have focused runtime tests. JSONL currently exports main-conversation messages; supplemental summary/subagent accounting needs export/import coverage.
- Current source checks run on Linux, macOS and Windows. One-command installers and release artifacts are not published.
- OAuth is unavailable. There is no operating-system sandbox.

Current checks cover strict TypeScript compilation, controlled protocol streams, command cancellation, approvals, raw history, branch selection, file effects and core terminal component behavior. They do not establish all-provider or all-terminal compatibility.
