"""Background jobs: the registry, and commands that keep running after their call returned
(started in the background, moved there, or left running with ``&`` and adopted)."""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

from circle.jobs import JobRegistry, Owner, group_alive, install_exit_guard
from circle.plan_backend import PlanGuardedBackend
from circle.sandbox import CircleSandboxBackend, ShellResponse

pytestmark = pytest.mark.skipif(sys.platform == "win32",
                                reason="POSIX shell and process groups")


def _wait_until(predicate, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def registry():
    jobs = JobRegistry()
    yield jobs
    jobs.stop_all(grace=0.2)


def _backend(tmp_path: Path, jobs: JobRegistry | None, **kwargs) -> CircleSandboxBackend:
    ws = tmp_path / "ws"
    ws.mkdir(exist_ok=True)
    return CircleSandboxBackend(root_dir=ws, virtual_mode=True, inherit_env=True,
                                offload_root=tmp_path / "data", jobs=jobs, **kwargs)


def _ended(jobs: JobRegistry, job_id: str, timeout: float = 10) -> bool:
    return _wait_until(lambda: not jobs.get(job_id).running, timeout)


def test_background_job_ends_with_exit_code_and_notice(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    started = backend.start_background("echo hello; exit 3", owner=Owner("t1"))
    assert isinstance(started, ShellResponse) and started.how == "started"
    job = started.job
    assert started.exit_code is None and job.id in started.output
    assert job.virtual_path.startswith("/background_jobs/") and job.virtual_path in started.output
    assert _ended(registry, job.id)
    done = registry.get(job.id)
    assert (done.status, done.exit_code, done.thread_id) == ("failed", 3, "t1")
    notices = registry.pending_notices("t1")
    assert len(notices) == 1
    assert "exit code 3" in notices[0].text and "hello" in notices[0].text
    assert notices[0].wake


def test_the_model_reads_job_output_by_line_through_the_backend(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    job = backend.start_background("printf 'one\\ntwo\\n\\377bad\\nfour\\n'").job
    assert _ended(registry, job.id)
    window = backend.read(job.virtual_path, offset=1, limit=2)
    assert window.error is None
    assert window.file_data["content"] == "two\n�bad\n"
    assert (window.total_lines, window.start_line, window.next_offset) == (4, 2, 3)
    refused = backend.write(job.virtual_path, "x")
    assert refused.error and "read-only" in refused.error


def test_ampersand_returns_and_leftovers_are_adopted(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    began = time.monotonic()
    result = backend.execute("sleep 30 & echo started", owner=Owner("t1"))
    assert time.monotonic() - began < 5, "the call returns when the shell ends"
    assert isinstance(result, ShellResponse) and result.how == "adopted"
    assert result.exit_code == 0 and "started" in result.output
    job = registry.get(result.job.id)
    assert job.kind == "adopted" and job.running and job.id in result.output
    stopped = registry.stop(job.id, by="user")
    assert stopped.status == "stopped"
    assert registry.pending_notices("t1")[0].wake is False, "your own stop does not wake"


def test_without_a_registry_leftovers_end_with_the_command(tmp_path):
    backend = _backend(tmp_path, None)
    # longer than the moment Circle gives leftovers to end by themselves
    result = backend.execute("(sleep 0.8; touch late) & echo hi")
    assert result.output == "hi\n" and result.exit_code == 0
    time.sleep(1.0)
    assert not (tmp_path / "ws" / "late").exists()


def test_the_default_timeout_moves_the_command_to_the_background(tmp_path, registry):
    backend = _backend(tmp_path, registry, timeout=1)
    result = backend.execute("echo begun; sleep 1.5; echo finished", owner=Owner("t1"))
    assert isinstance(result, ShellResponse) and result.how == "moved"
    assert result.exit_code is None and "begun" in result.output
    job = result.job
    assert _ended(registry, job.id)
    assert registry.get(job.id).status == "done"
    assert Path(job.output_path).read_text() == "begun\nfinished\n"
    assert registry.pending_notices("t1"), "the model hears when it ends"


def test_an_explicit_timeout_still_ends_the_command(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    result = backend.execute("(sleep 5; touch orphan) & sleep 5", timeout=1)
    assert result.exit_code == 124 and not isinstance(result, ShellResponse)
    assert registry.list() == []
    time.sleep(0.2)
    assert not (tmp_path / "ws" / "orphan").exists()


def test_a_waiting_command_can_be_moved_to_the_background(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    results = []
    worker = threading.Thread(target=lambda: results.append(
        backend.execute("sleep 5; echo late", owner=Owner("t1"))))
    worker.start()
    assert _wait_until(lambda: registry.foreground_runs(), 5)
    assert registry.detach_foreground() == 1
    worker.join(5)
    assert results and results[0].how == "moved"
    assert registry.get(results[0].job.id).running


def test_a_bare_sleep_ends_early_when_a_job_of_the_model_ends(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    job = backend.start_background("sleep 0.5", owner=Owner("t1")).job
    began = time.monotonic()
    result = backend.execute("sleep 20", owner=Owner("t1"))
    assert time.monotonic() - began < 5
    assert result.exit_code == 0 and "ended early" in result.output and job.id in result.output


def test_plan_mode_blocks_background_commands_too(tmp_path, registry):
    backend = PlanGuardedBackend(root_dir=tmp_path, virtual_mode=True, inherit_env=True,
                                 plan_mode=True, offload_root=tmp_path / "data", jobs=registry)
    result = backend.start_background("touch x")
    assert "Plan mode is active" in result.output and registry.list() == []


def test_stop_all_ends_whole_groups_and_counts(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    first = backend.start_background("sleep 30 & sleep 30", owner=Owner("t1")).job
    second = backend.start_background("sleep 30", owner=Owner("t1")).job
    assert registry.stop_all(grace=0.5) == 2
    for job in (first, second):
        assert registry.get(job.id).status == "stopped"
    assert registry.pending_notices("t1") == [], "nobody is told when Circle leaves"


def test_a_job_that_writes_too_much_is_stopped(tmp_path, registry, monkeypatch):
    monkeypatch.setenv("CIRCLE_JOB_OUTPUT_LIMIT_MB", "0.01")
    backend = _backend(tmp_path, registry)
    job = backend.start_background("yes circle").job
    assert _ended(registry, job.id)
    ended = registry.get(job.id)
    assert (ended.status, ended.reason) == ("failed", "output limit")


def test_a_background_timeout_fails_the_job(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    job = backend.start_background("sleep 20", timeout=0.5, owner=Owner("t1")).job
    assert _ended(registry, job.id)
    assert (registry.get(job.id).status, registry.get(job.id).reason) == ("failed", "timeout")


def test_notices_are_per_conversation_and_taken_once(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    a = backend.start_background("true", owner=Owner("a")).job
    b = backend.start_background("true", owner=Owner("b")).job
    assert _ended(registry, a.id) and _ended(registry, b.id)
    assert [n.job.id for n in registry.take_notices("a")] == [a.id]
    assert registry.take_notices("a") == []
    assert [n.job.id for n in registry.pending_notices("b")] == [b.id]


def test_notices_wait_for_a_quiet_moment(registry):
    job = registry.register("watch", "w", owner=Owner("t"))
    registry.finish(job.id, "done")
    arrived = registry.pending_notices("t")[0].at
    assert not registry.notice_ready("t", now=arrived + 0.5)
    assert registry.notice_ready("t", now=arrived + 1.1)


def test_the_model_stopping_a_job_tells_nobody(registry):
    job = registry.register("watch", "w", owner=Owner("t"))
    registry.stop(job.id, by="model")
    assert registry.pending_notices("t") == []


def test_listeners_are_called_outside_the_lock(registry):
    seen = []

    def listener(event, job):
        other = threading.Thread(target=lambda: seen.append(registry.get(job.id)))
        other.start()
        other.join(2)
        assert not other.is_alive(), "another thread could not read the registry"

    registry.subscribe(listener)
    job = registry.register("watch", "w")
    registry.finish(job.id, "done")
    assert len(seen) == 2


def test_folders_of_ended_sessions_are_removed(tmp_path):
    root = tmp_path / "background_jobs"
    old = root / f"999999-{int(time.time()) - 3 * 24 * 3600}"
    recent = root / f"999999-{int(time.time())}"
    for folder in (old, recent):
        folder.mkdir(parents=True)
    JobRegistry().bind_root(root)
    assert not old.exists() and recent.exists()


def test_the_exit_guard_stops_jobs_when_circle_is_terminated(tmp_path):
    script = textwrap.dedent(f"""
        import sys, time
        sys.path.insert(0, {str(Path(__file__).resolve().parents[1])!r})
        from circle.jobs import JobRegistry, install_exit_guard
        from circle.sandbox import CircleSandboxBackend
        jobs = JobRegistry()
        backend = CircleSandboxBackend(root_dir={str(tmp_path)!r}, virtual_mode=True,
                                       inherit_env=True, offload_root={str(tmp_path / 'data')!r},
                                       jobs=jobs)
        install_exit_guard(jobs)
        job = backend.start_background("echo $$; sleep 60").job
        print(job.output_path, flush=True)
        time.sleep(60)
    """)
    child = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
    try:
        output_path = Path(child.stdout.readline().strip())
        assert _wait_until(lambda: output_path.exists() and output_path.read_text().strip(), 5)
        pgid = int(output_path.read_text().split()[0])
        assert group_alive(pgid)
        child.terminate()
        child.wait(10)
        assert _wait_until(lambda: not group_alive(pgid), 5), "the job ended with Circle"
    finally:
        if child.poll() is None:
            child.kill()


def test_install_exit_guard_can_be_undone():
    import signal

    jobs = JobRegistry()
    before = signal.getsignal(signal.SIGTERM)
    undo = install_exit_guard(jobs)
    undo()
    assert signal.getsignal(signal.SIGTERM) == before
    assert os.getpid() > 0


def test_on_windows_output_is_decoded_with_the_system_code_page(monkeypatch):
    import locale

    from circle import jobs

    monkeypatch.setattr(jobs.sys, "platform", "win32")
    monkeypatch.setattr(locale, "getpreferredencoding", lambda _do_setlocale=True: "cp936")
    assert jobs.decode_output("中文".encode("cp936")) == "中文"


# ── found in review ─────────────────────────────────────────────────────────


def test_leaving_also_ends_a_command_being_waited_on(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    worker = threading.Thread(target=lambda: backend.execute("sleep 1.5; touch marker",
                                                             owner=Owner("t1")))
    worker.start()
    assert _wait_until(lambda: registry.foreground_runs(), 5)
    registry.stop_all(grace=0.5)
    worker.join(5)
    time.sleep(1.5)
    assert not (tmp_path / "ws" / "marker").exists()


def test_ctrl_b_leaves_the_commands_of_background_agents_alone(registry):
    with registry.foreground("pytest", Owner("t", parent="j1")), \
            registry.foreground("npm test", Owner("t")):
        assert registry.detach_foreground() == 1
        runs = {r.command: r.detach.is_set() for r in registry.foreground_runs()}
    assert runs == {"pytest": False, "npm test": True}


def test_the_waiting_idiom_in_the_prompt_ends_when_the_line_is_there(tmp_path, registry):
    backend = _backend(tmp_path, registry)
    (tmp_path / "ws" / "server.log").write_text("starting\nready on :3000\n")
    job = backend.start_background(
        "until grep -qE 'ready|error' server.log; do sleep 0.2; done").job
    assert _ended(registry, job.id, timeout=5)


def test_a_notice_does_not_count_the_lines_of_a_huge_output(tmp_path, registry, monkeypatch):
    from circle import jobs

    monkeypatch.setattr(jobs, "COUNT_LINES_UP_TO", 10)
    backend = _backend(tmp_path, registry)
    job = backend.start_background("seq 1 100", owner=Owner("t1")).job
    assert _ended(registry, job.id)
    [notice] = registry.pending_notices("t1")
    assert "MB)" in notice.text and "line" in notice.text and "100" in notice.text


def test_what_a_moved_command_says_depends_on_who_waits(tmp_path, registry):
    backend = _backend(tmp_path, registry, timeout=1)
    yours = backend.execute("sleep 2", owner=Owner("t1", started_by="user"))
    assert "shared with the conversation when it ends" in yours.output
    assert "notice" not in yours.output
    subagents = backend.execute("sleep 2", owner=Owner("t1", subagent=True))
    assert "wait_jobs" in subagents.output and "notice" not in subagents.output


def test_output_is_cut_by_characters_as_before(tmp_path):
    backend = _backend(tmp_path, None)
    (tmp_path / "ws" / "wide.txt").write_text("中" * 60_000)
    result = backend.execute("cat wide.txt")
    assert result.output == "中" * 60_000 and not result.truncated


def test_a_command_runs_when_the_data_folder_cannot_be_written(tmp_path, registry, monkeypatch):
    backend = _backend(tmp_path, registry)
    monkeypatch.setattr(registry, "run_output_path",
                        lambda: (_ for _ in ()).throw(PermissionError("read-only")))
    assert backend.execute("echo still").output == "still\n"
