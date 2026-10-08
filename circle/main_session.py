"""Sessions without the full-screen interface: ``circle -p`` and line mode."""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

from langgraph.checkpoint.memory import MemorySaver

from circle import session_index
from circle.approvals import default_policy
from circle.checkpoint_store import make_checkpointer
from circle.harness import create_harness
from circle.headless import HeadlessRun, HeadlessStop, job_record, job_wait_seconds
from circle.job_agents import UnattendedHost
from circle.jobs import JobRegistry, install_exit_guard
from circle.log_setup import configure_file_logging
from circle.model import build_chat_model
from circle.model_guard import add_retry_listener
from circle.run_options import RunOptions
from circle.settings import CircleSettings, apply_auth_to_environ
from circle.tui.replay import write_history
from circle.tui.slash_commands import command_word, parse_slash

logger = logging.getLogger(__name__)


def _build_run(settings: CircleSettings, workspace: Path, *, home: Path | None,
               yolo: bool, verbose: bool, thread_id: str | None,
               run_options: RunOptions | None = None, fork: str | None = None,
               jobs: JobRegistry | None = None) -> HeadlessRun:
    apply_auth_to_environ(settings, home)
    options = run_options or RunOptions()
    agent = create_harness(
        build_chat_model(settings, home=home),
        root_dir=workspace,
        home=home,
        checkpointer=MemorySaver() if options.no_session else make_checkpointer(home),
        model_id=settings.auth.model,
        protocol=settings.auth.protocol,
        approvals=default_policy(home, settings.credential_files or None),
        run_options=options,
        jobs=jobs,
    )
    run = HeadlessRun(agent, yolo=yolo, progress=sys.stderr if verbose else None,
                      no_session=options.no_session)
    tasks = getattr(agent, "_circle_background_tasks", None)
    if tasks is not None:
        # nobody can answer a background agent here: the print-mode rule decides
        tasks.host = UnattendedHost(run.decide_for_job)
    if thread_id:
        run.thread_id = thread_id
        # Where /tree took it back to, if it did: the next turn branches from there
        run.start_from = _leaf(home, thread_id)
    if fork:
        # --fork: the saved conversation's messages (up to its /tree point), copied in
        configurable = {"thread_id": fork}
        if _leaf(home, fork):
            configurable["checkpoint_id"] = _leaf(home, fork)
        state = agent.get_state({"configurable": configurable})
        write_history(agent, run.thread_id, list((state.values or {}).get("messages") or []))
    return run


def _leaf(home: Path | None, thread_id: str) -> str | None:
    try:
        found = session_index.find(home, thread_id)
    except Exception:  # noqa: BLE001 - without the index, the latest is the point
        return None
    return found.leaf or None if found is not None and found.thread_id == thread_id else None


def _remember(run: HeadlessRun, home: Path | None, workspace: Path, settings: CircleSettings,
              title: str) -> None:
    """Add the conversation to the folder's list, so ``circle -c`` can go on with it."""
    if run.no_session:
        return
    try:
        session_index.record(home, run.thread_id, workspace, title=title[:60],
                             model=settings.auth.model)
        session_index.set_leaf(home, run.thread_id, None)  # a turn ran: the latest again
    except Exception:  # noqa: BLE001 - the answer matters more than the list
        logger.warning("could not record the session", exc_info=True)


def _stopped_line(count: int) -> None:
    if count:
        print(f"circle: {count} background job{'s' if count != 1 else ''} stopped",
              file=sys.stderr, flush=True)


def _json_line(event: dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=False, default=str), flush=True)


def _retry_notices(run: HeadlessRun) -> Any:
    def show(event: dict[str, Any]) -> None:
        if event.get("event") == "retry":
            run._say(f"  … {event.get('kind')} error, retry {event.get('attempt')}/"
                     f"{event.get('max')} in {event.get('wait_s')}s")
        elif event.get("event") == "param_dropped":
            run._say(f"  … the endpoint rejected {event.get('param')}; sent again without it")

    return add_retry_listener(show)


def run_print(
    settings: CircleSettings,
    workspace: Path,
    prompt: str,
    *,
    home: Path | None = None,
    yolo: bool = False,
    verbose: bool = False,
    thread_id: str | None = None,
    run_options: RunOptions | None = None,
    fork: str | None = None,
    more: list[str] | None = None,
    json_events: bool = False,
    fresh: bool = False,
) -> int:
    """``circle -p``: one turn for the prompt and one for each of ``more``; the last answer
    goes to stdout. 0 on an answer, 1 otherwise. ``json_events`` (``--mode json``) writes
    every step to stdout as one JSON object per line instead."""
    if home is not None:
        configure_file_logging(home)
    options = run_options or RunOptions()
    jobs = JobRegistry()
    run = _build_run(settings, workspace, home=home, yolo=yolo, verbose=verbose,
                     thread_id=thread_id, run_options=options, fork=fork, jobs=jobs)
    if json_events:
        run.events = _json_line
        _json_line({"type": "session", "id": run.thread_id, "workspace": str(workspace),
                    "model": settings.auth.model})
        jobs.subscribe(lambda event, job: _json_line({"type": "job", "event": event,
                                                      "job": job_record(job)}))
    remove = _retry_notices(run)
    remove_guard = install_exit_guard(jobs)
    continuing = bool(thread_id) and not fresh
    title = options.session_name or ("" if continuing else prompt.strip().split("\n")[0])
    answer = ""
    try:
        for text in [prompt, *(more or [])]:
            answer = run.turn(text)
            _remember(run, home, workspace, settings, title)
            title = ""
        # Background jobs the model started: wait for them and let it answer again
        later = run.settle_jobs(job_wait_seconds())
        if later is not None:
            answer = later
            _remember(run, home, workspace, settings, "")
        if run.stopped_at_deadline:
            count = run.stopped_at_deadline
            print(f"circle: stopped {count} background job{'s' if count != 1 else ''} still "
                  f"running after {job_wait_seconds():g}s (CIRCLE_JOB_WAIT)", file=sys.stderr)
    except HeadlessStop as stop:
        print(f"circle: stopped: {stop}", file=sys.stderr)
        run._emit({"type": "error", "message": f"stopped: {stop}"})
        return 1
    except KeyboardInterrupt:
        print("circle: interrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # noqa: BLE001 - shown to the user, details in the log
        print(f"circle: {type(exc).__name__}: {exc}", file=sys.stderr)
        run._emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        return 1
    finally:
        remove()
        _stopped_line(jobs.stop_all())
        remove_guard()
    if answer and not json_events:
        print(answer)
    if verbose or run.not_run:
        print(run.summary(), file=sys.stderr)
    return 0 if answer else 1


def run_rpc(
    settings: CircleSettings,
    workspace: Path,
    *,
    home: Path | None = None,
    yolo: bool = False,
    verbose: bool = False,
    thread_id: str | None = None,
    run_options: RunOptions | None = None,
    fork: str | None = None,
    fresh: bool = False,
) -> int:
    """``circle --mode rpc``: commands on stdin, responses and events on stdout (circle.rpc)."""
    from circle.headless import new_thread_id
    from circle.rpc import RpcServer

    if home is not None:
        configure_file_logging(home)
    options = run_options or RunOptions()
    first = thread_id or new_thread_id()
    # One registry for the process: the agent is rebuilt for new sessions and models
    jobs = JobRegistry()
    if fork:
        _build_run(settings, workspace, home=home, yolo=yolo, verbose=False, thread_id=first,
                   run_options=options, fork=fork, jobs=jobs)

    def make_run(thread: str) -> HeadlessRun:
        return _build_run(settings, workspace, home=home, yolo=yolo, verbose=False,
                          thread_id=thread, run_options=options, jobs=jobs)

    def list_models() -> list[str]:
        from circle.probe import probe_endpoint
        from circle.settings import load_credentials

        creds = load_credentials(home)
        key = creds.get(settings.auth.api_key_ref) or creds.get("api_key") or ""
        found = probe_endpoint(settings.auth.base_url, key) if key else None
        return list(found.models) if found is not None else []

    def set_model(name: str) -> None:
        settings.auth.model = name  # for this process only, as --model

    server = RpcServer(
        make_run, thread_id=first, title=options.session_name, home=home,
        remember=lambda run, title: _remember(run, home, workspace, settings, title),
        list_models=list_models, model_name=lambda: settings.auth.model, set_model=set_model,
        jobs=jobs)
    remove = _retry_notices(server.run)
    remove_guard = install_exit_guard(jobs)
    try:
        return server.serve(sys.stdin)
    finally:
        remove()
        jobs.stop_all()
        remove_guard()


def run_main(
    settings: CircleSettings,
    workspace: Path,
    *,
    home: Path | None = None,
    yolo: bool = False,
    verbose: bool = False,
    thread_id: str | None = None,
    run_options: RunOptions | None = None,
    fork: str | None = None,
    fresh: bool = False,
) -> int:
    """Line mode: one prompt per line of standard input, all in one conversation."""
    if home is not None:
        configure_file_logging(home)
    interactive = sys.stdin.isatty()
    if interactive:
        print(f"circle · {settings.auth.model} · {workspace}", file=sys.stderr)
        print("type a message and press enter · /help · /exit or an empty line to leave",
              file=sys.stderr)
    options = run_options or RunOptions()
    jobs = JobRegistry()
    run = _build_run(settings, workspace, home=home, yolo=yolo, verbose=verbose,
                     thread_id=thread_id, run_options=options, fork=fork, jobs=jobs)
    remove = _retry_notices(run)
    remove_guard = install_exit_guard(jobs)

    def ended(event: str, job: Any) -> None:
        # Line mode cannot start a turn while it waits for your line: say so, and the
        # model reads the notice with your next message
        if event == "ended" and job.reason != "circle exited":
            print(f"circle: job {job.id} {job.status} · {job.title}", file=sys.stderr,
                  flush=True)

    jobs.subscribe(ended)
    if options.session_name:
        _remember(run, home, workspace, settings, options.session_name)
    titled = bool((thread_id and not fresh) or options.session_name)
    status = 0
    try:
        while True:
            try:
                raw = input("› " if interactive else "")
            except EOFError:
                break
            except KeyboardInterrupt:
                print(file=sys.stderr)
                break
            line = raw.strip()
            if not line:
                if interactive:
                    break
                continue
            parsed = parse_slash(line)
            if parsed is not None and parsed.name == "exit":
                break
            if parsed is not None and parsed.name == "help":
                print("Line mode: each line is a message. /exit or an empty line at a "
                      "terminal leaves. The other commands work in the full-screen "
                      "interface only.", file=sys.stderr)
                continue
            word = command_word(raw)
            if word:
                known = "works in the full-screen interface only" if parsed else "is not a command"
                print(f"circle: /{word} {known}; not sent (a path or a leading space is sent)",
                      file=sys.stderr)
                continue
            try:
                answer = run.turn(line)
                _remember(run, home, workspace, settings, "" if titled else line)
                titled = True
            except HeadlessStop as stop:
                print(f"circle: stopped: {stop}", file=sys.stderr)
                status = 1
                continue
            except KeyboardInterrupt:
                print("circle: interrupted", file=sys.stderr)
                status = 130
                break
            except Exception as exc:  # noqa: BLE001 - shown to the user, details in the log
                print(f"circle: {type(exc).__name__}: {exc}", file=sys.stderr)
                status = 1
                continue
            print(answer or "(no answer)", flush=True)
    finally:
        remove()
        _stopped_line(jobs.stop_all())
        remove_guard()
    if verbose or run.not_run:
        print(run.summary(), file=sys.stderr)
    return status
