# Architecture

The application runs on Node.js 24 and uses TypeScript with strict compiler checks. The agent loop is owned by this repository; it does not depend on LangChain, LangGraph or Deep Agents.

## Runtime

`src/cli.ts` parses run options and selects terminal, line, print, JSON or RPC mode. `src/runtime.ts` assembles a model, tools, policy, prompts and session. `src/harness.ts` advances model and tool steps, consumes steering messages before the next request, and starts follow-ups after a turn finishes.

`src/model.ts` adapts OpenAI-compatible and Anthropic-compatible endpoints through protocol SDKs. Text, thinking, tool calls and usage are normalized at this boundary. `src/model_guard.ts` controls per-kind retries, rejected parameters, stalled streams, repetition and missing finish signals. `src/tool_call_compat.ts` repairs unambiguous read-only calls and validates arguments before effects. `src/types.ts` defines the messages and tool contracts used by the runtime.

## Effects and persistence

`src/tools.ts` implements filesystem and command tools. `src/sandbox.ts` resolves host and workspace paths, strips secret environment variables, and terminates command process groups on cancellation. This is a policy boundary, not an operating-system sandbox.

`src/approvals.ts` classifies commands, keeps session rules and decides which calls require an answer. Read-only mode blocks tools with write, execution or unknown effects. `src/settings.ts` protects account settings from project overrides and writes credentials separately.

`src/checkpoint_store.ts` stores immutable message checkpoints and session branch heads in SQLite. Model summaries are projections; raw messages and tool output stay intact. Append-only context versions attach summary and pruning decisions to checkpoint ancestry, so alternate branches retain their own projections. `src/context_middleware.ts` offloads large results, compacts balanced prefixes and recovers missing artifacts from the unchanged raw history. The native database is `circle-next.sqlite`. `src/migration.ts` imports indexed legacy sessions read-only with source receipts, retaining the original databases and never replaying tools.

`src/jobs.ts` owns background command processes, subagents, output files and conversation-specific notices. Foreground commands can be promoted without respawning. Notices enter checkpoints before model requests; the TUI, print and RPC runners decide when to resume an idle conversation. Child-owned processes are stopped before the child report completes. `src/tui/interaction_queue.ts` serializes complete approval/question card lifecycles.

## Terminal

`src/ink/` parses input and terminal colour reports, derives a readable palette, and renders components. `src/tui/` handles drafts, dialogs, pickers, commands, transcript views and model events. Colors come from the shared palette. UI words are short English labels; user and model content are retained as written.

`src/events.ts` isolates subscribers so a display failure cannot interrupt the runtime. The same runtime serves headless entry points. MCP connections are owned by `src/mcp_loader.ts`; each external tool passes through the same policy as built-in tools. `src/extensions.ts` stages registrations atomically, supplies typed model/tool middleware and hosts subagents, commands, renderers and events. `src/lsp_tool.ts` owns stdio language-server processes and bounded JSON-RPC requests. Release modules are added with their platform tests.
