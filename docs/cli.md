# CLI

Circle has one command, `circle`. It opens the full-screen interface in a folder you choose.

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

There are no subcommands, no print mode, and no flags to pick a model or resume a session. Use [slash commands](slash-commands.md) inside a session for those.

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
