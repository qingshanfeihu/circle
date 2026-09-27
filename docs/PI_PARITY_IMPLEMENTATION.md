# Pi parity implementation and evidence

Baseline: Circle `c0bafb5`; Pi coding agent/model SDK `0.87.1`.

The implementation keeps Deep Agents as the sole agent engine. The Pi dependency
is its public model/auth SDK, not the Pi coding-agent loop. LangGraph owns message
state and checkpoints; Circle stores logical-session pointers and derived UI caches.

## Implemented behavior

- Durable logical sessions, selected-checkpoint execution, forks/clones without
  raw checkpoint copying, restart discovery, real conversation undo/redo, native
  message-ID tree projection, and explicit legacy-thread adoption.
- Shared runtime for the line/print/JSON/ACP interfaces; native async SQLite
  execution in the TUI, including cancellation of a waiting native model request.
- Tool effect registry, MCP approval despite read-only annotations, plan-mode
  refusal before handlers, exact workspace plan-file exception, SDK filesystem
  permissions, and run-scoped shell-process cancellation.
- Mid-run steering through LangChain before-model middleware; follow-up queue
  stays after the current run. Native subagent configuration supports explicit
  filesystem tools, skills and per-agent models.
- Named LangChain connections and Pi model/auth adapter, complete tool-call and
  thinking-signature preservation, upstream provider catalog, browser/device
  authentication callbacks, and separate locked provider credential storage.
- Python extension packages via entry points and uv-built versioned environments;
  plugin install/remove/update, enable/disable, provider/shortcut/flag registration.
- File references and completion, standard image input blocks, clipboard-image
  input via Pillow, configurable keys, applied themes, and full structured JSON
  conversation export/import alongside Markdown/HTML exports.
- Microsoft multilspy replaces handwritten LSP transport; Python definition
  lookup is verified against a real Jedi language server.
- Bundled Python/Node/uv runtime release builder, Python and npm lock files,
  six target runner jobs, relocation smoke, checksums, retained previous versions,
  Unix and PowerShell installers, and push/PR checks.

## Verification recorded during implementation

- Existing and new suite reached **426 passed, 1 skipped** before the final
  clipboard/initialization edits. Run the suite again at the final commit.
- Real local integration tests exercised MCP stdio loading/approval/execution,
  the official ACP adapter's durable load/replay, plugin package installation and
  entry-point loading, a local OpenAI Responses stream through the actual Pi SDK,
  and a real Python language-server definition request.
- Current configured `claude-sonnet-5` gateway returned the exact requested marker
  in a bounded live model call: 18 input + 5 output tokens, `end_turn`. This verifies
  that connection only, not every provider or subscription account.
- A macOS arm64 bundled-runtime archive was built, and its launcher/model catalog
  worked after relocation to a directory containing spaces. Rebuild after the
  final source changes; the earlier archive is not a final-head release receipt.
- The original main checkout is preserved, including its untracked `quicksort.py`.

## Acceptance boundaries

The provider catalog has 41 providers and 1495 models; catalog presence is not a
live connectivity verdict. Subscription OAuth requires actual account login.
Five other platform builds and their installation/upgrade behavior still require
target-runner results. No GitHub Release or tag was published during local work.

The v3 LangGraph event protocol is experimental; the exact framework versions are
locked and protocol changes need explicit tests. Plan mode and approval are action
controls, not an operating-system sandbox for trusted Python extension code.

Direct compatibility with third-party Pi TypeScript packages is outside the
agreed scope. Do not describe these changes as complete Pi parity until the
remaining live-account/platform acceptance matrix has receipts.

## Commands

```sh
uv sync --frozen --all-extras
npm ci --ignore-scripts --prefix circle/node
uv run --frozen --all-extras pytest -q
circle -p 'task' --session example
circle -p 'task' --mode json
circle --mode rpc                 # ACP over stdio
circle --list-models
circle auth login openai
circle plugins install ./my-plugin
uv run --frozen --all-extras python scripts/build_runtime_release.py
```

Plugins expose `circle.extensions` entry points pointing to `register(api)`.
Core framework dependencies are constrained to the host versions. Failed plugin
installation leaves the previous generation active. `/extensions reload` loads
the selected generation when the agent is idle.
