# Session data migration

Circle 0.5.0 and older, the Python releases, kept sessions in two SQLite files in the data folder: `sessions.sqlite` describes workspace, title, model, timestamps and selected leaf; `checkpoints.sqlite` stores serialized checkpoints and pending writes. Every start of Circle (except with `--no-session`) imports the sessions it has not imported yet into `circle.sqlite` (`src/migration.ts`, `src/legacy_sessions.ts`, `src/legacy_codec.ts`, `src/legacy_message.ts`). The originals are opened read-only and stay as they are. No historical tool is replayed.

## Reconstruction

A checkpoint can contain an inline message snapshot or omit messages because the reducer stores them in ancestor writes. Reconstruction walks checkpoint ancestry and applies message writes in checkpoint order, then task ID and write index order. Snapshot seeds, message replacement, removal and overwrite operations are handled as data. A selected latest checkpoint can include completed pending message writes; an explicit selected leaf retains its exact historical state.

MessagePack constructor descriptors are decoded into plain records. Supported message types preserve original fields, thinking signatures and usage in `legacy_data`; unknown serialization formats fail explicitly. Pickle is not executed. JSON serialization uses the same record conversion.

## Import and receipts

Each logical session is imported in a database transaction. Native checkpoint boundaries preserve distinct context states even when two historical snapshots contain identical messages. Branches, selected leaf and labels are retained. A source/session marker makes import idempotent and prevents deleted sessions from reappearing. ID conflicts leave existing native data untouched.

`migration-backups/` under the data folder contains private archives of source checkpoint blobs, writes and index records. The native import receipt contains the source path, row counts, fingerprint and archive path. Child namespaces (subagents) are reconstructed independently as owned sessions, with nested parent links and per-namespace markers. Existing root imports can be augmented without importing the root again; deleted child records remain deleted. A session or child scope that cannot be reconstructed is reported when Circle starts (`Could not migrate …`); its raw rows are in the archive.

## Evidence

`tests/fixtures/legacy-baseline/` holds a controlled session written by the Python implementation at `645ac43`, with a real file-read result, signed thinking, two branches, an earlier selected leaf and a label, and `truth.json`: the 38 snapshots the Python reader returned for it. `manifest.json` records the SHA-256 of each compressed file. `tests/migration.test.ts` compares every reconstructed snapshot with `truth.json`, checks that the source databases keep their hashes, that a failed import rolls back the whole session and leaves a colliding native session alone, and that a continued session reaches a scripted model without replaying tools. Its namespace test copies the controlled rows into nested scopes and compares every imported snapshot the same way.
