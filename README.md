# Circle

A terminal coding agent for your own model endpoint, written in TypeScript.

## Development

Requires Node.js 24 or newer. Dependencies and the TypeScript compiler are installed locally and pinned in `package-lock.json`.

```bash
npm ci
npm run typecheck
npm test
npm run build
node dist/cli.js --version
```

Run from source with `npm run dev -- [options]`, or run the compiled CLI with `node dist/cli.js [options]`. Use an isolated `CIRCLE_HOME` while developing:

```bash
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

The terminal interface asks for the API base URL, key, model and workspace trust. Configuration lives in `CIRCLE_HOME` (default `~/.circle`). API keys are stored separately from settings and are removed from tool subprocess environments.

```bash
node dist/cli.js -p "Summarize README.md" ~/code/my-project
node dist/cli.js -c ~/code/my-project
node dist/cli.js --mode json "List the TODOs" ~/code/my-project
node dist/cli.js --mode rpc ~/code/my-project
```

Print and RPC mode require initialized settings and a trusted folder. Mutating tools require approval; headless callers use `--yolo` for ordinary writes and commands. Operations that always ask remain blocked in headless mode.

See [RPC commands and events](docs/rpc.md) for the JSON line protocol, message formats and background-job shutdown behavior.

## Project layout

- `src/`: CLI, independent agent runtime, tools, policy, sessions and terminal interface.
- `src/ink/` and `src/tui/`: terminal input, themes, rendering and interaction.
- `src/prompts/`: model, agent, command and tool instructions.
- `tests/`: behavior tests using controlled models, local HTTP gateways and real filesystem/process effects.
- `scripts/`: development and build tasks.
- `docs/`: user and contributor documentation.

Use `npm run format` to format TypeScript and configuration, `npm run format:check` to check formatting, and `npm run check` for type checking, tests and compilation. CI is configured for Linux, macOS and Windows.

## Status

This is a development build, not the first stable release. The runtime and CLI execute turns, file tools, commands, approvals, session persistence, branching and streamed model responses without Python or an agent framework. The TUI is being validated against the established interaction style.

MCP, TypeScript/JavaScript extensions and LSP are connected through the runtime. [Background jobs](docs/background-jobs.md) support shell commands, subagents and completion notices. Indexed legacy sessions are imported read-only into the native database; original databases remain unchanged. Full command and terminal parity, provider profiles, cross-platform packaging and one-command installation remain under development. Use isolated data while developing.

See [installation and updates](docs/installation.md), [terminal controls](docs/terminal.md), [architecture](docs/architecture.md), [development](docs/development/README.md), and [known issues](docs/known-issues.md). License selection is pending.
