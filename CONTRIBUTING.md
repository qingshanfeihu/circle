# Contributing to Circle

Thanks for helping. This page is what you need to make a change that can be merged. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs.** Open an issue with the bug report form. Say the version, your terminal and what you did.
- **Ideas and larger changes.** Open an issue first and describe the problem you want solved. A change that reshapes how Circle looks or behaves is easier to agree on before the code exists than after.
- **Small fixes.** A small fix can go straight to a pull request.

## Set up

Circle needs Node.js 24 or newer. The TypeScript compiler and every tool are installed into the checkout.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
npm ci
```

Run it from source with `npm run dev -- <folder>`, or build it with `npm run build` and run `node dist/cli.js <folder>`. To keep your real settings safe, point it at a scratch data folder:

```bash
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/some/project
```

Up to 0.5.0 Circle was written in Python; that code is at the tag `v0.5.0`.

## Test

```bash
npm run check          # type check, tests and build
npm run format:check   # formatting, as CI checks it
```

The suite runs in well under a minute and needs no network or model. Tests drive a scripted model or a local HTTP gateway and check real effects: the next model request, stored history, files and processes. Add a test with every behaviour change. Look at a neighbouring test for the pattern.

Some tests guard the interface and will fail if a change breaks its rules:

| Tests | Guard |
|---|---|
| `tests/render-colors.test.ts` | No colour outside the palette. |
| `tests/interface.test.ts` | Contrast on dark and light terminals, and how rows are laid out. |

## Change the interface

Read [The TUI contract](docs/development/tui-contract.md) first. In short:

- Each piece of information belongs to one zone. Do not add a new way to show something that an existing zone already covers.
- Take colours only from `palette()` in `src/ink/theme.ts`. Never write a colour code or a hex value in a component.
- Interface words are English, short and lowercase. Content (what you and the model wrote) is never translated.
- Key hints appear only where something is folded. Do not add hints for obvious keys.
- Check your change on a dark and a light background.

## Releases

Add a line under `## Unreleased` in `CHANGELOG.md` with every change a user would notice. The version is in `package.json`, `package-lock.json` and `src/version.ts`; maintainers change all three and push a tag. See [Releasing](docs/development/releasing.md).

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

## License

Circle is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are released under it too.
