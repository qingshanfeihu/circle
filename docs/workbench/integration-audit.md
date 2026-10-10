# Native runtime and plugin integration audit

Inspected on 2026-10-11 against Circle 1.0.4 and workbench commit `738ba94ddaf3d53a431b9d5ae06797c9d88127e0`. This page audits the complete application/plugin goal. It does not change the current frontend phase into a completed runtime integration.

## What current evidence proves

The native application, named host capabilities and bundled UI components are implemented. The inspected revision passed the CLI Check workflow, native macOS checks, Windows/Linux desktop packaging and all six existing CLI distribution builds. The distribution publish step was skipped. PR #24 remains a draft and has not merged.

[Native receipts](validation.md) bind the checked frontend sources, bundled resources and packaged ASAR. They prove the stated native/frontend behaviors. They do not prove that a model ran, that an extension tool reached a platform service or that a device operation completed.

## Full goal requirements

| Required behavior | Authoritative proof needed | Current evidence and result |
|---|---|---|
| Circle opens as a standalone application | Actual native window and packaged-app run without a layout server | Proven for macOS; other platforms have packaging evidence |
| The desktop uses the real Circle harness | A request reaches `AgentRuntime`, and its actual events/history/results reach the window | Missing; desktop info explicitly reports `runtimeConnected: false` |
| Existing Circle command/features work through the application | Each runtime action reaches its owner and verifies the resulting state/effect | 38 frontend command entries checked; runtime actions remain incomplete |
| Approvals, questions, secrets and plan exit actually resume execution | Core awaits the matching response; stale/denied responses cannot release a different call | Core has callback hooks; desktop has no live callback transport |
| Native session history, forks, import/export and restart preserve the actual run | Checkpoint store and subsequent model request, not only UI rows | Local preview persistence checked; real Circle store is not connected |
| MCP, skills and runtime extensions load under normal trust and policy | Actual integration loading and tools in the next model request | Core loading exists; desktop requests do not perform it |
| B is an installed knowledge/evidence capability | Version-bound calls reach B; original inputs, evidence and artifacts retain their identities | UI component installed; local preview service only |
| C is an installed durable-work capability | Accepted work survives the A process; changes, handoffs and cancellation use C's authoritative records | UI component installed; no durable service connected |
| D is an installed execution capability | Agent and user observe the same execution; inputs, leases, effects and stopping are verified at D | Local operator browser verified; agent control, SSH and platform execution remain unconnected |
| E is an installed methods capability | Exact versions load into the actual model/tool context; validation and publication use E's policy | UI pins/loading checked; actual capability loading/publication not connected |
| All four use the same plugin installation model | One package identity connects its UI contributions, runtime registration, compatibility and configuration | Shared UI API exists; a joint UI/runtime package contract is missing |
| Permissions and full disclosure hold across objects | Trusted identities at service/execution boundaries; actual requests, returns, artifacts and effects distinguish facts from judgments | Native host boundary checked; demo roles are not production authentication |
| GitHub delivery is reviewable | Current source, checks, artifacts and limits point to the same revision | PR #24 and receipts available; merge and release are separate actions |

The full goal is therefore incomplete. Installing a bundled page is not proof that its runtime capability or authoritative service is available.

The complete runtime/plugin work is tracked separately in [issue #25](https://github.com/qingshanfeihu/circle/issues/25). The earlier frontend-only scope remains in force until the user expands it; this audit and issue do not authorize production access, deployment or real-model spending.

## Existing core interfaces that can be reused

[`RuntimeOptions`](../../src/runtime.ts) already accepts an injected model plus asynchronous `approve`, `question` and `secret` callbacks. [`AgentRuntime`](../../src/runtime.ts) owns its checkpoint store, session, harness, jobs, policy, MCP and extensions. Its public methods include initialization/reload, model/depth changes, plan mode, compaction, cancellation, session creation/switching, native import/export and close.

[`Harness`](../../src/harness.ts) awaits approval before starting the tool. The terminal's [`cardHooks`](../../src/tui/session_app.ts) binds the same callbacks to its interaction queue. A desktop adapter can bind them to native messages and response promises while preserving the core gate. An [`EventBus`](../../src/events.ts) subscription supplies observations; its callbacks are explicitly not enforcement boundaries.

[`AgentRuntime.initialize`](../../src/runtime.ts) returns immediately in headless mode. Otherwise it loads MCP and extensions, rebuilds integration tools and updates the model/system context. The current [RPC](../rpc.md) is headless and cannot answer interactive cards. Using that RPC with `--yolo` would bypass the required interaction rather than complete the integration.

The current Circle dependency manifest contains its own harness/provider implementation, not LangChain or Deep Agents packages. The connection should reuse that inspected core; it does not require replacing the agent framework to obtain the missing desktop transport.

## Proposed connection boundary

This is a proposal pending the runtime phase, not implemented functionality.

1. A supervised Node worker hosts the existing interactive `AgentRuntime` with an application-specific Circle home and explicit workspace/trust configuration. The renderer does not import the runtime, open its database or execute tools. The packaged application must include its runtime/dependencies and must not depend on a developer's global Node or Circle installation. Electron's [utility process](https://www.electronjs.org/docs/latest/api/utility-process) and the existing bundled CLI runtime are candidates; package behavior needs its own verification before selecting the host.
2. A typed command channel carries named requests and explicit acceptance/errors. A sequenced event channel projects actual runtime state into the frontend. Reconnection first obtains authoritative state; a lost reply remains unverified until reconciled.
3. Interaction requests bind their request/session/origin/call identity. Replies resolve only the matching active callback. Disconnect, cancellation, duplicate and stale replies receive explicit handling. Secret values use the dedicated secret path and stay out of ordinary events, history and logs.
4. UI state retains drafts, selection, layout and preferences. The current [`RuntimePort`](../../apps/workbench/src/model/types.ts), with `mode: 'preview'`, synchronous methods and unrestricted snapshot `change`, cannot be treated as a finished live adapter contract. Backend-owned session, model, job and operation fields require commands and authoritative projections.
5. A first-party plugin package pairs its `WorkbenchPlugin` UI entry with a Circle `ExtensionAPI` runtime entry under one package ID/version and compatibility record. The runtime entry registers tools/commands through existing APIs and calls shared service clients. UI enablement grants no service permission. Reload, disable and uninstall preserve history and do not imply that C work or D operations stopped.
6. B/C/D/E retain their own clients, authorization and records. A service endpoint or a displayed username cannot become trusted identity. Version references and operation/work IDs remain separate from Circle session IDs. The native browser's per-process identity is not yet a platform-wide D resource identity.

## Evidence gates for the next phase

Use a scripted model, isolated home/workspace and synthetic service identities first. The initial chain must show a real model request, actual streamed output, actual temporary-file effect after the correct approval, rejection without that effect, question/secret handling, cancellation and restart. Check the store and the next model request as well as the window. Repeat that chain in the packaged application with a PATH that has no external Node or Circle executable.

Then install B/C/D/E through the paired package mechanism. Each chain must prove service acceptance, version/identity binding and resulting authoritative state. Include duplicate/stale replies, role denial, a dropped acknowledgement, worker loss, task persistence, unknown remote stopping and an A disconnect. Browser operation must target the same native/worker session being displayed; SSH needs its own isolated fixture and full byte-level I/O evidence. Local fixture results cannot establish production device compatibility or authorization.

Source hashes for this inspection are recorded in [the audit receipt](integration-audit-receipt.json). No runtime worker, model, platform service or SSH connection was started for this audit.
