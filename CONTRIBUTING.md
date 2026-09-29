# Contributing to Circle

Thanks for helping. This page is what you need to make a change that can be merged.

## Before you start

- **Bugs.** Open an issue with the bug report form. Say the version, your terminal and what you did.
- **Ideas and larger changes.** Open an issue first and describe the problem you want solved. A change that reshapes how Circle looks or behaves is easier to agree on before the code exists than after.
- **Small fixes.** A small fix can go straight to a pull request.

## Set up

Circle needs Python 3.11 or newer.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
```

Run it from source with `circle`, or `python -m circle <folder>`. To keep your real settings safe, point it at a scratch data folder:

```bash
CIRCLE_HOME=$(mktemp -d) circle ~/some/project
```

## Test

```bash
python -m pytest -q
```

The suite runs in under a minute and needs no network or model. Tests drive a scripted model and render the interface headlessly. Add a test with every behaviour change. Look at a neighbouring test for the pattern.

Two groups of tests guard the interface and will fail if a change breaks its rules:

| Tests | Guard |
|---|---|
| `tests/test_render_colors.py` | No colour outside the palette, no retired glyphs. |
| `tests/test_tui_contract.py`, `tests/test_display_contract.py` | Where information goes and how it looks. |
| `tests/test_theme_matching.py`, `tests/test_theme_watch.py` | Contrast on dark and light terminals, and following the terminal when its theme changes. |

## Change the interface

Read [The TUI contract](docs/development/tui-contract.md) first. In short:

- Each piece of information belongs to one zone. Do not add a new way to show something that an existing zone already covers.
- Take colours only from `circle.ink.theme.palette()`. Never write a colour code or a hex value in a component.
- Interface words are English, short and lowercase. Content (what you and the model wrote) is never translated.
- Key hints appear only where something is folded. Do not add hints for obvious keys.
- Check your change on a dark and a light background.

## Change the docs

Files in `docs/` describe what the code does today. If you change behaviour, change the page that mentions it in the same pull request. State limits plainly. Do not document what does not work as if it did; put it in [Known issues](docs/known-issues.md).

## Commit messages

One short imperative sentence in English, capitalised, with no prefix and no full stop, for example `Replace subagents by name when extensions register duplicates`. Put the why in the pull request.

## Pull requests

- Keep a pull request to one change.
- Run the tests and say so in the description.
- Fill in the checklist in the template.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
