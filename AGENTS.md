# Instructions for coding agents

Circle is a terminal coding agent written in TypeScript and run on Node.js 24. This file is for agents working on its source. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the human version.

Up to 0.5.0 Circle was written in Python. That code is in history at the tag `v0.5.0`, and it is the reference for how Circle should behave until the TypeScript version matches it: read it with `git show v0.5.0:circle/tui/session_app.py`, or check it out in a worktree.

## Commands

```bash
npm ci                                   # once; the compiler and tools are local
npm run check                            # type check, the whole suite and the build, about 20 seconds, no network
npx tsx --test tests/x.test.ts           # one file
npm run format                           # prettier; CI runs npm run format:check
npm run dev -- --version
CIRCLE_HOME=$(mktemp -d) npm run dev -- <folder>    # run with a scratch data folder
```

Never run Circle, a test or a trial against the real `~/.circle`. Use a scratch `CIRCLE_HOME`.

Never run `install.sh`, `install.ps1` or `src/install_manager.ts` by hand on a real machine: they find the Python circle through `HOME` and `PATH` and uninstall it. The tests and `npm run release:smoke` give them a home and PATH of their own.

## Where things are

`src/` is the program. `src/tui/` and `src/ink/` are the interface, `src/middleware/` and `src/model_guard.ts` are the reliability layers, `src/approvals.ts` is the safety policy. `docs/development/architecture.md` has the full map.

## Rules for the interface

Read `docs/development/tui-contract.md` before you change anything on screen. It was written for the Python version; where the TypeScript version differs, the contract is the target unless the user decided otherwise.

- Take colours only from `palette()` in `src/ink/theme.ts`. Do not write a hex value, a truecolor code or a raw colour SGR string anywhere else. `tests/render-colors.test.ts` fails if you do.
- When you join a background with a foreground, use `sgrJoin`.
- Interface words are English, short, lowercase. Never translate content.
- Check a change on a dark and on a light palette. The `auto` theme follows the terminal while Circle runs (`src/ink/theme_watch.ts`), so nothing may cache a colour past a repaint.
- Do not add key hints except where something is folded.

## Rules for tests

- Add a test with every behaviour change. Drive `ScriptedModel` from `src/testing.ts` or a local HTTP gateway; do not call a real model.
- Check real effects: the next model request, stored history, files and processes. Text on screen alone does not show that the runtime is right.
- Do not weaken or delete a failing test to get green. Fix the code or say why the test is wrong.
- Say what you ran. Do not report that tests pass unless you ran them.

## Rules for docs

`docs/` describes what the code does now. Check a claim against the code before you write it. If something does not work, write it in `docs/known-issues.md` rather than describing it as working. Do not commit changelog entries for things that are not merged.

## Rules for git

Several agents and people may work in this checkout at once.

- Do not commit or push unless the user asked you to.
- Stage explicit paths. Never `git add -A` or `git add .`, and never `git commit -a`.
- Do not reset, checkout over, stash or delete files you did not create. Look at `git status` and `git diff` before you touch a file that is already modified.
- For a separate line of work, use a worktree (`git worktree add ../circle-<topic> -b <branch>`) rather than switching branches in a shared checkout.
- Commit messages: one imperative English sentence, capitalised, no prefix, no full stop.

## Things that are easy to get wrong

- `circle --init` and `/login` are not safe places to experiment: both replace the saved endpoint, key and model.
- The version is in `package.json`, `package-lock.json` and `src/version.ts`. Change all three; `tests/version.test.ts` fails if they differ. Do not tag or publish a release unless the user asked.
- `install.sh`, `install.ps1`, `src/install_layout.ts`, `src/install_manager.ts`, `src/legacy_install.ts` and `src/update.ts` share one install layout (`versions/<version>/`, `current.ref`, `installation.json`) and one asset naming (`circle-<version>-<os>-<arch>`). Change them together; `tests/install-layout.test.ts`, `tests/legacy-install.test.ts` and `npm run release:smoke` pin it.
- Asset names must never match `circle-<os>-<arch>.tar.gz` or `.zip` without a version: that is what `circle update` in the Python releases looks for.
- The data folder is shared with the Python releases. Keep `settings.json` and `credentials.json` readable by them, and never write values that were given for one run only (`-m`, `--thinking`) into `settings.json`.
- `docs/development/port-inventory.json`, `baseline.json` and `upstream-updates.json` are working notes from the port, not proof that something matches.
