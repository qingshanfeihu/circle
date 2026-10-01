# CLI

Circle has one command, `circle`, and one subcommand, `circle update`. `circle` opens the full-screen interface in a folder you choose.

```bash
circle [workspace]
```

## Arguments and options

| Argument | What it does |
|---|---|
| `workspace` | The folder Circle works in. Defaults to the current folder. `~` is expanded and symlinks are resolved. It does not have to be a git repository. |
| `--version` | Print the version and exit. |
| `--print-home` | Print the data folder (see [Configuration](configuration.md#where-circle-keeps-things)) and exit. Nothing is created. |
| `--init` | Run model setup again, even if Circle is already set up. Read [Setting up again](#setting-up-again) first: it resets your settings. |
| `--line` | Use the plain line-by-line mode instead of the full-screen interface. |
| `-h`, `--help` | Show usage. |

There is no print mode, and there are no flags to pick a model or resume a session. Use [slash commands](slash-commands.md) inside a session for those.

## Updating

```bash
circle update [--check] [--version X.Y.Z]
```

| Option | What it does |
|---|---|
| *(none)* | Install the newest release. |
| `--check` | Say whether a newer release exists. Install nothing. |
| `--version X.Y.Z` | Install that release instead, including an older one, to go back. |

`circle update` works on a copy that `install.sh` or `install.ps1` put in place. It finds the newest release on GitHub, downloads the file for your operating system and processor, checks its sha256 against the `.sha256` file published beside it, unpacks it next to the running version, and only then moves the `current` link. The newest three versions, the previously selected version, and the updating process's version stay on disk, so `circle update --version <old>` goes back without a download when that version is retained. Other versions are removed. Cleanup does not track every open session: close sessions from older versions before repeatedly updating (see [Known issues](known-issues.md#install-and-release)).

A copy that runs from a git checkout, or that was installed with `pip`, is not changed. `circle update` prints what to run instead. To open a folder that is called `update`, write `./update`.

| Code | When |
|---|---|
| `0` | Updated, already up to date, or `--check` finished. |
| `1` | It could not: GitHub was not reachable, no release matches, the checksum failed, or this copy was not installed by the installer. |
| `2` | `--version` is not a version like `0.2.0`. |

If GitHub is reached through a proxy that inspects HTTPS, set `SSL_CERT_FILE` to a PEM file with its certificate. On Windows the Windows certificate store is used.

### The reminder

When the full-screen interface starts, Circle checks once a day whether a newer release exists, and if it does, adds one faint line to the conversation: `Circle 0.2.0 is available (you have 0.1.0) · run circle update`. The check is a `HEAD` request to `github.com/<repo>/releases/latest`, made in the background; it sends nothing beyond what any web request carries (your address and `circle/<version>` as the user agent). The answer is kept in `update-check.json` in the [data folder](configuration.md#where-circle-keeps-things). Line mode never checks.

Turn it off with `"update_check": false` in [settings](settings.md#keys), or `CIRCLE_NO_UPDATE_CHECK=1` in the environment.

## Full-screen and line mode

Circle uses the full-screen interface when both standard input and standard output are terminals, `--line` is not given, and `CIRCLE_NO_TUI` is not `1`, `true`, or `yes`. Otherwise it runs line mode.

Line mode reads one prompt per line, runs it, and prints the last message. It is the only way to script Circle:

```bash
printf 'Summarize README.md in one sentence\n' | circle ~/code/my-project
```

Line mode has limits. It needs a folder that is already trusted and settings that are already initialized, because it cannot show the setup screens without a terminal. It does not load MCP servers, extensions, or custom commands, it does not apply `credential_files`, and it keeps no history between runs. Only `/help` and `/exit` work.

## Exit codes

| Code | When |
|---|---|
| `0` | Normal exit, `--version`, `--print-home`, `--help`. Pressing Esc or Ctrl+C on a setup screen also exits `0`. |
| `1` | You declined to trust the folder, setup was left incomplete in line mode, or Circle crashed. A malformed `settings.json` is one way to crash it. |
| `2` | A usage error. In line mode: settings not initialized, the folder does not exist, or the folder is not trusted, all without a terminal to ask you. |

## Setting up again

`circle --init` runs the same setup as the first start. It writes a new `settings.json` from scratch. Anything you added by hand is reset:

- `trusted_folders`, `mcp_servers`, `extensions`, `credential_files` and `theme`
- any keys Circle does not know

`credentials.json` is merged, so earlier keys stay. To change only the model, use `/models <name>` inside a session instead. See [Settings](settings.md).
