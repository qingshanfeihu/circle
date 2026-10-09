# Installation and updates

A release of Circle carries everything it needs, including its own Node.js: nothing else has to be installed first. Releases are built for macOS, Linux and Windows, each on x64 and arm64, as `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) with a `.sha256` file beside each.

The commands below install the newest release on the [Releases page](https://github.com/qingshanfeihu/circle/releases). They need a release of 1.0.0 or later; until one is published there, they stop with an error and change nothing.

## Install

On macOS and Linux (needs `bash`, `curl`, `tar`, and `sha256sum` or `shasum`):

```sh
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

On Windows, in PowerShell 5.1 or newer:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

If `install.sh` runs in a Windows shell (Git Bash, MSYS2, Cygwin), it hands over to PowerShell and installs the Windows program.

The installer downloads the release for your system, checks its sha256, refuses an archive with links, special files or paths that leave it, checks every file against the release's own list, and runs the new program once. Only then does it switch to the new version, so a failed step leaves the installed one as it was. It says each step on a line of its own, starting with `[circle-install]`. On a terminal, `install.sh` also shows curl's bar of how far the download has got; `install.ps1` only says that it is downloading.

| Variable | Effect |
|---|---|
| `CIRCLE_VERSION` | Install this version instead of the newest, for example `CIRCLE_VERSION=1.0.0`. |
| `CIRCLE_REPO` | The GitHub repository to take releases from. Default `qingshanfeihu/circle`. |
| `CIRCLE_PREFIX` | Where versions are kept. Default `~/.local/share/circle`, or `%LOCALAPPDATA%\circle` on Windows. |
| `CIRCLE_BIN_DIR` | Where the `circle` launcher goes. Default `~/.local/bin`, or `%LOCALAPPDATA%\circle\bin` on Windows. |
| `CIRCLE_NO_PATH` | `1` leaves your `PATH` alone. |

When the launcher's folder is not on your `PATH`, the installer adds it: on Windows to your user `PATH`, on macOS and Linux as one line marked `# circle path` in `~/.zshrc` (`~/.bashrc` when your shell is bash). Open a new terminal afterwards, or run the `source` command it prints.

If the installer stops with a certificate error, your network is replacing HTTPS certificates. Export its root certificate as a PEM file and run the installer again with `CURL_CA_BUNDLE=/path/to/ca.pem` (macOS, Linux), or import it into the Windows certificate store, which PowerShell uses. `HTTPS_PROXY` sets a proxy for the download.

## Where it goes

Each version lives in its own folder, `versions/<version>/`, under the prefix. `current.ref` names the version the launcher runs, and `installation.json` records the folders and the repository for `circle update`. An installation keeps the newest three versions and the one it replaced, so a session started from an older one goes on running; other versions are removed.

Your settings, keys, sessions, skills and the rest stay in the data folder, `~/.circle` (or `CIRCLE_HOME`), which installing and updating never touch. See [Configuration](configuration.md#where-circle-keeps-things).

## Updates

```sh
circle update --check      # is there a newer release?
circle update              # install it
circle update 1.0.0        # install this one, also an older one
```

`circle update` downloads the release it found itself, on one line that shows how far it has got (percent, megabytes and speed), then runs the installer on that file with the same folders, and the installer says each step. `ctrl+c` during the download stops it and changes nothing. See [Updating](cli.md#updating) for its options and exit codes, and [The reminder](cli.md#the-reminder) for the daily check.

## Replacing the Python circle

Circle 0.5.0 and older were written in Python. Running the one-command installer above is how you upgrade: it removes the Python version before it switches to the new one.

- A copy installed by the old installer: its `versions/` folders, its `current` link and the `circle` link in the launcher folder. On Windows it also takes `<prefix>\current\circle` off your user `PATH`. Unless `CIRCLE_PREFIX` or `CIRCLE_BIN_DIR` say otherwise, the new version goes into the same folders.
- A copy installed with pip whose `circle` command is on your `PATH`, including pipx and `pip install -e` checkouts: the installer runs `<that command's python> -m pip uninstall -y circle`. A checkout itself stays.

The installer first downloads and checks the new release, so a failed download leaves the old copy in place. If a Python circle is still running, it stops before changing anything; close those sessions and run it again. If a pip uninstall fails, it stops and names the command that failed.

The data folder is shared and not touched. Settings, keys, MCP servers, skills, custom commands, prompt history and trusted folders carry over; saved sessions are imported on the first start (see [Sessions from 0.5.0](sessions.md#sessions-from-050)). Python extensions do not load in this version and have to be rewritten; see [Coming from 0.5.0](extensions.md#coming-from-050).

`circle update` in a Python version cannot install 1.0.0 or later: it stops with `release v1.0.0 has no circle-<os>-<arch>.tar.gz` (`.zip` on Windows), because release files now carry the version in their names. Run the one-command installer instead.

## From source

A checkout runs on Node.js 24 or newer:

```sh
git clone https://github.com/qingshanfeihu/circle
cd circle
npm ci
npm run build
node dist/cli.js --version
```

`npm run dev -- <folder>` runs the checkout without building. `circle update` does not work on a checkout: update it with `git pull`, `npm ci` and `npm run build`. To try the release packages locally, run `npm run release:build` and `npm run release:smoke`; the smoke test uses folders and a model endpoint of its own. `CIRCLE_ASSET_DIR` points the installer at a folder of local archives instead of GitHub.
