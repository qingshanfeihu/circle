# Known issues

This development build has not completed full compatibility or release acceptance.

- RPC message serialization and several terminal/account interactions need further compatibility checks. Usage is persisted with completed model messages.
- Secret-question collection and several account interactions remain under development.
- TUI search, external-editor input ownership, configurable picker actions, plan scrolling, queue display, Markdown presentation and several shortcuts need further parity work.
- Legacy JSONL can be imported, but existing SQLite history and Python extension code are not automatically migrated.
- Provider model profiles, multimodal input and some terminal-facing recovery details still need parity work. Retry, parameter downgrade, batch pruning and long-output offloading have focused runtime tests.
- Current source checks run on Linux, macOS and Windows. One-command installers and release artifacts are not published.
- OAuth is unavailable. There is no operating-system sandbox.

Current checks cover strict TypeScript compilation, controlled protocol streams, command cancellation, approvals, raw history, branch selection, file effects and core terminal component behavior. They do not establish all-provider or all-terminal compatibility.
