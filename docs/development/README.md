---
nav_order: 24
has_toc: false
---

# Development

Install Node.js 24 or newer, then run `npm ci`. The compiler and every tool are installed into the checkout: `npx tsc --version` reports the TypeScript version in use.

| Command | Purpose |
|---|---|
| `npm run dev -- [options]` | Run Circle from the TypeScript source. |
| `npm run typecheck` | Strict type check, no output files. |
| `npm test` | The test suite, with Node's test runner through `tsx`. On CI a failing run goes once more with only its failed tests (`--test-rerun-failures`); a test that passes only then is named as flaky in the log. `npm --prefix apps/desktop run test:runtime` does the same for each stage. |
| `npm run build` | Compile into `dist/` and copy the prompts and data files. |
| `npm run check` | Type check, tests and build. |
| `npm run format` | Format the TypeScript sources and the root JSON files with prettier. |
| `npm run format:check` | Check the formatting, as CI does. |
| `npm run release -- X.Y.Z` | Set the version and date the changelog. See [Releasing](releasing.md). |
| `npm run release:build` | Build the package with its own Node.js for the current platform. |
| `npm run release:smoke` | Install, relocate and upgrade that package in a scratch home, install it to the default location there, reject a bad checksum, and run a real tool turn. |

Use a scratch `CIRCLE_HOME` for every test and every interactive run. The tests create their own folders, local model gateways and fake credentials; they never need a model account or the network.

Every change in behaviour needs a test that shows it: the next model request, the stored history, files and processes. Text on screen alone does not show that the runtime is right. Do not weaken a failing test to get green.

A pull request runs `npm run check` and the format check on Linux and Windows and builds and smoke-tests the Linux package (`.github/workflows/check.yml`); the merge queue runs the check on Linux, Apple silicon macOS and Windows on the commit that becomes `main`, and merges once all three pass. A draft pull request runs no CI until it is marked ready. Pull requests run no macOS jobs at all: the organization has five macOS runners, shared with `main` and releases. Every push to `main` builds and smoke-tests the release packages on all six targets (`.github/workflows/release.yml`) and runs the desktop application on Linux and both macOS architectures (`.github/workflows/workbench.yml`), and a later push does not cancel those runs; a pull request runs the release workflow only when it changes the installers, the release scripts, the version or the dependencies, and then without its macOS targets. A job that is configured is not a result: look at the run.

The English guides and reference in this folder are published at <https://circle-platforms.github.io/circle/>. `.github/workflows/pages.yml` builds the site. The TUI contract is in Chinese, and the desktop working notes are under `docs/workbench/`; both stay in the repository and are not pages on the site. Contributing, the security policy, the changelog, the [design specifications index](https://github.com/circle-platforms/circle/blob/main/docs/design/README.md) and the [open-source readiness record](https://github.com/circle-platforms/circle/blob/main/docs/open-source-readiness.md) stay in the repository too.

More:

- [Architecture](architecture.md): the module map.
- [The TUI contract](https://github.com/circle-platforms/circle/blob/main/docs/development/tui-contract.md): the rules for everything on screen. It is written in Chinese.
- [Releasing](releasing.md): cutting a release.
- [Register Circle in skills.sh](skills-registry.md).
