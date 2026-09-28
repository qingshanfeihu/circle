# Pi parity implementation and evidence

Baseline: Circle `c0bafb5`; Pi coding agent/model SDK `0.87.1`.
Scope: Pi default coding-agent capabilities plus the official plan/todo/subagent
workflows, with functional adapters rather than TypeScript plugin or wire compatibility.

The implementation keeps Deep Agents as the sole agent engine. The Pi dependency
is its public model/auth SDK, not the Pi coding-agent loop. LangGraph owns message
state and checkpoints; Circle stores logical-session pointers and derived UI caches.
Framework and dependency choices were checked against the ecosystem-primer,
Deep Agents, LangChain middleware/dependencies and LangGraph persistence/HITL skills.
The Python process-control and preview adapters reuse
[psutil](https://psutil.io/) and
[Rich Pixels](https://pypi.org/project/rich-pixels/3.0.1/).

## Implemented behavior

- Durable logical sessions, selected-checkpoint execution, forks/clones without
  raw checkpoint copying, restart discovery, real conversation undo/redo, all-branch
  native message-ID tree projection after restart, and explicit legacy-thread adoption.
  A file lock prevents concurrent writers from different processes.
- Shared runtime for the TUI/line/print/JSON/ACP interfaces; native async SQLite
  execution in the TUI, including cancellation of a waiting native model request.
- Tool effect registry, MCP approval despite read-only annotations, plan-mode
  refusal before handlers, exact workspace plan-file exception, SDK filesystem
  permissions, and run-scoped shell-process cancellation. Windows termination
  uses psutil; verification checks the child PID separately from framework teardown.
  Input entered during cancelled-run teardown is retained for a fresh turn.
- Mid-run steering through LangChain before-model middleware; follow-up queue
  stays after the current run. Steering is consumed only by the parent; read-only,
  configured and SDK general-purpose children share the effect boundary. Native
  subagent configuration supports explicit
  filesystem tools, skills and per-agent models.
- Named LangChain connections and Pi model/auth adapter, complete tool-call and
  thinking-signature preservation, upstream provider catalog, browser/device
  authentication callbacks, and separate locked provider credential storage.
  Internal credential files remain denied even with custom file patterns; Node
  credential writes set private POSIX modes or native Windows ACLs before writing.
- Python extension packages via entry points and uv-built versioned environments;
  plugin install/remove/update, enable/disable, provider/shortcut/flag registration,
  dependency constraints and fresh imports after an idle generation reload.
- File references and completion, standard image input blocks, clipboard-image
  input via Pillow, automatic image size/orientation handling with coordinate
  disclosure, inline terminal-cell thumbnails via Rich Pixels, configurable keys
  and applied themes. Structured JSON export/import
  preserves all branch conversations, tool-call identities, todos and native
  compaction summaries. Import settles native scheduled nodes without replaying tools.
- Microsoft multilspy replaces handwritten LSP transport; Python definition
  lookup is verified against a real Jedi language server.
- Bundled Python/Node/uv runtime release builder, Python and npm lock files,
  five target runner jobs, relocation smoke, checksums, retained previous versions,
  Unix and PowerShell installers, and push/PR checks. Target-runner installation
  smoke exercises installation, retained-generation upgrade, and checksum rejection.

## Verification recorded during implementation

- Code commit `05cbaa5fbb626f930c16fe49ab89e7f661f6690b` passed the local suite:
  **440 passed, 1 skipped**. The skip requires an adjacent external compile-excel
  installer checkout; it is not treated as executed coverage. Two warnings are
  the framework's experimental v3 streaming notice.
- [Push CI](https://github.com/qingshanfeihu/circle/actions/runs/36368242910)
  passed on the same code commit.
- Real local integration tests exercised MCP stdio loading/approval/execution,
  the official ACP adapter's durable load/replay, plugin package installation and
  entry-point loading, a local OpenAI Responses stream through the actual Pi SDK,
  and a real Python language-server definition request.
- Current configured `claude-sonnet-5` gateway returned the exact requested marker
  in a bounded live model call: 18 input + 5 output tokens, `end_turn`. This verifies
  that connection only, not every provider or subscription account.
- A macOS arm64 archive from an earlier implementation commit was built and
  relocated to a directory containing spaces. The current installer was then
  exercised against it: install, upgrade, retained prior generation and corrupt
  checksum rejection passed. This is a local installer receipt, not a final-head
  artifact receipt; the target-runner matrix supplies those.
- The original main checkout is preserved, including its untracked `quicksort.py`.

## Acceptance boundaries

The provider catalog has 41 providers and 1495 models; catalog presence is not a
live connectivity verdict. Subscription OAuth requires actual account login.
The current release targets are Linux and macOS on x86_64/ARM64, plus Windows
x86_64. All five [target jobs](https://github.com/qingshanfeihu/circle/actions/runs/36368243504)
passed tests, build, relocation, installation, retained-generation upgrade and
corrupted-checksum rejection on the code commit above. The
[five-target receipt](receipts/pi-parity-05cbaa5.json) records each job and the
five GitHub artifact ZIP digests; target installers checked the inner tarball
checksums. No GitHub Release or tag was published.
The earlier [six-target run](https://github.com/qingshanfeihu/circle/actions/runs/36347098564)
and [receipt](receipts/pi-parity-e8d7390.json) remain unchanged as historical
evidence, including the former x64-Python compatibility artifact for Windows ARM64.
That artifact is outside the current support scope.

The v3 LangGraph event protocol is experimental; the exact framework versions are
locked and protocol changes need explicit tests. Plan mode and approval are action
controls, not an operating-system sandbox for trusted Python extension code.

Windows ARM64 is currently unsupported. The release matrix omits it; the
Windows installer and manual release builder reject it before downloading or
creating an artifact. `langgraph-checkpoint-sqlite==3.1.1` requires sqlite-vec,
whose [pinned 0.1.9 release](https://pypi.org/project/sqlite-vec/0.1.9/) has no
Windows ARM64 wheel. A future native target
needs a supported upstream wheel and separate acceptance receipts.

Direct compatibility with third-party Pi TypeScript packages is outside the
agreed scope. Do not describe these changes as complete Pi parity until the
remaining live-account and real visual-model acceptance has receipts. Terminal
previews use cell thumbnails; high-resolution Kitty/iTerm rendering in the Circle
UI is not claimed. Interactive terminal/font compatibility is distinct from the
platform-runner build and install receipts.

## Target receipts

| Target | Test/build/relocate/install/upgrade/checksum refusal | Python runtime |
|---|---|---|
| Linux x86_64 | PASS | x86_64 |
| Linux ARM64 | PASS | ARM64 |
| macOS x86_64 | PASS | x86_64 |
| macOS ARM64 | PASS | ARM64 |
| Windows x86_64 | PASS | x86_64 |

## Commands

```sh
uv sync --frozen --all-extras
npm ci --ignore-scripts --prefix circle/node
uv run --frozen --all-extras pytest -q
circle -p 'task' --session example
circle -p 'task' --mode json
circle --mode rpc                 # ACP over stdio
# print/JSON exits 3 on pending approval; resume through TUI or ACP
circle --list-models
circle auth login openai
circle plugins install ./my-plugin
uv run --frozen --all-extras python scripts/build_runtime_release.py
uv run --frozen --all-extras python scripts/check_runtime_install.py
```

Plugins expose `circle.extensions` entry points pointing to `register(api)`.
Core framework dependencies are constrained to the host versions. Failed plugin
installation leaves the previous generation active. `/extensions reload` loads
the selected generation when the agent is idle.
