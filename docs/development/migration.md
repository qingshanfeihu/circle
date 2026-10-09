# The TypeScript port

Up to 0.5.0 Circle was a Python program built on deepagents and LangGraph; that code is at the tag `v0.5.0`. 1.0 is a rewrite in TypeScript for Node.js 24 with its own agent loop. This page is a record of how the port was done and where its evidence is. For the code as it is now, read [Architecture](architecture.md).

## How it was done

1. **A fixed reference.** The rewrite started from 0.4.0, commit `645ac43`. The files that define its behaviour (the CLI, the harness, the session screen and theme, their contract tests, and the TUI contract, interface, keys, CLI, sessions and configuration pages) were recorded with their hashes in `baseline.json`. The work that became 0.5.0 (background jobs, the models.dev catalog, the compaction row; up to commit `472f5e3`) was recorded later as a second reference in `upstream-updates.json`.
2. **A separate tree.** The TypeScript version was built in its own tree, `circle-next`: the runtime and terminal interface; MCP, extensions and LSP; guarded model requests and context; the import of Python sessions; secrets and questions; background jobs, the models.dev catalog and compaction progress; release packages and installers. Each of the 319 files of the reference was listed in `port-inventory.json` with its hash, a category, a target and a status.
3. **The merge.** The Python implementation was removed from this repository (`d08fb0d`), the rewrite merged in (`f90e228`), and the program named `circle` and numbered 1.0.0 (`da790e3`). The installers learned to replace a Python circle and keep the data folder.
4. **Back to 0.5.0's behaviour.** One area at a time, each on its own branch, the interface and commands were compared with `git show v0.5.0:…` and brought to what 0.5.0 did, with tests: mouse selection and the clipboard (`unify/selection`), the input box (`unify/composer`), the cards (`unify/cards`), the header, footer, strip, welcome and rows (`unify/status`), the slash commands (`unify/commands`), the CLI options and `grep` (`unify/cli`), the compaction row, subagent pages and job lines (`unify/status2`), proxies and MCP naming (`unify/fix-net`), and concurrent subagents and queues on `esc` (`unify/fix-turns`). The user documentation was then checked against the code.

## Where the evidence is

- **Behaviour:** the tests in `tests/`. Many name the 0.5.0 behaviour they pin; they drive a scripted model or a local gateway and check requests, stored history, files and processes.
- **Sessions:** `tests/fixtures/legacy-baseline/` and `tests/migration.test.ts`. See [Session data migration](migration-data.md).
- **Installing over a Python circle:** `tests/legacy-install.test.ts` and `npm run release:smoke`.
- **What 0.5.0 users notice:** `## Unreleased` in `CHANGELOG.md`.
- **What still differs:** [Known issues](../known-issues.md), and "not yet" in [The TUI contract](tui-contract.md#8-尚未落地的部分).
- **The Python code:** the tag `v0.5.0`. AGENTS.md says how to read it.

## The inventories are historical

`port-inventory.json`, `upstream-updates.json` and `baseline.json` are the working notes of the port. Their statuses (`pending`, `in-progress`, `reference-copied`) were written while the work was under way and were not kept up to date as it landed. They say nothing about the code now and are not proof that anything matches 0.5.0. `npm run port:status` still counts the inventory's entries by status.
