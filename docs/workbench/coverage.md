# Frontend coverage and limits

The desktop workbench is implemented under `apps/desktop` and `apps/workbench`. The current scope is a native application frontend with Circle and platform component interactions. Model execution and production platform services remain separate integration work.

| Requirement | Frontend evidence | Runtime boundary |
|---|---|---|
| Standalone application | Electron window, app icon/menu, bundled resources, `.app` / `.dmg` build and packaged-app tests | No web server needed |
| Native operations | Selected files/folders, scoped reads, clipboard and native export checked through IPC | File edits and shell commands remain requests |
| Browser display | Sandboxed native browser, actual local-fixture navigation and capture, stable session identity | Local operator only; agent connection pending |
| Circle commands | All 38 current commands and aliases mapped; each canonical command exercised in the native UI | Runtime actions have explicit local/pending state |
| Tool presentation | 22 documented entries, including the subagent-only tool; generic raw input/output renderer | No tool execution inferred from sample rows |
| Conversations | Free input, persistent drafts, steering/follow-up queues, attachments, search and expanded draft editor | No invented response or automatic task classification |
| Session history | Session picker, name/delete, tree/labels, fork/clone, presentation undo/redo, local export/import | Native Circle JSONL validation/export requires runtime |
| Plans and interactions | Plan view, read-only/auto presentation, approval/question/secret/plan-exit views | Local decisions do not grant real permissions |
| Models and setup | Model/depth/default controls, endpoint form, bounded secret input and secret discard | No endpoint queried, credentials not saved |
| Jobs and subagents | Record views, output, state, stop intentions and sample agent transcripts | A stop intention is not a stopped process |
| Skills/commands/MCP/extensions | Catalogs, context loading, template/config editing, reload requests and interface-component toggles | No extensions loaded or MCP programs started |
| Settings | Theme/type scale, protected-file patterns, trust review, key preferences, launch/update drafts | Real Circle settings and data are untouched |
| B knowledge | Source filtering/import/revision viewing and pinned context attachment | Local preview store |
| C work | Session-linked work draft, status and pause/cancel intents | No durable service acceptance asserted |
| D execution | Workspace/worker/SSH/browser records and control intents | Synthetic remote observations |
| E methods | Per-session loading, version pins, candidate review and role feedback | Loading and review do not publish a method |
| Plugin framework | Shared registration, dependencies, conflicts, enable/disable, pages/panels/widgets/actions and rendering boundaries | First-party bundled modules only |

Automated checks are in the two application packages. Validation receipts bind actual checks and build bytes; they do not promote schema validity, sample status or UI feedback into an observed backend outcome.

Native folder grants are currently scoped to the host process. After a restart, reopen a selected folder to refresh its grant. Saved conversations and pinned input remain available. UI caches do not replace a production knowledge/evidence store.

The browser layout server is optional development tooling. It is not the requested application deliverable.
