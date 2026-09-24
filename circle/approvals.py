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
- ``ASK``: asks unless an "always" rule of this thread covers it.

"Always" rules are kept per thread under ``$CIRCLE_HOME/approvals/`` so they survive a
restart and a resumed session: for ``execute`` the rule is the exact command text (a
hash of it is stored, not the text); for file edits it covers files inside the
workspace (edits to paths outside it keep asking); for other tools, every call to that
tool. ``/approvals`` lists and revokes them.

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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Literal

Verdict = Literal["DENY", "ASK", "ASK_FORCED"]

DEFAULT_CREDENTIAL_FILES: tuple[str, ...] = (
    ".env", ".env.*", "*.env", ".netrc", ".pgpass", ".git-credentials", "credentials.json",
    "token.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*.pem", "*.p12", "*.pfx",
)
FILE_EDIT_TOOLS = frozenset({"write_file", "edit_file", "apply_patch"})
REJECTED_BY_USER = "The user rejected this tool call."

_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "|&", "(", ")", "{", "}"})
_PRIV_ESC = frozenset({"sudo", "su", "doas", "pkexec"})
_DELETE_CMDS = frozenset({"rm", "rmdir", "unlink", "shred", "srm", "trash", "trash-put"})
_DISK_CMDS = frozenset({"dd", "truncate", "wipefs", "fdisk", "parted"})
_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})
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

    @property
    def allow_always(self) -> bool:
        return self.verdict == "ASK" and bool(self.pattern)


# ── command classification ─────────────────────────────────────────────────


def _credential_match(token: str, patterns: Iterable[str]) -> str:
    for candidate in (token, token.split("=", 1)[-1] if "=" in token else ""):
        base = os.path.basename(candidate.strip().strip("'\"").rstrip("/"))
        if base and any(fnmatch.fnmatchcase(base, p) for p in patterns):
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
        head = os.path.basename(token)
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


def _segment_review(seg: list[str], patterns: tuple[str, ...], depth: int) -> Review | None:
    for token in seg:
        name = _credential_match(token, patterns)
        if name:
            return _deny_credential(name)
    seg = _unwrap(seg)
    if not seg:
        return None
    head, args = os.path.basename(seg[0]), seg[1:]
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
    return Review("ASK", "runs a shell command")


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
        if not thread_id or not pattern:
            return False
        return any(r.get("tool") == tool and r.get("pattern") == pattern
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

    def bind_workspace(self, resolve: Callable[[str], Path], root: Path) -> None:
        """How the backend maps a tool path to disk, so rules can stay inside ``root``."""
        root = Path(root).resolve()

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
            if found.verdict != "ASK":
                return found
            digest = hashlib.sha256(command.encode("utf-8")).hexdigest()
            return Review("ASK", found.reason, pattern=f"sha256:{digest}",
                          scope="this exact command")
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
        if decision == "always":
            if not review.allow_always:
                self.store.record(thread_id, "reject", tool, review.pattern,
                                  "always is not offered for this call")
                return False
            self.store.record(thread_id, "always", tool, review.pattern, review.scope)
            return True
        self.store.record(thread_id, "once" if decision == "approve" else "reject", tool,
                          review.pattern, review.scope)
        return decision == "approve"

    def needs_approval(self, tool: str, args: Any, thread_id: str) -> bool:
        review = self.review(tool, args)
        if review.verdict == "DENY":
            return False  # the backend refuses to run it; asking first would be pointless
        if review.verdict == "ASK_FORCED":
            return True
        return not self.store.matches(thread_id, tool, review.pattern)

    def interrupt_on(self, gated: Iterable[str]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for tool in gated:
            def when(request: Any, _tool: str = tool) -> bool:
                args = (getattr(request, "tool_call", None) or {}).get("args")
                return self.needs_approval(_tool, args, _thread_of(request))

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
