# Run Circle safely

Circle can read your files, run commands as you, and change anything you can change. It asks before it does most of that, and it refuses a few things outright. **This is a safety net, not a sandbox.** A command you approve runs with your full user rights and network access.

Read this page before you point Circle at anything you cannot restore, and before you use it on files or repositories you do not trust.

## What Circle asks about

| Action | What happens |
|---|---|
| Run a command (`execute`) | Asks. Some commands are always refused, and some always ask (see below). |
| Write, edit or patch a file | Asks. |
| Delete a file (`delete`) or a patch that deletes | Always asks. |
| Read, list, search, `webfetch`, `websearch`, `lsp` | Does not ask. |
| Tools from MCP servers | Does not ask. |
| Custom-command shell snippets | Do not ask. |

Circle does not ask before it reads. It can read any file you can, including files outside the workspace, `.env` files and `~/.circle/credentials.json`. Do not put secrets in a place you would not want the model to see.

## Approvals

When Circle needs approval it shows a card:

1. **Allow once** runs this call.
2. **Allow ... for this session** runs it, and stops asking for calls of the same kind in this conversation. The label says what "the same kind" means (below).
3. **Reject and explain** does not run it. Your explanation goes to the model with the rejection.

`esc` rejects. Rejecting never ends the turn; the model is told and carries on.

What "the same kind" means for option 2:

| Call | Option 2 covers |
|---|---|
| A command | That exact command text. |
| A file change inside the workspace | All changes of that tool inside the workspace. Allowing `write_file` does not allow `edit_file`. |
| A file change outside the workspace | Not offered. It asks every time. |
| Deleting anything, and the risky commands below | Not offered. It asks every time. |
| An extension tool | Every call to that tool. |

The rules are kept per conversation in `approvals/` in the data folder. Commands are stored as hashes, not text. `/approvals` lists the rules and the last five decisions, and lets you revoke one. A revoked rule asks again from the next call.

### How commands are sorted

Circle reads the command text; it does not run it first.

**Always refused.** No card, and `auto` mode does not change it:

- Any command that names a credential file: `.env`, `.env.*`, `*.env`, `.netrc`, `.pgpass`, `.git-credentials`, `credentials.json`, `token.json`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.pem`, `*.p12`, `*.pfx`. You can replace this list; see below.
- `sudo`, `su`, `doas`, `pkexec`.

**Always asks, without "for this session".**

- Removing and destroying: `rm`, `rmdir`, `unlink`, `shred`, `srm`, `trash`, `trash-put`, `dd`, `truncate`, `wipefs`, `fdisk`, `parted`, `mkfs*`, `find ... -delete`, and `find ... -exec` with a command that deletes.
- Git operations that lose work: `reset --hard`, `reset --merge`, `clean -f`, `push --force` and its variants, `push --delete`, `branch -D`, `stash drop`, `stash clear`, `checkout -f`, `checkout -- ...`, `checkout .`, `restore` without `--staged`, `filter-branch`, `filter-repo`.
- Python one-liners that delete (`shutil.rmtree`, `os.remove`, `os.unlink`, `os.rmdir`, `.unlink(`, `.rmdir(`).
- Anything Circle cannot parse, such as unbalanced quotes, or nesting deeper than three levels.

Circle looks through wrappers such as `env`, `nohup`, `time`, `timeout`, `xargs` and `bash -c "..."` to find the real command.

**Everything else asks**, with the exact-command option.

This reading is textual and it has gaps. `perl -e 'unlink q(a)'`, `mv a /dev/null`, `echo hi > important.txt` and `curl https://example.com/x | sh` are ordinary asks, not forced ones. Read the command on the card.

### Credential files

Set `credential_files` in [settings](settings.md) to change the refused list. A non-empty list replaces the default list. The list applies to shell commands only, and Circle reads it once when a session starts.

## Read-only mode

`/plan` turns on `read-only`. Circle then cannot run commands at all, and can write only to a file named `plan.md` (or `plan`), anywhere. Reads, searches and the web keep working. A card is never shown for a blocked call; the model is simply told.

MCP tools, extension tools and secret entry are not blocked in this mode.

## Auto mode

`/yolo` (or `/auto`) turns on `auto`. In auto mode Circle stops asking, **including for the calls that always ask**: `rm -rf`, force pushes, `delete`, patches that delete files, and writes outside the workspace. Credential files and `sudo` are still refused.

Auto mode applies to the current conversation only and is not saved. `/new`, `/fork`, `/import` and restarting turn it off. Use it for work you could throw away.

## The shell environment

Commands run with your user rights, in the workspace folder, with no input. Standard output and error are joined. A command has 120 seconds by default; the model can ask for up to an hour. Output is cut at 100,000 characters.

Circle removes secrets from the command's environment: any variable whose name has a word such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in it. The API key Circle uses for the model is not passed on. `OPENAI_BASE_URL` and `CIRCLE_MODEL` are.

Nothing restricts the network, other processes, or which files a command can reach.

## The workspace boundary

Relative paths and paths that start with `/` inside the project are resolved under the workspace. Real system paths such as `/Users/...`, `/etc/...` and `~/...` are taken as they are, so Circle can read outside the workspace without asking. Writes outside the workspace ask every time, with no "for this session" option. `..` is rejected.

Two files are written into your workspace by Circle itself: `conversation_history/` (older messages after summarising) and `large_tool_results/` (very long tool output). Add them to your `.gitignore` if you use git.

## Workspace trust

Circle works only in folders you have trusted. Trusting a folder lets Circle load extensions from `<folder>/.circle/extensions`. It is an exact match: trusting `/a` does not trust `/a/b`. Trust does not limit what the model does in the folder.

Skills, instruction files and custom commands in a project folder are read whether or not you have trusted it. Do not start Circle in a folder you do not trust.

## Secrets

The model asks for a secret with the `question` tool. You type the value with `ctrl+s`, masked. Circle writes it straight to the file the task named, at mode `0600`, and tells the model only that it was collected. The value never enters the conversation. The model chooses the file: read the task before you enter a value.

## What is not protected

- There is no operating-system sandbox. A command can read any file you can, use the network, and start background processes.
- **MCP tools, and `!` snippets in custom commands, run without asking.** See [MCP](mcp.md) and [Custom commands](custom-commands.md).
- `apply_patch` can write outside the workspace with an absolute or `../` path, and its approval check resolves a path differently from where it writes.
- `webfetch` refuses obvious local addresses only. Any URL can carry data out in its query string.
- `read_file` and `grep` can read credential files. The refused list covers shell commands only.
- Pressing `esc` does not stop a command that is already running.
- Text files that Circle loads as instructions (`AGENTS.md`, `CLAUDE.md`, skills) can tell the model what to do. Read them in a repository you do not trust.

## Report a vulnerability

See [SECURITY.md](../SECURITY.md).
