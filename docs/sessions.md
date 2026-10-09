# Sessions and context

Sessions live in `circle-next.sqlite` in the data folder. Every saved message receives an immutable checkpoint. A session's head selects its active branch; restarting and continuing uses that head, without replaying tools. An interrupted call missing a result is recorded as interrupted instead of being executed again.

`-c` resumes the latest conversation in the workspace. `/resume` selects a session, `/tree` selects an earlier point, `/fork` creates a session before a selected user message, and `/clone` copies the active branch. Going back changes conversation context, not files. `/undo` and `/redo` only alter the view.

Child sessions belong to their parent conversation and are excluded from ordinary session discovery. Forking clones the selected branch and its referenced children, so deleting the original conversation leaves the fork intact. Plan-mode boundaries restore the real read-only gate after restart and import.

## Projections

Model context is derived from the raw conversation. Large tool results are saved as exact bytes under the project's data folder and replaced in requests by an excerpt and a recoverable `/large_tool_results/` path. Full results remain in history and exports. Existing artifacts are checked against raw bytes; corrupt files are reported rather than overwritten.

Old unpruned tool output outside a recent 40,000-token window is shortened in batches of at least 20,000 estimated tokens. Questions, skills, complete JSON documents and the latest todo result are protected from this pruning pass. The batch records affected message IDs and already-existing thinking blocks; later responses do not lose their thinking unless a later batch affects them.

Compaction summarizes a balanced prefix, keeps recent messages and stores the earlier raw history under `/conversation_history/`. Summary and pruning versions belong to checkpoint ancestry. Branch selection and forks retain their own context decisions. Raw stored messages are never rewritten by compaction.

Automatic compaction uses the [model's context window and output reservation](models.md). Request estimates include system instructions and tools. `CIRCLE_PRUNE_TOOL_OUTPUTS=0` stops new prune decisions; previous recorded decisions remain deterministic. `CIRCLE_PRUNE_PROTECT_TOKENS` changes the recent window for future batches.

Persistent plan and loop reminders guide long tool sequences. They are marked separately from real user input and hidden from the transcript, Markdown and HTML exports. JSONL retains the raw records.

## Import and export

`/export` writes Markdown; `html`, `jsonl` or a filename selects another format. `circle --export <id> <file.jsonl>` also creates a native bundle. `/import <file.jsonl>` creates an independent conversation.

Version 3 JSONL bundles contain every checkpoint branch, selected head, labels, context versions, summary accounting and owned child-session history. A SHA-256 seal detects changes to the file. Import validates the graph and commits all sessions in one transaction, assigning fresh session/checkpoint identities while preserving raw message records. Long-output and history artifacts are reconstructed from those records in the receiving data directory. Account settings and credentials are supplied by the receiving installation.

Wait for the current turn and background subagents to finish before exporting from the TUI. Existing version 1 and version 2 message exports remain readable. Interrupted child histories remain inspectable records; importing a bundle starts no model call, tool, job or child agent.

Legacy indexed `sessions.sqlite` and `checkpoints.sqlite` files are read without modification. Logical conversations and nested child namespaces are imported into `circle-next.sqlite`, with private source archives and SHA-256 receipts. MessagePack and JSON are decoded as data; serialized Python constructors are never executed. Independent markers support adding child records to earlier migrations and prevent deleted records from reappearing. Unsupported data is reported per scope. See [migration details](development/migration-data.md).

## Subagent details

While foreground subagents run, press Down with an empty prompt to select an agent, then Enter to inspect its transcript. Left/Right switch details; Esc returns. Clicking a task row opens its saved details; when several children are available, choose one in the picker. Details display live or restored history without resuming the child.
