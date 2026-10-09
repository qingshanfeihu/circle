# Development

Install Node.js 24+, then run `npm ci`. The compiler is local: `npx tsc --version` reports the installed TypeScript version.

| Command | Purpose |
|---|---|
| `npm run dev -- [options]` | Run TypeScript source |
| `npm run typecheck` | Strict type checks without emission |
| `npm test` | Run behavior tests with Node's test runner through tsx |
| `npm run build` | Compile the CLI and copy prompt resources |
| `npm run check` | Type check, test, and build |
| `npm run format` | Format TypeScript and root JSON configuration |
| `npm run format:check` | Check formatting |
| `npm run port:status` | Inspect the development migration inventory |
| `npm run release:build` | Build a runtime-inclusive package for the current target |
| `npm run release:smoke` | Exercise relocation, install, upgrade, checksum rejection and a real tool turn |

Use a scratch `CIRCLE_HOME` for every test or interactive development run. Tests create temporary workspaces, local mock gateways and fake credentials; they never need a real model account.

Every behavior change requires an observable regression test. Verify model requests, stored history and real effects; screen text alone does not establish runtime correctness. Never weaken a failing test to make a migration appear complete.

The fixed reference and migration inventory are development receipts, not product documentation or proof of compatibility. A file marked `in-progress` has an implementation under development, not complete parity acceptance. CI is configured for Linux, macOS and Windows; a configured job is not a successful platform result.

Do not overwrite the root `AGENTS.md` during this migration. Keep terminal colors in the shared palette and retain the existing interaction style. Release validation must include installation, relocation, checksum rejection, upgrade retention, and runtime smoke tests on each target.
