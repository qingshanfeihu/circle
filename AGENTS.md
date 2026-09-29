# Instructions for coding agents

Circle is a terminal coding agent written in Python (3.11 or newer). This file is for agents working on its source. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the human version.

## Commands

```bash
python -m pytest -q                       # the whole suite, about 25 seconds, no network
python -m pytest tests/test_x.py -q       # one file
python -m circle --version
CIRCLE_HOME=$(mktemp -d) python -m circle <folder>    # run with a scratch data folder
```

Install the dev extras first: `pip install -e '.[dev]'`. Never run Circle, a test or a trial against the real `~/.circle`. Use a scratch `CIRCLE_HOME`.

## Where things are

`circle/` is the package. `circle/tui/` and `circle/ink/` are the interface, `circle/middleware/` and `circle/model_guard.py` are the reliability layers, `circle/approvals.py` is the safety policy. `docs/development/architecture.md` has the full map.

## Rules for the interface

Read `docs/development/tui-contract.md` before you change anything on screen.

- Take colours only from `circle.ink.theme.palette()`. Do not write a hex value, a truecolor code or a raw SGR string in a component. `tests/test_render_colors.py` fails if you do.
- When you join a background with a foreground, use `theme.sgr_join`. The renderer recomputes each inline colour code from the base style, so a background written as its own code covers only the first cell.
- Interface words are English, short, lowercase. Never translate content.
- Check a change on a dark and on a light palette. `tests/test_theme_matching.py` shows how. The `auto` theme follows the terminal while Circle runs (`circle/ink/theme_watch.py`), so nothing may cache a colour past a repaint.
- Do not add key hints except where something is folded.

## Rules for tests

- Add a test with every behaviour change. Drive `circle.testing.ScriptedModel`; do not call a real model.
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

- `circle --init` and `/login` are not safe places to experiment: `--init` resets settings, and OAuth is not implemented.
- The version is in two places, `pyproject.toml` and `circle/__init__.py`. Change both.
- `circle_harness.py` at the root is a compatibility shim. Import `circle.harness` in new code.
- One test in `tests/test_extensions.py` is skipped unless an optional sibling checkout exists. The skip is expected.
