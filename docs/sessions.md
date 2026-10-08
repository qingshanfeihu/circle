# Sessions and context

Sessions live in `circle-next.sqlite` in the data folder. Every saved message receives an immutable checkpoint. A session's head selects its active branch; restarting and continuing uses that head, without replaying tools. An interrupted call missing a result is recorded as interrupted instead of being executed again.

`-c` resumes the latest conversation in the workspace. `/resume` selects a session, `/tree` selects an earlier point, `/fork` creates a session before a selected user message, and `/clone` copies the active branch. Going back changes conversation context, not files. `/undo` and `/redo` only alter the view.

## Projections

Model context is derived from the raw conversation. Large tool results are saved as exact bytes under the project's data folder and replaced in requests by an excerpt and a recoverable `/large_tool_results/` path. Full results remain in history and exports. Existing artifacts are checked against raw bytes; corrupt files are reported rather than overwritten.

Old unpruned tool output outside a recent 40,000-token window is shortened in batches of at least 20,000 estimated tokens. Questions, skills, complete JSON documents and the latest todo result are protected from this pruning pass. The batch records affected message IDs and already-existing thinking blocks; later responses do not lose their thinking unless a later batch affects them.

Compaction summarizes a balanced prefix, keeps recent messages and stores the earlier raw history under `/conversation_history/`. Summary and pruning versions belong to checkpoint ancestry. Branch selection and forks retain their own context decisions. Raw stored messages are never rewritten by compaction.

Automatic compaction starts at roughly 85% of the configured context window. The default is 200,000 estimated tokens; `CIRCLE_CONTEXT_WINDOW` overrides it. These are character-based estimates, not provider token counts. `CIRCLE_PRUNE_TOOL_OUTPUTS=0` stops new prune decisions; previous recorded decisions remain deterministic. `CIRCLE_PRUNE_PROTECT_TOKENS` changes the recent window for future batches.

Persistent plan and loop reminders guide long tool sequences. They are marked separately from real user input and hidden from the transcript, Markdown and HTML exports. JSONL retains the raw records.

## Import and export

`/export` writes Markdown; `html`, `jsonl` or a filename selects another format. `/import` creates a session from an export. Existing JSONL version 1 records are accepted; native exports include the complete message records. When indexed legacy `sessions.sqlite` and `checkpoints.sqlite` files exist, startup reads them without modifying the original databases and imports supported logical sessions into `circle-next.sqlite`. Full source rows are archived with SHA-256 receipts. The importer reads MessagePack and JSON as data and never runs serialized Python constructors. Already imported sessions are skipped, and deleting a native session does not re-import it on startup. Unsupported data is reported per session.
