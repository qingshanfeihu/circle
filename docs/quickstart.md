# Quickstart

Circle runs in your terminal and works on the files in a folder you choose. To use it you need a model endpoint: a base URL and an API key for a service or gateway that speaks the OpenAI or Anthropic API.

## 1. Install

Circle runs on macOS, Linux and Windows 10 or newer, on x64 and arm64. A release carries its own Node.js, so nothing else needs to be installed first. The Windows build has not yet been tried in a real console; read the [Windows entries in Known issues](known-issues.md#install-and-release) first.

On macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

The installer downloads the release for your system, checks it, puts `circle` on your `PATH`, and adds that folder to your shell's startup file if needed. Open a new terminal afterwards. To pin a version, set `CIRCLE_VERSION`, for example `CIRCLE_VERSION=1.0.0`. If it stops with a certificate error, or you want to install from source, see [Installation and updates](installation.md).

Verify:

```bash
circle --version
```

To upgrade later, run `circle update`.

### Upgrading from 0.5.0

Circle 0.5.0 and older were written in Python, and their `circle update` cannot install this version. Run the install command above instead: it removes the Python version and installs this one in its place. Your data folder stays as it was, so the endpoint, key, trusted folders, MCP servers, skills, custom commands and prompt history carry over, and your saved sessions show up in `/resume` after the first start. Python extensions have to be rewritten. See [Replacing the Python circle](installation.md#replacing-the-python-circle).

## 2. Start Circle

Change to the folder you want Circle to work in, then start it:

```bash
cd /path/to/project
circle
```

The first time, Circle walks you through two steps. Both are asked in the input box at the bottom of the session screen, under the welcome block, so the screen you answer them on is the one you then work in.

**Connect a model.** Paste the API base URL and the key (it shows as dots). Circle asks the endpoint for its models, then asks for the model id, showing a few of the listed ones. If it cannot list the endpoint's models, it asks whether the API is OpenAI-style or Anthropic-style, and you type the model id your provider documents. See [Choose a model](models.md).

**Trust the folder.** Circle asks before it works in a folder for the first time, and says what the folder can supply: instructions, skills, commands and extensions, and that extensions run code. Trusting records the folder in your settings; nothing is written into the folder. Choose **trust this folder** (or press `y`).

After that, `circle` goes straight to the session.

## 3. Give Circle a task

Circle shows each file read, search, command and edit it performs. **Before it runs a command or changes a file, it asks you.** A card replaces the input box and shows what Circle wants to do:

```text
● Bash needs your permission
  $ pytest tests/test_quicksort.py -q

1 Allow once
2 Allow this exact command for this session
3 Allow "pytest …" for this session
4 Reject and explain
```

Press `1` to allow it once, `2` to stop being asked for the same command in this session, `3` to stop being asked for every `pytest` command, or `4` to reject and tell Circle what to do instead. `esc` rejects. See [Security](security.md) for exactly what is checked and what is not.

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

Press `esc` to stop a turn. You can type while Circle is working: `enter` gives the message to the model after its current step, and `ctrl+q` keeps it for when the turn ends. See [Steer a running turn](usage.md#steer-a-running-turn).

## 4. Continue

Everything you type is kept in your prompt history: press `↑` in an empty prompt to bring back earlier messages, or `ctrl+r` to search.

Inside a session, `/new` starts a fresh conversation, `/export` writes the transcript to a Markdown file, and `/exit` (or `ctrl+d` on an empty box) leaves. Circle keeps each conversation in its data folder: `circle -c` goes on with the last one in this folder, and `/resume` lists the others. See [Sessions](sessions.md).

To use Circle from a script, run one prompt with `circle -p "…"`; the answer is printed. See [CLI](cli.md#print-mode).

## Where to go next

- [Use Circle in the terminal](usage.md) for queued messages, the plan box, subagents and shortcuts.
- [The interface](interface.md) to read what the lamps, colours and frame mean.
- [Run Circle safely](security.md) before pointing it at anything you cannot restore.
- [Configuration](configuration.md) for instruction files, skills and custom commands.
