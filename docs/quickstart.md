# Quickstart

Circle runs in your terminal and works on the files in a folder you choose. To use it you need a model endpoint: a base URL and an API key for a service or gateway that speaks the OpenAI or Anthropic API.

## 1. Install

Version 0.2.0 provides prebuilt packages for **macOS Apple silicon** and **Linux x86_64 with glibc** (built on Ubuntu 22.04). Windows, Intel Mac, Linux ARM64 and Alpine/musl are not supported by this release. No Python installation is needed.

On either supported platform:

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/v0.2.0/install.sh | CIRCLE_VERSION=0.2.0 bash
```

The installer downloads the release for your OS and CPU, puts `circle` in `~/.local/bin`, and adds that folder to your shell's `PATH` if needed. Reopen the terminal or reload the shell configuration after installation. It does not verify checksums; archives and `SHA256SUMS` are available on the [Releases page](https://github.com/qingshanfeihu/circle/releases/tag/v0.2.0) for manual verification.

For source development, see [Contributing](../CONTRIBUTING.md). Native Windows support and an updater are not included in this version.

Verify:

```bash
circle --version
```

## 2. Start Circle

Change to the folder you want Circle to work in, then start it:

```bash
cd /path/to/project
circle
```

The first time, Circle walks you through two steps.

**Connect a model.** Choose **API URL + KEY**, paste the base URL and the key, then pick a model from the list Circle fetches. See [Choose a model](models.md). The OAuth choice is not available yet.

**Trust the folder.** Circle asks before it works in a folder for the first time. Trusting records the folder in your settings and creates a small `.agent/` folder inside it. Choose `y` to continue.

After that, `circle` goes straight to the session.

## 3. Give Circle a task

Circle shows each file read, search, command and edit it performs. **Before it runs a command or changes a file, it asks you.** A card replaces the input box and shows what Circle wants to do:

```text
● Bash needs your permission
  $ pytest tests/test_quicksort.py -q

1 Allow once
2 Allow this exact command for this session
3 Reject and explain
```

Press `1` to allow it once, `2` to stop being asked for the same thing in this session, or `3` to reject and tell Circle what to do instead. `esc` rejects. See [Security](security.md) for exactly what is checked and what is not.

Try a task that matches your work:

```text
Explain how this repository is structured and how to run its checks.
```

```text
Add type hints to quicksort.py and write pytest tests for it.
```

```text
Find where the config file is read and tell me which settings can be overridden.
```

Press `esc` to stop a turn. You can type the next message while Circle is working. It is queued and sent when the turn ends.

## 4. Continue

Everything you type is kept in your prompt history: press `↑` in an empty prompt to bring back earlier messages, or `ctrl+r` to search.

Inside a session, `/new` starts a fresh conversation, `/export` writes the transcript to a Markdown file, and `/exit` (or `ctrl+d`) leaves. Circle keeps each conversation's history in its data folder, but the current build can only reopen a conversation from earlier in the same run. See [Sessions](sessions.md).

## Where to go next

- [Use Circle in the terminal](usage.md) for queued messages, the plan box, subagents and shortcuts.
- [The interface](interface.md) to read what the lamps, colours and frame mean.
- [Run Circle safely](security.md) before pointing it at anything you cannot restore.
- [Configuration](configuration.md) for instruction files, skills and custom commands.
