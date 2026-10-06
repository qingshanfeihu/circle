"""circle CLI — ink TUI gate (init → trust → main), print mode and line mode."""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from circle import __version__
from circle.model import EFFORT_LEVELS
from circle.paths import circle_home, normalize_workspace
from circle.run_options import RunOptions, prompt_text, tool_names
from circle.settings import is_folder_trusted, load_settings

# What --session-id accepts, as pi does: letters, digits, . _ -, starting and ending
# with a letter or digit
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="circle",
        description="A terminal coding agent for your own model endpoint.",
        usage="circle [options] [folder] [@file ...] [message ...]",
        epilog='examples:\n  circle ~/code/app\n  circle . "explain this project"\n'
               '  circle "review this" @src/app.py\n  circle -p "summarize README.md"\n'
               '  git diff | circle -p "review this change"\n'
               '  circle -p --tools read,grep "find the TODOs"\n\n'
               'update: install the latest release (circle update --help)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "words",
        nargs="*",
        metavar="folder / @file / message",
        help="the folder to work in (default: the current folder); messages to send, one "
             "turn each; @path adds a file to the first message",
    )
    parser.add_argument("-v", "--version", action="store_true", help="print the version and exit")
    parser.add_argument(
        "-p",
        "--print",
        dest="prompt",
        nargs="?",
        const="",
        default=None,
        metavar="PROMPT",
        help="send the prompt (and any messages after it, one turn each), print the last "
             "answer and exit; piped input is added before the prompt",
    )
    parser.add_argument(
        "--mode",
        choices=("text", "json", "rpc"),
        default="text",
        help="json: like -p, but write every step to stdout as one JSON object per line; "
             "rpc: take JSON commands on stdin and answer on stdout until stdin closes",
    )
    parser.add_argument(
        "-c",
        "--continue",
        dest="resume_latest",
        action="store_true",
        help="continue the most recent conversation in this folder",
    )
    parser.add_argument(
        "-r",
        "--resume",
        dest="pick_session",
        action="store_true",
        help="choose a saved conversation to open from a list",
    )
    parser.add_argument(
        "--session",
        default="",
        metavar="ID",
        help="reopen a saved conversation by its id, or the end of it (see /resume)",
    )
    parser.add_argument(
        "--session-id",
        default="",
        metavar="ID",
        help="open the conversation with exactly this id, or start one with it",
    )
    parser.add_argument(
        "--fork",
        default="",
        metavar="ID",
        help="start a new conversation here with a copy of a saved one (from any folder)",
    )
    parser.add_argument(
        "--no-session",
        action="store_true",
        help="keep this conversation in memory only: not saved, not listed",
    )
    parser.add_argument("-n", "--name", default="", help="give this conversation a title")
    parser.add_argument(
        "-m",
        "--model",
        default="",
        help="use this model id for this run without saving it",
    )
    parser.add_argument(
        "--thinking",
        choices=EFFORT_LEVELS,
        default="",
        metavar="LEVEL",
        help=f"thinking depth for this run: {', '.join(EFFORT_LEVELS)}",
    )
    parser.add_argument(
        "--models",
        default="",
        metavar="PATTERNS",
        help="comma-separated models or patterns (step-*) that ctrl+p switches between",
    )
    parser.add_argument(
        "--list-models",
        nargs="?",
        const="",
        default=None,
        metavar="SEARCH",
        help="list the models the endpoint offers, optionally only those matching, and exit",
    )
    parser.add_argument(
        "--export",
        nargs="+",
        default=None,
        metavar="ID",
        help="--export ID [OUT]: write a saved conversation as HTML (JSONL when OUT ends in "
             ".jsonl) and exit; OUT defaults to circle-ID.html here",
    )
    parser.add_argument(
        "--system-prompt",
        default=None,
        metavar="TEXT|FILE",
        help="replace Circle's own instructions (project files and the environment stay)",
    )
    parser.add_argument(
        "--append-system-prompt",
        action="append",
        default=[],
        metavar="TEXT|FILE",
        help="add to the system prompt; can be given more than once",
    )
    parser.add_argument(
        "-nc",
        "--no-context-files",
        action="store_true",
        help="do not read AGENTS.md or CLAUDE.md",
    )
    parser.add_argument(
        "-t",
        "--tools",
        default=None,
        metavar="LIST",
        help="comma-separated tools the model may use, and no others "
             "(read_file or read, grep, glob or find, ls, execute or bash, edit_file, …)",
    )
    parser.add_argument(
        "-xt",
        "--exclude-tools",
        default="",
        metavar="LIST",
        help="comma-separated tools the model may not use",
    )
    parser.add_argument(
        "-nt",
        "--no-tools",
        action="store_true",
        help="give the model no tools",
    )
    parser.add_argument(
        "--yolo",
        action="store_true",
        help="with -p or --line: allow commands and file changes without asking "
             "(deleting, rm -rf and force-push are still not run)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="with -p or --line: show tool calls and token use on stderr",
    )
    parser.add_argument(
        "--init",
        action="store_true",
        help="run model setup again (resets settings.json)",
    )
    parser.add_argument(
        "--print-home",
        action="store_true",
        help="print the data folder and exit",
    )
    parser.add_argument(
        "--line",
        action="store_true",
        help="read one prompt per line instead of opening the full-screen interface",
    )
    return parser


def _configure_windows_stdio() -> None:
    """Frozen Python ignores PYTHONUTF8; redirected Windows streams still need Unicode."""
    if sys.platform != "win32":
        return
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def _is_dir(word: str) -> bool:
    try:
        return Path(word).expanduser().is_dir()
    except (OSError, ValueError):
        return False


def _is_file_arg(word: str) -> bool:
    return word.startswith("@") and len(word) > 1


def _parse(argv: list[str] | None) -> argparse.Namespace:
    """Options anywhere; the words are a folder, ``@files`` and messages.

    The first word is the folder when it is one, or when it is a single word that does not
    start with ``@`` (so a mistyped folder is an error, not a message). A message with
    spaces is never a folder."""
    parser = _build_parser()
    args = parser.parse_intermixed_args(argv)
    words = list(args.words)
    if args.prompt and (_is_dir(args.prompt) or _is_file_arg(args.prompt)):
        # ``-p`` took a folder or an @file as its prompt (``circle -p ~/code/app`` with the
        # prompt piped in, ``circle -p @notes.md "summarize"``): it was a flag
        words.insert(0, args.prompt)
        args.prompt = ""
    if args.mode == "json" and args.prompt is None:
        args.prompt = ""  # --mode json runs like -p and takes its prompt the same way
    args.files = [w[1:] for w in words if _is_file_arg(w)]
    words = [w for w in words if not _is_file_arg(w)]
    if args.prompt == "" and words and not _is_dir(words[0]):
        # ``-p`` given as a flag (``circle -p -c "question" [folder]``): the first word
        # after the options is the prompt
        args.prompt = words.pop(0)
    args.workspace = "."
    if words and (_is_dir(words[0]) or not any(ch.isspace() for ch in words[0])):
        args.workspace = words.pop(0)
    elif len(words) > 1 and _is_dir(words[-1]):
        args.workspace = words.pop()  # ``circle "question" ~/code/app``
    args.messages = words
    return args


def _run_options(args: argparse.Namespace) -> RunOptions:
    tools: list[str] | None = None
    if args.no_tools:
        tools = []
    elif args.tools is not None:
        tools = tool_names(args.tools)
    return RunOptions(
        system_prompt=prompt_text(args.system_prompt) if args.system_prompt is not None else None,
        append_system_prompt=[prompt_text(value) for value in args.append_system_prompt],
        no_context_files=args.no_context_files,
        tools=tools,
        exclude_tools=tool_names(args.exclude_tools),
        session_name=" ".join(args.name.split())[:80],
        no_session=args.no_session,
        models=[p.strip() for p in args.models.split(",") if p.strip()],
    )


def _conflict(args: argparse.Namespace) -> str:
    """Options that cannot go together, as a message, or ""."""
    opening = [flag for flag, on in (("-c", args.resume_latest), ("-r", args.pick_session),
                                     ("--session", bool(args.session))) if on]
    if args.fork and (opening or args.no_session):
        return f"--fork starts a new conversation; it cannot go with {(opening or ['--no-session'])[0]}"
    if args.session_id and opening:
        return f"--session-id chooses the conversation; it cannot go with {opening[0]}"
    if args.no_session and (opening or args.session_id):
        return "--no-session keeps nothing, so there is nothing to open"
    if args.session_id and not _SESSION_ID_RE.match(args.session_id):
        return ("--session-id takes letters, digits, '.', '_' and '-', starting and ending "
                "with a letter or digit")
    if args.line and args.mode != "text":
        return f"--mode {args.mode} and --line cannot go together"
    if args.mode == "rpc" and (args.prompt is not None or args.messages or args.files):
        return "--mode rpc takes its prompts as commands on standard input, not as words"
    if args.mode == "rpc" and args.pick_session:
        return "-r opens a list to choose from, so it needs the full-screen interface"
    if args.pick_session and (args.prompt is not None or args.line or args.mode == "json"):
        return ("-r opens a list to choose from, so it needs the full-screen interface; "
                "use -c or --session ID with -p and --line.")
    if args.line and (args.messages or args.files):
        return "--line reads its messages from standard input, one per line"
    if args.pick_session and (args.messages or args.files):
        return "-r opens a list to choose from; send the message once the session is open"
    return ""


def _file_blocks(names: list[str], workspace: Path | None = None) -> str | int:
    """The ``@files`` from the command line as text for the first message, or an exit code
    when one cannot be read. A path is looked for in the current folder, then in the
    folder Circle works in."""
    from circle.mentions import file_block

    blocks: list[str] = []
    for name in names:
        path = Path(name).expanduser()
        if not path.exists() and workspace is not None and (workspace / path).exists():
            path = workspace / path
        try:
            body = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"circle: no such file: {name}", file=sys.stderr)
            return 2
        except UnicodeDecodeError:
            print(f"circle: {name} is not a text file", file=sys.stderr)
            return 2
        except OSError as exc:
            print(f"circle: cannot read {name}: {exc.strerror or exc}", file=sys.stderr)
            return 2
        if body.strip():
            blocks.append(file_block(name, body))
    return "\n\n".join(blocks)


def _export(values: list[str], home: Path) -> int:
    from circle import session_index
    from circle.session_export import (
        SessionMeta,
        export_kind,
        read_saved_messages,
        to_html,
        to_jsonl,
    )

    if len(values) > 2:
        print("circle: --export takes a session id and, optionally, a file to write",
              file=sys.stderr)
        return 2
    found = session_index.find(home, values[0])
    if found is None:
        print(f"No saved session matches {values[0]!r}. "
              "Run /resume in a session to list them.", file=sys.stderr)
        return 2
    out = Path(values[1]).expanduser() if len(values) == 2 else Path(f"{found.thread_id}.html")
    kind = export_kind(str(out))
    messages = read_saved_messages(home, found.thread_id, workspace=found.workspace,
                                   checkpoint=found.leaf or None)
    if not messages:
        print(f"circle: session {found.thread_id} has no saved messages", file=sys.stderr)
        return 1
    meta = SessionMeta(thread_id=found.thread_id, title=found.title,
                       workspace=found.workspace, model=found.model)
    try:
        out.write_text(to_jsonl(messages, meta) if kind == "jsonl" else to_html(messages, meta),
                       encoding="utf-8")
    except OSError as exc:
        print(f"circle: cannot write {out}: {exc.strerror or exc}", file=sys.stderr)
        return 1
    print(out)
    return 0


def _list_models(search: str, home: Path) -> int:
    from circle.probe import probe_endpoint
    from circle.settings import load_credentials

    settings = load_settings(home)
    if not settings.is_ready():
        print("Circle is not set up yet. Run `circle` in a terminal first.", file=sys.stderr)
        return 2
    creds = load_credentials(home)
    key = creds.get(settings.auth.api_key_ref) or creds.get("api_key") or ""
    found = probe_endpoint(settings.auth.base_url, key) if key else None
    models = list(found.models) if found is not None else []
    if not models:
        print(f"circle: {settings.auth.base_url} did not list its models", file=sys.stderr)
        return 1
    words = search.lower().split()
    shown = [m for m in models if all(w in m.lower() for w in words)]
    for model in shown:
        mark = "  (current)" if model == settings.auth.model else ""
        print(f"{model}{mark}")
    if not shown:
        print(f"circle: no model matches {search!r}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    _configure_windows_stdio()
    raw = sys.argv[1:] if argv is None else list(argv)
    if raw[:1] == ["update"]:  # a folder named "update" is opened as ./update
        from circle.update import update_main

        return update_main(raw[1:])
    args = _parse(raw)
    if args.version:
        print(__version__)
        return 0
    if args.print_home:
        print(circle_home())
        return 0

    home = circle_home()
    if args.list_models is not None:
        return _list_models(args.list_models, home)
    if args.export is not None:
        return _export(args.export, home)
    problem = _conflict(args)
    if problem:
        print(f"circle: {problem}", file=sys.stderr)
        return 2
    if args.thinking:
        os.environ["CIRCLE_REASONING_EFFORT"] = args.thinking
    workspace = normalize_workspace(args.workspace)
    saved = _saved_thread(args, home, workspace)
    if isinstance(saved, int):
        return saved
    args.thread_id = saved
    args.fork_id = None
    if args.fork:
        from circle import session_index

        found = session_index.find(home, args.fork)
        if found is None:
            print(f"No saved session matches {args.fork!r}. "
                  "Run /resume in a session to list them.", file=sys.stderr)
            return 2
        args.fork_id = found.thread_id
    args.new_thread_id = None
    if args.session_id:
        from circle import session_index

        found = session_index.find(home, args.session_id)
        exists = found is not None and found.thread_id == args.session_id
        if exists and args.fork:
            print(f"circle: a conversation {args.session_id!r} exists already; --fork needs a "
                  "new id", file=sys.stderr)
            return 2
        if exists:
            args.thread_id = found.thread_id
        else:
            args.new_thread_id = args.session_id
    attached = _file_blocks(args.files, workspace)
    if isinstance(attached, int):
        return attached
    args.attached = attached
    args.options = _run_options(args)
    if args.mode == "rpc":
        settings = _headless_settings(args, home, workspace)
        if isinstance(settings, int):
            return settings
        from circle.main_session import run_rpc

        return run_rpc(settings, workspace, home=home, **_mode_options(args))
    if args.prompt is not None:
        return _print_mode(args, home, workspace)
    use_tui = (
        not args.line
        and sys.stdin.isatty()
        and sys.stdout.isatty()
        and not (os_environ_no_tui())
    )
    if use_tui:
        from circle.ink.termio.terminal import TerminalUnsupported
        from circle.tui.session_app import run_circle_session

        try:
            return run_circle_session(
                workspace, home=home, force_init=args.init, model_override=args.model or None,
                resume=args.thread_id, pick_session=args.pick_session, run_options=args.options,
                thread_id=args.new_thread_id, fork=args.fork_id, initial=_initial_messages(args))
        except TerminalUnsupported as exc:
            print(f"circle: {exc}\nPlain line mode still works: circle --line", file=sys.stderr)
            return 1

    # Line-mode fallback (CI / pipes)
    settings = _headless_settings(args, home, workspace)
    if isinstance(settings, int):
        return settings

    from circle.main_session import run_main

    return run_main(settings, workspace, home=home, **_mode_options(args))


def _saved_thread(args: argparse.Namespace, home: Path, workspace: Path) -> str | None | int:
    """The saved conversation ``-c`` or ``--session`` asks for, None for a new one, or an
    exit code when ``--session`` names nothing."""
    if not (args.resume_latest or args.session):
        return None
    from circle import session_index

    if args.session:
        found = session_index.find(home, args.session)
        if found is None:
            print(f"No saved session matches {args.session!r}. "
                  "Run /resume in a session to list them.", file=sys.stderr)
            return 2
        return found.thread_id
    found = session_index.latest(home, workspace)
    return found.thread_id if found else None


def _mode_options(args: argparse.Namespace) -> dict[str, object]:
    """What print and line mode take from the command line."""
    options: dict[str, object] = {}
    if args.options != RunOptions():
        options["run_options"] = args.options
    thread_id = getattr(args, "thread_id", None) or getattr(args, "new_thread_id", None)
    if thread_id:
        options["thread_id"] = thread_id
    if getattr(args, "new_thread_id", None) or getattr(args, "fork_id", None):
        options["fresh"] = True  # a new conversation, titled from its first message
    if getattr(args, "fork_id", None):
        options["fork"] = args.fork_id
    if args.yolo:
        options["yolo"] = True
    if args.verbose:
        options["verbose"] = True
    return options


def _initial_messages(args: argparse.Namespace) -> list[tuple[str, str]]:
    """The messages to send when the session opens, as (text for the model, text shown);
    the @files go with the first."""
    messages = list(args.messages)
    if not messages and not args.attached:
        return []
    first = messages[0] if messages else ""
    shown = " ".join([first, *(f"@{name}" for name in args.files)]).strip()
    full = "\n\n".join(part for part in (first, args.attached) if part)
    return [(full, shown)] + [(text, text) for text in messages[1:]]


def _headless_settings(args: argparse.Namespace, home: Path, workspace: Path):
    """Settings for a run without the full-screen interface, or an exit code."""
    from circle.init_flow import run_init
    from circle.trust_flow import run_trust_prompt

    settings = load_settings(home)
    if args.init or not settings.is_ready():
        if not sys.stdin.isatty():
            print("Circle is not set up yet. Run `circle` in a terminal first.", file=sys.stderr)
            return 2
        settings = run_init(home=home)

    if not workspace.is_dir():
        print(f"No such folder: {workspace}", file=sys.stderr)
        return 2

    if not is_folder_trusted(settings, workspace):
        if not sys.stdin.isatty():
            print(f"This folder is not trusted yet: {workspace}\n"
                  "Run `circle` there once in a terminal and trust it.", file=sys.stderr)
            return 2
        trusted = run_trust_prompt(settings, workspace, home=home)
        if trusted is None:
            return 1
        settings = trusted
    from circle.settings import apply_project_settings

    _changed, problems = apply_project_settings(settings, workspace)
    for problem in problems:
        print(f"circle: {problem}", file=sys.stderr)
    if args.model:
        settings.auth.model = args.model
    return settings


# How long ``-p PROMPT`` waits for piped input to start before going on without it.
STDIN_WAIT_S = 3.0


def _read_piped(wait_s: float | None) -> str:
    """Piped standard input, or "" when it is a terminal.

    With ``wait_s`` the read only starts if input (or its end) arrives within that time:
    a caller that leaves standard input open and never writes to it, as some scripts
    and CI runners do, would otherwise keep ``circle -p`` waiting forever.
    """
    if sys.stdin.isatty():
        return ""
    if wait_s is not None and not _input_waiting(wait_s):
        print(f"circle: nothing arrived on stdin within {wait_s:.0f}s; going on "
              "without it (use </dev/null to skip the wait)", file=sys.stderr)
        return ""
    return sys.stdin.read()


def _input_waiting(wait_s: float) -> bool:
    """Whether standard input has something to read, or has ended, within ``wait_s``."""
    if os.name == "nt":
        return _windows_input_waiting(wait_s)
    import select

    try:
        ready, _, _ = select.select([sys.stdin], [], [], wait_s)
    except (OSError, ValueError):
        return True
    return bool(ready)


def _windows_input_waiting(wait_s: float) -> bool:
    """``select`` takes only sockets on Windows, so ask the pipe how much it holds. A file,
    or a pipe whose writer has gone, can be read without waiting."""
    import ctypes
    import msvcrt
    import time
    from ctypes import wintypes

    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError, AttributeError):
        return True
    peek = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe  # type: ignore[attr-defined]
    peek.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD, wintypes.LPDWORD,
                     wintypes.LPDWORD, wintypes.LPDWORD]
    peek.restype = wintypes.BOOL
    deadline = time.monotonic() + wait_s
    while True:
        waiting = wintypes.DWORD(0)
        if not peek(handle, None, 0, None, ctypes.byref(waiting), None):
            return True  # not a pipe, or its writer has closed it: reading does not block
        if waiting.value or time.monotonic() >= deadline:
            return bool(waiting.value)
        time.sleep(0.05)


def _print_mode(args: argparse.Namespace, home: Path, workspace: Path) -> int:
    prompt = args.prompt or ""
    more = list(args.messages)
    if not prompt.strip() and more:
        prompt = more.pop(0)
    piped = _read_piped(STDIN_WAIT_S if prompt.strip() else None)
    if piped.strip():
        prompt = f"{piped.rstrip()}\n\n{prompt}".strip() if prompt else piped.strip()
    if args.attached:
        prompt = f"{prompt}\n\n{args.attached}".strip()
    if not prompt.strip():
        print("Nothing to do: give a prompt after -p or pipe one in.", file=sys.stderr)
        return 2
    settings = _headless_settings(args, home, workspace)
    if isinstance(settings, int):
        return settings

    from circle.main_session import run_print

    if args.mode == "json":
        return run_print(settings, workspace, prompt, home=home, more=more, json_events=True,
                         **_mode_options(args))
    return run_print(settings, workspace, prompt, home=home, more=more, **_mode_options(args))


def os_environ_no_tui() -> bool:
    import os

    return os.environ.get("CIRCLE_NO_TUI", "").strip() in {"1", "true", "yes"}


if __name__ == "__main__":
    raise SystemExit(main())
