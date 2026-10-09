# Development

Install Node.js 24 or newer, then run `npm ci`. The compiler and every tool are installed into the checkout: `npx tsc --version` reports the TypeScript version in use.

| Command | Purpose |
|---|---|
| `npm run dev -- [options]` | Run Circle from the TypeScript source. |
| `npm run typecheck` | Strict type check, no output files. |
| `npm test` | The test suite, with Node's test runner through `tsx`. |
| `npm run build` | Compile into `dist/` and copy the prompts and data files. |
| `npm run check` | Type check, tests and build. |
| `npm run format` | Format the TypeScript sources and the root JSON files with prettier. |
| `npm run format:check` | Check the formatting, as CI does. |
| `npm run release -- X.Y.Z` | Set the version and date the changelog. See [Releasing](releasing.md). |
| `npm run release:build` | Build the package with its own Node.js for the current platform. |
| `npm run release:smoke` | Install, relocate and upgrade that package in a scratch home, replace a Python circle there, reject a bad checksum, and run a real tool turn. |
| `npm run port:status` | Count the entries of the port inventory by status. It is a record of the port, not of the code; see [The TypeScript port](migration.md). |

Use a scratch `CIRCLE_HOME` for every test and every interactive run. The tests create their own folders, local model gateways and fake credentials; they never need a model account or the network.

Every change in behaviour needs a test that shows it: the next model request, the stored history, files and processes. Text on screen alone does not show that the runtime is right. Do not weaken a failing test to get green.

CI runs `npm run check` and the format check on Linux, macOS and Windows (`.github/workflows/check.yml`), and builds and smoke-tests the release packages (`.github/workflows/release.yml`). A job that is configured is not a result: look at the run.

More:

- [Architecture](architecture.md): the module map.
- [The TUI contract](tui-contract.md): the rules for everything on screen.
- [Releasing](releasing.md): cutting a release.
- [The TypeScript port](migration.md) and [Session data migration](migration-data.md): how 0.5.0 became 1.0.
- [Register Circle in skills.sh](skills-registry.md).
