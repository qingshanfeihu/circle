# Installation and updates

Release packages contain the CLI, prompts, model data, locked runtime dependencies and Node.js. Target machines need no separate Node/npm/TypeScript setup. Packages are named `circle-<version>-<platform>-<architecture>.tar.gz` (macOS/Linux) or `.zip` (Windows), with SHA-256 sidecars.

The distribution workflow builds and tests Linux, macOS and Windows on x64 and ARM64. Support is established by successful package and installer smoke results on each target. The first public release is still awaiting full feature acceptance; the commands below require published assets.

macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

`CIRCLE_VERSION` selects a version; otherwise the installer uses the latest release. `CIRCLE_REPO` selects the release repository. `CIRCLE_PREFIX` changes the installation root; `CIRCLE_BIN_DIR` changes the launcher directory. Windows adds that directory to the user PATH unless `CIRCLE_NO_PATH=1`. macOS/Linux print the directory to add to PATH.

The default roots are `~/.local/share/circle` and `%LOCALAPPDATA%\circle`. Each validated package lives under `versions/<version>/`. `current.ref` selects the running version; `installation.json` records the layout and repository. Existing version directories remain available.

The installer checks the archive digest, rejects unsafe entries, verifies every package file and runs the bundled CLI before switching `current.ref`. Configuration, credentials and SQLite sessions stay in `CIRCLE_HOME` (default `~/.circle`). Installation and updates preserve these files.

For installer-managed installations:

```sh
circle update --check
circle update
circle update 1.0.0
```

Source checkouts use `npm ci` and `npm run build`. To exercise distribution locally, run `npm run release:build` and `npm run release:smoke`. Smoke tests use isolated directories and local model endpoints. `CIRCLE_ASSET_DIR` supplies a local archive directory to the installer for offline testing.
