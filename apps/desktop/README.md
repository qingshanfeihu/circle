# Circle desktop workbench

Circle's graphical workbench runs as a native Electron application. It opens its own window, loads bundled local UI resources and provides native menus, folder/file selection, clipboard, export and a sandboxed browser pane. A local web server is not needed to run the application.

This is the frontend phase. Circle's model runtime and production platform services are not connected. Sessions and operation requests use explicitly isolated preview data; native user-selected file reads, clipboard writes, exports and browser navigation are real host operations.

## Run from source

From the repository root, using Node.js 24:

```sh
npm --prefix apps/workbench ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop run dev
```

The default desktop data folder is `Circle Workbench` under the operating system's application-data directory. It is separate from `~/.circle`. Development or tests can select a dedicated folder with `CIRCLE_WORKBENCH_DATA_DIR`.

## Build an application

```sh
npm --prefix apps/desktop run package
```

The current host platform is packaged under `apps/desktop/out/`. On macOS this produces `Circle Workbench.app` and a `.dmg` containing the application and an Applications-folder link. These are development artifacts; this command does not publish a release or install into Applications.

The desktop package includes the renderer, icon, license and third-party notices. Electron and frontend dependencies are pinned in their lockfiles.

## Components

- `src/main.ts` owns windows, native menus, the local `circle://workbench` protocol and validated IPC handlers.
- `src/preload.ts` exposes named capabilities rather than an unrestricted IPC or Node API.
- `src/files.ts` reads user-selected files and indexes selected folders. Workspace reads require opaque granted handles and reject unknown handles or symlink escapes.
- `src/browser.ts` keeps one sandboxed native browser per Circle session. The browser identity is stable across inspector switches; capture records its identity, time and content hash.
- `../workbench` provides Circle's session interface and the same plugin API used by the four platform components.

Window close is separate from a platform work or execution stop. Preview requests do not fabricate remote acknowledgements. Native browser control is currently by the local operator; the future Circle adapter must use the same session identity.

## Check

```sh
npm --prefix apps/workbench test
npm --prefix apps/desktop test
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:desktop
npm --prefix apps/desktop run test:interface
```

The desktop tests launch the actual application with isolated data, synthetic selected files and a local browser fixture. They exercise IPC, persistence, native file effects, every current Circle slash command and the platform components. `CIRCLE_WORKBENCH_TEST_PROFILE` is an explicit development fixture for dialog choices; ordinary runs use the operating system's dialogs.

[Coverage and scope](../../docs/workbench/coverage.md) distinguishes implemented frontend behavior from runtime integration. [Architecture](../../docs/workbench/architecture.md) explains the ownership boundaries and the references used.

[Native validation](../../docs/workbench/validation.md) records the checked source, individual behaviors and development/package receipts.
