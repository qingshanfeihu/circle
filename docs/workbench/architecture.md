# Desktop workbench architecture

The user requested a Circle application, with its complete frontend and four platform objects available through one plugin mechanism. The native desktop package is the primary entry point. React is the renderer inside that application.

## Ownership

| Part | Owns |
|---|---|
| Electron main | Native window lifecycle, local application protocol, native dialogs, granted file handles, clipboard/export and native browser instances |
| Preload | A small, typed, origin-checked capability bridge |
| Shared workbench | Session presentation, drafts, selection, layout, transcript and user interaction |
| Circle runtime adapter | Future connection to Circle's conversations, model/tool events, approval and question responses, cancellation and recovery |
| Knowledge plugin B | Sources, revisions, evidence and artifacts |
| Long-running work plugin C | Goals, waiting items, handoffs and work requests |
| Execution plugin D | Resource and operation observations, control and stop requests |
| Methods plugin E | Versioned capabilities, session loading and candidate review |

The current B/C/D/E service is a separate local preview implementation. The Circle session port and platform service do not share a status field. A Circle pause does not pause C or confirm D stopped. Loading a method does not publish it, and viewing another knowledge revision does not rewrite existing input.

## Desktop boundary

The app loads packaged resources through `circle://workbench`. Node integration is disabled in the renderer, context isolation and process sandboxing are enabled, and IPC is accepted only from the expected application frame. The bridge exposes named operations; it does not expose `ipcRenderer`, arbitrary channels or filesystem functions.

User-selected folder reads use opaque handles. Exports use the native save dialog. The native browser has a separate sandboxed WebContents and a stable per-session identity; it has no workbench preload bridge. Remote permissions, popups, local-file navigation and downloads are restricted in this phase.

Browser observations include image hash, source identity, time and retry details. The [capture API](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-options) supplies actual native images; empty or persistently unavailable frames remain errors. The browser's own inspector is a display container, while another active dialog hides the native view.

These choices follow Electron's [security recommendations](https://www.electronjs.org/docs/latest/tutorial/security) and [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) API. The checks cover the implemented boundary, not a general security certification or third-party plugin sandbox.

## Plugins

The same `WorkbenchPlugin` declaration is used for the Circle file/activity/browser components and B/C/D/E. A declaration includes an ID, version, interface version, dependencies and page/panel/context/composer contributions. Registration rejects conflicts and dependency cycles. React rendering errors are contained at a component boundary.

Current modules are reviewed first-party code, bundled with the application. UI disablement hides contributions; it is not code unloading. A future third-party distribution channel needs its own trust and isolation design. Circle runtime extensions and workbench UI components are separate mechanisms.

## Circle and ZCode reference

The source baseline is Circle 1.0.4, commit `9b532727e4433f2d0fa6a0d222a4509daf7f15e4`. Command and tool coverage is checked against repository source and documentation.

The desktop/workspace organization was studied from [ZCode](https://github.com/zai-org/ZCode) at `aac4755666d09fdcd70272fcf063c077a639015f`: native main/preload/renderer, a conversation-first workspace and file/diff/terminal/browser inspectors. This implementation does not copy ZCode code or its account, subscription, update or backend services.

Circle's current RPC is headless, does not load MCP/extensions and has no interactive approval-response channel. The future GUI runtime connection needs to address those gaps. The frontend does not use `--yolo` to hide them and does not claim model or tool execution from a local request record.
