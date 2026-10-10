# Circle workbench renderer

The shared React/TypeScript interface for the Circle desktop application. Start the app through [the desktop package](../desktop/README.md).

The renderer covers conversations, tool inputs and outputs, thinking, session trees, branches, on-screen undo/redo, plans, approvals, jobs and subagents, model selection, skills, custom commands, MCP, runtime extensions and settings. It reads Circle's current slash-command definitions and palette directly, so changes can be checked against the core source.

B/C/D/E are installed as first-party component plugins: knowledge, long-running work, execution resources and methods. They share the plugin registration and lifecycle API, while keeping their records in a separate service. Enabling a UI plugin grants no business permission; disabling it deletes no data and stops no execution.

## Composition

`CircleWorkbench` receives a session `RuntimePort`, bundled `WorkbenchPlugin` modules and a `ServiceRegistry`. Plugins register pages, inspector panels, context widgets and composer actions. A native host is supplied through the isolated preload bridge.

`PreviewRuntime` and `PlatformPreviewService` are development implementations, not the Circle model runtime or production B/C/D/E services. Their native application state lives in the application's own data directory.

## Development

```sh
npm ci
npm run build
npm test
```

`npm run dev` is an optional browser layout tool. It does not replace the desktop entry point or native tests.

The UI uses Circle's palette and short English controls. User and model content is rendered as provided. UI components derive shared color and type tokens; raw HTML in Markdown is not executed.
