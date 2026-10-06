"""Approval policy for tools that change things (C3).

Three verdicts for a tool call:

- ``DENY``: never runs. For ``execute``: privilege escalation (sudo/su/doas/pkexec) and
  any command that names a credential file (``.env``, keys, ``credentials.json`` …;
  the list is configurable with ``credential_files`` in settings.json). The refusal is
  enforced by the sandbox backend, so it holds in the main agent and in subagents alike.
- ``ASK_FORCED``: always asks and offers no "always" button: deleting (``rm``,
  ``find -delete``, the ``delete`` tool, a patch that deletes a file), destructive git
  (``reset --hard``, ``clean -f``, force push, ``branch -D``, discarding changes), disk
  tools (``dd``, ``mkfs``, ``shred``, ``truncate``), and commands that cannot be parsed.
- ``ASK``: asks unless an "always" rule of this thread covers it. A command that only
  reads (``ls``, ``cat``, ``rg``, ``git status``, ``git diff`` … in any pipeline of them, with
  no redirection, substitution or option that writes or runs something) offers "always"
  for read-only commands as a group instead of for the exact text.

"Always" rules are kept per thread under ``$CIRCLE_HOME/approvals/`` so they survive a
restart and a resumed session: for ``execute`` the rule is either the exact command text
(a hash of it is stored, not the text) or the words a command starts with
(``python3 -m pytest``), offered for a command that is one program with its arguments; a
``cd`` into the workspace in front of a command is left out of both. For file edits a rule
covers files inside the workspace (edits to paths outside it keep asking); for other
tools, every call to that tool. ``/approvals`` lists and revokes them.

Command classification is a static reading of the text: it catches the usual shapes,
not a determined attempt to hide a command.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shlex
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

Verdict = Literal["DENY", "ASK", "ASK_FORCED"]

DEFAULT_CREDENTIAL_FILES: tuple[str, ...] = (
    ".env", ".env.*", "*.env", ".netrc", ".pgpass", ".git-credentials", "credentials.json",
    "token.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*.pem", "*.p12", "*.pfx",
)
FILE_EDIT_TOOLS = frozenset({"write_file", "edit_file", "apply_patch"})
REJECTED_BY_USER = "The user rejected this tool call."

_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "|&", "(", ")", "{", "}"})
_PRIV_ESC = frozenset({"sudo", "su", "doas", "pkexec", "runas", "gsudo"})
_DELETE_CMDS = frozenset({"rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put",
                          "del", "erase", "rd", "remove-item", "ri"})
_DISK_CMDS = frozenset({"dd", "truncate", "wipefs", "fdisk", "parted",
                        "format", "diskpart", "cipher", "sdelete", "clear-disk", "format-volume"})
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})
# powershell flags that are followed by a value, so the value is not mistaken for the command
_PS_VALUE_FLAGS = ("executionpolicy", "windowstyle", "workingdirectory", "version", "inputformat",
                   "outputformat", "configurationname", "psconsolefile", "custompipename")
_EXE_SUFFIXES = (".exe", ".com", ".cmd", ".bat")
_WINDOWS = os.name == "nt"
_PYTHONS = frozenset({"python", "python3"})
_WRAPPERS = frozenset({"nohup", "time", "command", "builtin", "exec", "stdbuf", "caffeinate"})
_WRAPPERS_WITH_VALUE = {"nice": {"-n"}, "timeout": set(), "ionice": {"-c", "-n"}}
_XARGS_VALUE_FLAGS = frozenset({"-n", "-I", "-L", "-P", "-d", "-s", "-a", "-E"})
_GIT_OPTS_WITH_VALUE = frozenset({"-C", "-c", "--config-env", "--git-dir", "--namespace",
                                  "--super-prefix", "--work-tree"})
_PY_DELETE = re.compile(r"\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs))\s*\(|"
                        r"\.(?:unlink|rmdir)\s*\(")
_ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


@dataclass(frozen=True)
class Review:
    verdict: Verdict
    reason: str = ""
    message: str = ""        # DENY: what the model is told
    pattern: str = ""        # the "always" key; empty = no always for this call
    scope: str = ""          # what an "always" answer would cover, for the panel
    warn_delete: bool = False
    # execute: the words a "commands starting with" rule would keep (empty = not offered),
    # and the keys of the rules that would cover this command
    prefix: tuple[str, ...] = ()
    covered_by: tuple[str, ...] = ()

    @property
    def allow_always(self) -> bool:
        return self.verdict == "ASK" and bool(self.pattern)

    @property
    def prefix_pattern(self) -> str:
        return _prefix_key(self.prefix) if self.verdict == "ASK" and self.prefix else ""

    @property
    def prefix_scope(self) -> str:
        return f'"{" ".join(self.prefix)} …"' if self.prefix_pattern else ""


# ── command classification ─────────────────────────────────────────────────


def _command_name(token: str) -> str:
    """The program a token names: no folder, and on Windows no .exe and no capitals."""
    name = os.path.basename(token)
    if _WINDOWS:
        name = name.lower()
        for suffix in _EXE_SUFFIXES:
            if name.endswith(suffix):
                return name[:-len(suffix)]
    return name


def _credential_match(token: str, patterns: Iterable[str]) -> str:
    for candidate in (token, token.split("=", 1)[-1] if "=" in token else ""):
        base = os.path.basename(candidate.strip().strip("'\"").rstrip("/"))
        if _WINDOWS:
            if base and any(fnmatch.fnmatchcase(base.lower(), p.lower()) for p in patterns):
                return base
        elif base and any(fnmatch.fnmatchcase(base, p) for p in patterns):
            return base
    return ""


def _newlines_to_separators(command: str) -> str:
    """Unquoted newlines and backticks end a command, like ``;`` does."""
    out: list[str] = []
    quote = ""
    escaped = False
    for ch in command:
        if escaped:
            out.append(ch)
            escaped = False
            continue
        if ch == "\\" and quote != "'":
            out.append(ch)
            escaped = True
            continue
        if quote:
            if ch == quote:
                quote = ""
            out.append(ch)
            continue
        if ch in "'\"":
            quote = ch
            out.append(ch)
        elif ch in "\n`":
            out.append(" ; ")
        else:
            out.append(ch)
    return "".join(out)


def _tokens(command: str) -> list[str] | None:
    if _WINDOWS:
        command = command.replace("\\", "/")  # C:\proj\.env is one path, not escapes
    lexer = shlex.shlex(_newlines_to_separators(command), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return None


def _segments(tokens: list[str]) -> list[list[str]]:
    out: list[list[str]] = [[]]
    for token in tokens:
        if token in _SEPARATORS or (token and set(token) <= set(";&|(){}")):
            out.append([])
        elif token.startswith("$(") or token == "$":
            out.append([])
            if len(token) > 2:
                out[-1].append(token[2:])
        else:
            out[-1].append(token)
    return [seg for seg in out if seg]


def _unwrap(seg: list[str]) -> list[str]:
    """Drop ``VAR=x``, ``env``, ``nohup``, ``timeout 5``, ``xargs -n1`` … in front."""
    i = 0
    while i < len(seg):
        token = seg[i]
        head = _command_name(token)
        if _ASSIGNMENT.match(token):
            i += 1
        elif head == "env":
            i += 1
            while i < len(seg) and (seg[i].startswith("-") or _ASSIGNMENT.match(seg[i])):
                i += 1
        elif head in _WRAPPERS:
            i += 1
        elif head in _WRAPPERS_WITH_VALUE:
            i += 1
            value_flags = _WRAPPERS_WITH_VALUE[head]
            while i < len(seg) and seg[i].startswith("-"):
                i += 2 if seg[i] in value_flags else 1
            if head == "timeout" and i < len(seg):
                i += 1  # the duration
        elif head == "xargs":
            i += 1
            while i < len(seg) and seg[i].startswith("-"):
                i += 2 if seg[i] in _XARGS_VALUE_FLAGS else 1
        else:
            break
    return seg[i:]


def _flag(args: list[str], short: str = "", long: str = "") -> bool:
    for token in args:
        if token == "--":
            return False
        if long and (token == long or token.startswith(long + "=")):
            return True
        if short and token.startswith("-") and not token.startswith("--") and short in token[1:]:
            return True
    return False


def _git_destructive(args: list[str]) -> bool:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in _GIT_OPTS_WITH_VALUE else 1
    if i >= len(args):
        return False
    sub, rest = args[i], args[i + 1:]
    if sub == "reset":
        return _flag(rest, long="--hard") or _flag(rest, long="--merge")
    if sub == "clean":
        return _flag(rest, "f", "--force")
    if sub == "push":
        return (_flag(rest, "f", "--force") or _flag(rest, long="--force-with-lease")
                or _flag(rest, long="--mirror") or _flag(rest, "d", "--delete")
                or any(t.startswith(("+", ":")) and len(t) > 1 for t in rest))
    if sub == "branch":
        return _flag(rest, "D") or (_flag(rest, "d", "--delete") and _flag(rest, "f", "--force"))
    if sub == "stash":
        return bool(rest) and rest[0] in {"drop", "clear"}
    if sub == "checkout":
        return _flag(rest, "f", "--force") or "--" in rest or rest[:1] == ["."]
    if sub == "restore":
        return not _flag(rest, "S", "--staged") or _flag(rest, "W", "--worktree")
    return sub in {"rm", "filter-branch", "filter-repo"}


def _python_review(code: str, patterns: tuple[str, ...]) -> Review | None:
    for literal in re.findall(r"""['"]([^'"\n]+)['"]""", code):
        name = _credential_match(literal, patterns)
        if name:
            return _deny_credential(name)
    if _PY_DELETE.search(code):
        return Review("ASK_FORCED", "python code deletes files", warn_delete=True)
    return None


def _deny_credential(name: str) -> Review:
    return Review("DENY", f"credential file {name}",
                  f"Denied by approval policy: '{name}' is a credential file; commands may "
                  "not read, copy or change it. Ask the user if the task really needs it.")


_RANK = {"ASK": 0, "ASK_FORCED": 1, "DENY": 2}


def _worst(reviews: Iterable[Review | None]) -> Review | None:
    best: Review | None = None
    for review in reviews:
        if review is not None and (best is None or _RANK[review.verdict] > _RANK[best.verdict]):
            best = review
    return best


def _powershell_review(args: list[str], patterns: tuple[str, ...], depth: int) -> Review | None:
    """Read the program text of a powershell / pwsh command line. Flags may be shortened to any
    unique prefix (``-Comm``, ``-ec``), and the program may follow with no flag at all."""
    i = 0
    while i < len(args) and args[i].startswith("-"):
        name = args[i].lstrip("-").lower()
        if name and (name == "ec" or "encodedcommand".startswith(name)):  # -ec is a documented alias
            return Review("ASK_FORCED", "command could not be parsed")
        if name and "command".startswith(name):
            return classify_command(" ".join(args[i + 1:]), patterns, _depth=depth + 1)
        if name and "file".startswith(name):
            return None  # a script file: nothing here to read
        i += 2 if any(flag.startswith(name) for flag in _PS_VALUE_FLAGS) and name else 1
    if i < len(args):
        return classify_command(" ".join(args[i:]), patterns, _depth=depth + 1)
    return None


def _segment_review(seg: list[str], patterns: tuple[str, ...], depth: int) -> Review | None:
    for token in seg:
        name = _credential_match(token, patterns)
        if name:
            return _deny_credential(name)
    seg = _unwrap(seg)
    if not seg:
        return None
    head, args = _command_name(seg[0]), seg[1:]
    if head in _PRIV_ESC:
        return Review("DENY", "privilege escalation",
                      f"Denied by approval policy: '{head}' (running as another user) is not "
                      "allowed. Ask the user to run it themselves if it is needed.")
    # sh -c / bash -lc "…" / python3 -c "…"：把引号里的程序文本拿出来再判
    flag_at = next((i for i, t in enumerate(args)
                    if t.startswith("-") and not t.startswith("--") and "c" in t[1:]), -1)
    if flag_at >= 0 and flag_at + 1 < len(args):
        if head in _SHELLS:
            return classify_command(args[flag_at + 1], patterns, _depth=depth + 1)
        if head in _PYTHONS:
            return _python_review(args[flag_at + 1], patterns)
    if head == "cmd":
        for i, token in enumerate(args):
            if token.lower()[:2] in ("/c", "/k", "/r"):
                # cmd /c takes the rest of the line, even glued to the flag: cmd /c"del x"
                program = ([token[2:]] if token[2:] else []) + args[i + 1:]
                return classify_command(" ".join(program), patterns, _depth=depth + 1)
    elif head in ("powershell", "pwsh"):
        found = _powershell_review(args, patterns, depth)
        if found is not None:
            return found
    if head in _DELETE_CMDS:
        return Review("ASK_FORCED", "deletes files", warn_delete=True)
    if head in _DISK_CMDS or head.startswith("mkfs"):
        return Review("ASK_FORCED", "overwrites data", warn_delete=True)
    if head == "find":
        if "-delete" in args:
            return Review("ASK_FORCED", "deletes files", warn_delete=True)
        for flag in ("-exec", "-execdir", "-ok", "-okdir"):
            if flag in args:
                inner = args[args.index(flag) + 1:]
                inner = inner[:inner.index(";")] if ";" in inner else inner
                found = _segment_review([t for t in inner if t != "{}"], patterns, depth)
                if found is not None:
                    return found
    if head == "git" and _git_destructive(args):
        return Review("ASK_FORCED", "destructive git operation", warn_delete=True)
    return None


# Commands that only read, whatever their arguments (``uniq``, ``sort``, ``sed``, ``awk``,
# ``tee`` and interpreters are left out: they can write files or run code).
_READ_ONLY_CMDS = frozenset({
    "ls", "cat", "head", "tail", "wc", "pwd", "which", "whoami", "date", "uname",
    "file", "stat", "du", "df", "tree", "basename", "dirname", "realpath", "readlink",
    "true", "diff", "cmp", "nl", "cut", "grep", "egrep", "fgrep", "rg", "find", "cd",
    "test", "jq", "git",
})
_READ_ONLY_GIT = frozenset({
    "status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe",
    "shortlog", "grep", "ls-tree", "cat-file", "branch",
})
_GIT_BRANCH_LISTING = frozenset({"-a", "-r", "-v", "-vv", "--list", "--all", "--remotes",
                                 "--show-current", "--no-color"})
_FIND_ACTIONS = frozenset({"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint",
                           "-fprint0", "-fprintf", "-fls"})
_SHELL_OPERATORS = frozenset({";", "&&", "||", "|"})
# Options with which an otherwise reading command writes a file or changes something
_WRITING_OPTIONS = {"tree": ("-o",), "file": ("-C",), "date": ("-s", "--set")}


def _reads_only(tokens: list[str], text: str) -> bool:
    """Every part of the command is a known reader with nothing that writes or runs."""
    if "$(" in text or "`" in text or "<(" in text or ">(" in text:
        return False
    for token in tokens:
        # shlex leaves operators as their own tokens; a quoted ">" stays inside a word
        if set(token) <= set(";&|<>(){}") and token not in _SHELL_OPERATORS:
            return False
    segments = _segments(tokens)
    if not segments:
        return False
    for raw in segments:
        # A variable set in front can make a reader run a program (GIT_EXTERNAL_DIFF,
        # PAGER, LD_PRELOAD, RIPGREP_CONFIG_PATH …), so none is allowed, nor ``env``
        if any(_ASSIGNMENT.match(t) or os.path.basename(t) == "env" for t in raw):
            return False
        seg = _unwrap(raw)
        if not seg:
            return False
        head, args = os.path.basename(seg[0]), seg[1:]
        if head not in _READ_ONLY_CMDS or seg[0] != head:
            return False  # also refuses ./ls and /tmp/cat, which could be anything
        if head == "find" and any(a in _FIND_ACTIONS for a in args):
            return False
        if head == "rg" and any(a.startswith("--pre") for a in args):
            return False  # --pre runs a program on every file
        if any(a.startswith(_WRITING_OPTIONS.get(head, ("\0",))) for a in args):
            return False
        if head == "git":
            if not args or args[0] not in _READ_ONLY_GIT:
                return False  # also refuses git -c …, which can run programs
            if any(a.startswith(("--output", "--ext-diff", "--open-files-in-pager"))
                   or (args[0] == "grep" and a.startswith("-O")) for a in args[1:]):
                return False
            if args[0] == "branch" and any(a not in _GIT_BRANCH_LISTING for a in args[1:]):
                return False
    return True


def classify_command(command: str, credential_files: Iterable[str] | None = None, *,
                     _depth: int = 0) -> Review:
    patterns = tuple(credential_files if credential_files is not None
                     else DEFAULT_CREDENTIAL_FILES)
    text = command or ""
    if _depth > 3:
        return Review("ASK_FORCED", "nested too deep to read")
    tokens = _tokens(text)
    if tokens is None:
        return Review("ASK_FORCED", "command could not be parsed")
    found = [_segment_review(seg, patterns, _depth) for seg in _segments(tokens)]
    # 双引号里的 $(...) 在 shlex 看来只是一个字符串，单独拆出来再判一次
    for inner in re.findall(r"\$\(([^()]*)\)", text):
        found.append(classify_command(inner, patterns, _depth=_depth + 1))
    worst = _worst(found)
    if worst is not None and worst.verdict != "ASK":
        return worst
    if _depth == 0 and _reads_only(tokens, text):
        return Review("ASK", "only reads", pattern="read-only",
                      scope="read-only commands (ls, cat, rg, git status, git diff …)")
    return Review("ASK", "runs a shell command")


# ── "commands starting with …" ─────────────────────────────────────────────

# ``cd <dir> &&`` or ``cd <dir> ;`` at the start of a command
_CD_IN_FRONT = re.compile(r"""\A\s*cd\s+(?:--\s+)?("[^"$`]*"|'[^']*'|[^\s;&|<>()$`'"]+)\s*(?:&&|;)\s*""")
_SUBCOMMAND = re.compile(r"[A-Za-z][A-Za-z0-9_:-]*\Z")
_PYTHON = re.compile(r"python(?:\d+(?:\.\d+)*)?\Z")
_SCRIPT_RUNNERS = frozenset({"node", "ruby", "perl", "php", "bash", "sh", "zsh", "dash", "ksh",
                             "fish", "pwsh", "powershell"})
# Tools whose next word names what they do (``git add``, ``npm test``)
_SUBCOMMAND_TOOLS = frozenset({
    "git", "npm", "pnpm", "yarn", "bun", "deno", "npx", "pnpx", "bunx", "uv", "uvx", "pip",
    "pip3", "pipx", "poetry", "pdm", "hatch", "pipenv", "conda", "mamba", "cargo", "rustup",
    "go", "make", "just", "task", "docker", "podman", "kubectl", "helm", "terraform", "gh",
    "gradle", "gradlew", "mvn", "dotnet", "swift", "rake", "bundle", "gem", "brew", "mix",
    "flutter", "dart", "tox", "nox", "zig", "stack", "cabal", "composer", "sbt", "lein",
})
# ... and whose word after that does too (``npm run build``, ``uv run pytest``)
_RUNNER_SUBCOMMANDS = frozenset({"run", "exec", "compose", "x", "dlx", "tool", "mod", "workspace"})
# Programs for which "every call starting with this" would allow nearly anything
_NO_PREFIX = frozenset({
    "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp",
    "chmod", "chown", "chgrp", "kill", "pkill", "killall", "mv", "cp", "ln", "install", "open",
    "xdg-open", "osascript", "crontab", "launchctl", "systemctl", "eval", "source", ".",
    "watch", "parallel", "sed", "awk", "tee",
})


def without_workspace_cd(command: str, root: Path | None) -> str:
    """``command`` without a leading ``cd <root> &&``: commands already run in the
    workspace, so that ``cd`` changes nothing and should not make a rule miss."""
    if root is None:
        return command
    text = command
    for _ in range(3):
        match = _CD_IN_FRONT.match(text)
        if match is None:
            break
        raw = match.group(1)
        if raw[:1] in "\"'":
            raw = raw[1:-1]
        try:
            target = Path(os.path.expanduser(raw))
            if (target if target.is_absolute() else root / target).resolve() != root:
                break
        except (OSError, ValueError, RuntimeError):
            break
        text = text[match.end():]
    return text if text.strip() else command


def _simple_words(command: str) -> list[str] | None:
    """The words of a command that is one program and its arguments: no pipes, lists,
    redirections, substitutions, variables or wrappers in front."""
    if any(mark in command for mark in ("$(", "`", "<(", ">(", "\n")):
        return None
    tokens = _tokens(command)
    if not tokens or any(set(t) <= set(";&|<>(){}") for t in tokens):
        return None
    if _unwrap(tokens) != tokens or _command_name(tokens[0]) in _PRIV_ESC | {"env"}:
        return None
    return tokens


def command_prefix(command: str) -> tuple[str, ...]:
    """The words a "commands starting with" rule keeps for ``command``: the program, and
    its script, module or subcommand (``python3 -m pytest``, ``npm run build``,
    ``git add``). Empty when the command is not one simple program call, or when the rule
    would allow an interpreter or a program that can do nearly anything."""
    words = _simple_words(command)
    if not words:
        return ()
    head, rest = _command_name(words[0]), words[1:]
    if head in _NO_PREFIX:
        return ()
    if _PYTHON.match(head):
        if rest[:1] == ["-m"] and len(rest) > 1 and _SUBCOMMAND.match(rest[1]):
            return tuple(words[:3])
        return tuple(words[:2]) if rest and not rest[0].startswith("-") else ()
    if head in _SCRIPT_RUNNERS:
        return tuple(words[:2]) if rest and not rest[0].startswith("-") else ()
    if head in _SUBCOMMAND_TOOLS:
        if not rest or not _SUBCOMMAND.match(rest[0]):
            return ()  # git -c …: the rule would cover every git command
        if rest[0] in _RUNNER_SUBCOMMANDS and len(rest) > 1 and _SUBCOMMAND.match(rest[1]):
            return tuple(words[:3])
        return tuple(words[:2])
    if head in _READ_ONLY_CMDS:
        return ()  # a reader that got here writes or runs something (find -exec, tree -o)
    return (words[0],)


def _prefix_key(words: Iterable[str]) -> str:
    return "prefix:" + json.dumps(list(words), ensure_ascii=False)


def _prefix_keys(command: str) -> tuple[str, ...]:
    """The keys of every prefix rule that covers ``command``: one per word count."""
    words = _simple_words(command)
    return tuple(_prefix_key(words[:n]) for n in range(1, len(words) + 1)) if words else ()


# ── per-thread "always" rules ──────────────────────────────────────────────


class ApprovalStore:
    """One JSON file per thread: active rules plus a short decision log."""

    _LOG_LIMIT = 200

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._lock = threading.RLock()

    def _path(self, thread_id: str) -> Path:
        key = hashlib.sha256((thread_id or "").encode("utf-8")).hexdigest()[:32]
        return self.root / f"{key}.json"

    def _load(self, thread_id: str) -> dict[str, Any]:
        try:
            data = json.loads(self._path(thread_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        rules = data.get("rules") if isinstance(data.get("rules"), list) else []
        log = data.get("log") if isinstance(data.get("log"), list) else []
        return {"rules": [r for r in rules if isinstance(r, dict)],
                "log": [e for e in log if isinstance(e, dict)]}

    def _save(self, thread_id: str, data: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        path = self._path(thread_id)
        tmp = path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"rules": data["rules"], "log": data["log"][-self._LOG_LIMIT:]}, fh,
                      ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def rules(self, thread_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return [r for r in self._load(thread_id)["rules"] if not r.get("revoked")]

    def log(self, thread_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return self._load(thread_id)["log"]

    def matches(self, thread_id: str, tool: str, pattern: str) -> bool:
        return self.matches_any(thread_id, tool, (pattern,))

    def matches_any(self, thread_id: str, tool: str, patterns: Iterable[str]) -> bool:
        wanted = {p for p in patterns if p}
        if not thread_id or not wanted:
            return False
        return any(r.get("tool") == tool and r.get("pattern") in wanted
                   for r in self.rules(thread_id))

    def record(self, thread_id: str, kind: str, tool: str, pattern: str = "",
               label: str = "") -> None:
        if not thread_id:
            return
        with self._lock:
            data = self._load(thread_id)
            entry = {"kind": kind, "tool": tool, "pattern": pattern, "label": label,
                     "at": time.time()}
            if kind == "always" and pattern and not any(
                    r.get("tool") == tool and r.get("pattern") == pattern
                    and not r.get("revoked") for r in data["rules"]):
                data["rules"].append({k: entry[k] for k in ("tool", "pattern", "label", "at")})
            data["log"].append(entry)
            self._save(thread_id, data)

    def revoke(self, thread_id: str, index: int) -> dict[str, Any] | None:
        """``index`` counts active rules as ``rules()`` lists them."""
        with self._lock:
            data = self._load(thread_id)
            active = [r for r in data["rules"] if not r.get("revoked")]
            if not 0 <= index < len(active):
                return None
            rule = active[index]
            rule["revoked"] = True
            data["log"].append({"kind": "revoke", "tool": rule.get("tool", ""),
                                "pattern": rule.get("pattern", ""),
                                "label": rule.get("label", ""), "at": time.time()})
            self._save(thread_id, data)
            return rule


# ── the policy the harness and the UI share ────────────────────────────────


def _thread_of(request: Any) -> str:
    runtime = getattr(request, "runtime", None)
    config = getattr(runtime, "config", None) or {}
    return str((config.get("configurable") or {}).get("thread_id") or "")


def _patch_paths(patch: str) -> tuple[list[str], bool]:
    paths: list[str] = []
    deletes = False
    for line in (patch or "").splitlines():
        match = re.match(r"^\*\*\* (Add File|Update File|Delete File|Move to):\s*(.+?)\s*$", line)
        if match:
            paths.append(match.group(2))
            deletes = deletes or match.group(1) == "Delete File"
    return paths, deletes


class ApprovalPolicy:
    def __init__(self, store: ApprovalStore, *, credential_files: Iterable[str] | None = None
                 ) -> None:
        self.store = store
        self.credential_files = tuple(credential_files or DEFAULT_CREDENTIAL_FILES)
        self._inside: Callable[[str], bool] = lambda _path: False
        self._root: Path | None = None
        self._yolo_threads: set[str] = set()
        self._yolo_lock = threading.RLock()
        # HITL re-enters the same tool call on resume. Remember that call's
        # first predicate result while letting later calls see live policy.
        self._visible_turns: dict[str, dict[tuple[str, str, str], bool]] = {}

    def begin_visible_turn(self, thread_id: str) -> None:
        with self._yolo_lock:
            self._visible_turns[thread_id] = {}

    def end_visible_turn(self, thread_id: str) -> None:
        with self._yolo_lock:
            self._visible_turns.pop(thread_id, None)

    def set_yolo(self, thread_id: str, enabled: bool) -> None:
        """Switch approval-free execution for one live conversation thread."""
        if not thread_id:
            return
        with self._yolo_lock:
            if enabled:
                self._yolo_threads.add(thread_id)
            else:
                self._yolo_threads.discard(thread_id)

    def yolo_enabled(self, thread_id: str) -> bool:
        with self._yolo_lock:
            return bool(thread_id and thread_id in self._yolo_threads)

    def bind_workspace(self, resolve: Callable[[str], Path], root: Path) -> None:
        """How the backend maps a tool path to disk, so rules can stay inside ``root``."""
        root = Path(root).resolve()
        self._root = root

        def inside(raw: str) -> bool:
            try:
                return resolve(raw).resolve().is_relative_to(root)
            except (OSError, ValueError, RuntimeError):
                return False

        self._inside = inside

    def review(self, tool: str, args: Any) -> Review:
        args = args if isinstance(args, dict) else {}
        if tool == "execute":
            command = str(args.get("command") or "")
            found = classify_command(command, self.credential_files)
            if found.verdict != "ASK" or found.pattern == "read-only":
                return found
            core = without_workspace_cd(command, self._root)
            digest = hashlib.sha256(core.encode("utf-8")).hexdigest()
            return Review("ASK", found.reason, pattern=f"sha256:{digest}",
                          scope="this exact command", prefix=command_prefix(core),
                          covered_by=_prefix_keys(core))
        if tool == "delete":
            return Review("ASK_FORCED", "deletes a file or directory", warn_delete=True)
        if tool in FILE_EDIT_TOOLS:
            if tool == "apply_patch":
                paths, deletes = _patch_paths(str(args.get("patchText") or ""))
                if deletes:
                    return Review("ASK_FORCED", "the patch deletes a file", warn_delete=True)
            else:
                paths = [str(args.get("file_path") or args.get("path") or "")]
            if paths and all(p and self._inside(p) for p in paths):
                return Review("ASK", "changes files in the workspace", pattern="workspace",
                              scope="file changes inside the workspace")
            return Review("ASK", "changes files outside the workspace")
        return Review("ASK", f"{tool} can change state", pattern="*", scope=f"every {tool} call")

    def remember(self, thread_id: str, tool: str, args: Any, decision: str) -> bool:
        """Log a panel decision; ``always`` adds a rule when this call allows one."""
        review = self.review(tool, args)
        if decision in ("always", "prefix"):
            pattern, scope = ((review.pattern, review.scope) if decision == "always"
                              else (review.prefix_pattern, review.prefix_scope))
            if not (review.allow_always and pattern):
                self.store.record(thread_id, "reject", tool, review.pattern,
                                  "always is not offered for this call")
                return False
            self.store.record(thread_id, "always", tool, pattern, scope)
            return True
        self.store.record(thread_id, "once" if decision == "approve" else "reject", tool,
                          review.pattern, review.scope)
        return decision == "approve"

    def needs_approval(self, tool: str, args: Any, thread_id: str, *,
                       allow_yolo: bool = True) -> bool:
        review = self.review(tool, args)
        if review.verdict == "DENY":
            return False  # the backend refuses to run it; asking first would be pointless
        if allow_yolo and self.yolo_enabled(thread_id):
            return False  # policy skips the interrupt; command_guard still enforces DENY
        if review.verdict == "ASK_FORCED":
            return True
        return not self.store.matches_any(thread_id, tool, (review.pattern, *review.covered_by))

    def interrupt_on(self, gated: Iterable[str]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for tool in gated:
            def when(request: Any, _tool: str = tool) -> bool:
                call = getattr(request, "tool_call", None) or {}
                args = call.get("args")
                runtime = getattr(request, "runtime", None)
                config = getattr(runtime, "config", None) or {}
                visible = (config.get("configurable") or {}).get("circle_visible_turn") is True
                thread_id = _thread_of(request)
                if not visible:
                    return self.needs_approval(_tool, args, thread_id, allow_yolo=False)
                call_id = str(call.get("id") or "")
                args_key = json.dumps(args, sort_keys=True, ensure_ascii=False,
                                      separators=(",", ":"), default=str)
                key = (call_id, _tool, args_key)
                with self._yolo_lock:
                    decisions = self._visible_turns.get(thread_id)
                    if decisions is None:
                        return self.needs_approval(_tool, args, thread_id)
                    if key not in decisions:
                        decisions[key] = self.needs_approval(_tool, args, thread_id)
                    return decisions[key]

            out[tool] = {"allowed_decisions": ["approve", "reject"], "when": when}
        return out

    def deny_message(self, command: str) -> str:
        review = classify_command(command, self.credential_files)
        return review.message if review.verdict == "DENY" else ""


def default_policy(home: Path | None, credential_files: Iterable[str] | None = None
                   ) -> ApprovalPolicy:
    from circle.paths import circle_home

    return ApprovalPolicy(ApprovalStore((home or circle_home()) / "approvals"),
                          credential_files=credential_files)
