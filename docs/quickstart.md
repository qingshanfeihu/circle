# Quickstart

Circle runs in your terminal and works on the files in a folder you choose. To use it you need a model endpoint: a base URL and an API key for a service or gateway that speaks the OpenAI or Anthropic API.

## 1. Install

Circle runs on macOS, Linux and Windows 10 or newer. Windows console interaction still needs real-machine testing; read the [Windows entry in Known issues](known-issues.md#install-and-release) first.

**Prebuilt program** is faster and needs no Python, but check the [Releases page](https://github.com/qingshanfeihu/circle/releases) first: a release only helps if it has a file for your platform. Releases built by the release workflow carry macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64).

On macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/qingshanfeihu/circle/main/install.ps1 | iex
```

The installer downloads the release for your OS and CPU, checks its sha256, unpacks it under `~/.local/share/circle/versions/<version>` (`%LOCALAPPDATA%\circle` on Windows), points `current` at it, puts `circle` on your `PATH`, and adds that folder to your shell's startup file if needed. On macOS and Linux it starts the new program once before that, which takes a few seconds the first time; if it does not start, your previous install is left as it was. To pin a version, set `CIRCLE_VERSION`, for example `CIRCLE_VERSION=0.2.0`.

If `install.sh` runs in a Windows shell (Git Bash, MobaXterm, Cygwin), it hands over to PowerShell and installs the Windows program. Run `circle` in Windows Terminal, PowerShell or cmd: a terminal window that is not a Windows console cannot show the full-screen interface, use `circle --line` for [line mode](cli.md#full-screen-and-line-mode) there.

If the installer stops with a certificate error, your network is replacing HTTPS certificates. Export its root certificate as a PEM file and run the installer again with `CURL_CA_BUNDLE=/path/to/ca.pem` (macOS, Linux) or import it into the Windows certificate store (PowerShell uses that store).

To upgrade later, run `circle update`. See [Updating](cli.md#updating).

**From source** works everywhere and is the way to get the current code. It needs Python 3.11 or newer. Check first:

```bash
python3 --version
```

macOS comes with Python 3.9 as `python3`, which is too old. With it the install fails with messages that do not mention the version, such as `No matching distribution found for deepagents==…`. Install a newer Python first (for example `brew install python@3.12`) and use `python3.12` in place of `python3` below.

```bash
git clone https://github.com/qingshanfeihu/circle
cd circle
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
pip install -e .
```

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

The first time, Circle walks you through two steps. Both are asked in the input box at the bottom of the session screen, under the welcome block, so the screen you answer them on is the one you then work in.

**Connect a model.** Choose **API URL + KEY**, paste the base URL and the key (it shows as dots), then pick a model from the list Circle fetches, or type its id. If Circle cannot list the endpoint's models, it says why, asks whether the API is OpenAI-style or Anthropic-style, and you type the model id your provider documents. See [Choose a model](models.md). The OAuth choice is not available yet.

**Trust the folder.** Circle asks before it works in a folder for the first time, and says what trusting loads from it: its instruction files, skills, commands, extensions and settings. Extensions run their own code, so the card says so when the folder has any. Trusting records the folder in your settings; nothing is written into the folder. Choose **Trust and continue** (or press `y`).

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

Press `esc` to stop a turn. You can type the next message while Circle is working. It is queued and sent when the turn ends.

## 4. Continue

Everything you type is kept in your prompt history: press `↑` in an empty prompt to bring back earlier messages, or `ctrl+r` to search.

Inside a session, `/new` starts a fresh conversation, `/export` writes the transcript to a Markdown file, and `/exit` (or `ctrl+d`) leaves. Circle keeps each conversation in its data folder: `circle -c` goes on with the last one in this folder, and `/resume` lists the others. See [Sessions](sessions.md).

To use Circle from a script, run one prompt with `circle -p "…"`; the answer is printed. See [CLI](cli.md#print-mode).

## Where to go next

- [Use Circle in the terminal](usage.md) for queued messages, the plan box, subagents and shortcuts.
- [The interface](interface.md) to read what the lamps, colours and frame mean.
- [Run Circle safely](security.md) before pointing it at anything you cannot restore.
- [Configuration](configuration.md) for instruction files, skills and custom commands.
