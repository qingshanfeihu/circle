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

`CIRCLE_VERSION` selects a version; otherwise the installer uses the latest release. `CIRCLE_REPO` selects the release repository. `CIRCLE_PREFIX` changes the installation root; `CIRCLE_BIN_DIR` changes the launcher directory. When that directory is not on PATH, Windows adds it to the user PATH and macOS/Linux add one line marked `# circle path` to `~/.zshrc` (`~/.bashrc` when the shell is bash); `CIRCLE_NO_PATH=1` turns both off.

The default roots are `~/.local/share/circle` and `%LOCALAPPDATA%\circle`, with the launcher in `~/.local/bin` and `%LOCALAPPDATA%\circle\bin`. Each validated package lives under `versions/<version>/`. `current.ref` selects the running version; `installation.json` records the layout and repository. Each installation keeps the newest three versions and the one it replaced, so a session started from an older version goes on running.

The installer checks the archive digest, rejects unsafe entries, verifies every package file and runs the bundled CLI before switching `current.ref`. Configuration, credentials and SQLite sessions stay in `CIRCLE_HOME` (default `~/.circle`). Installation and updates preserve these files.

## Replacing the Python circle

Circle 0.5.0 and older were written in Python. The one-command installer removes them before it selects the new version:

- A copy installed by the old installer: its `versions/` folders, its `current` link and the `circle` link in the launcher directory. On Windows it also takes `<prefix>\current\circle` off the user PATH. Unless `CIRCLE_PREFIX` or `CIRCLE_BIN_DIR` say otherwise, the new version goes into the same root and launcher directory.
- A copy installed with pip whose `circle` command is on PATH, including pipx and `pip install -e` checkouts: the installer runs `<that command's python> -m pip uninstall -y circle`. A checkout itself stays.

The installer first downloads and checks the new release, so a failed download leaves the old copy in place. If a Python circle is still running, it stops before changing anything; close those sessions and run it again. If a pip uninstall fails, it stops and names the command that failed.

The data folder is not touched. Settings, credentials, MCP servers, skills and trusted folders carry over; saved sessions are imported on the first start (see [sessions](sessions.md)). Python extensions do not load in this version; see [extensions](extensions.md).

`circle update` in a Python version cannot install 1.0.0 or later: it stops with `release v1.0.0 has no circle-<os>-<arch>.tar.gz` (`.zip` on Windows), because release files now carry the version in their names. Run the one-command installer above instead.

## Updates

For installer-managed installations:

```sh
circle update --check
circle update
circle update 1.0.0
```

Source checkouts use `npm ci` and `npm run build`. To exercise distribution locally, run `npm run release:build` and `npm run release:smoke`. Smoke tests use isolated directories and local model endpoints. `CIRCLE_ASSET_DIR` supplies a local archive directory to the installer for offline testing.
