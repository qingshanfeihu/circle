import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  openSync,
  closeSync,
  statSync,
  readSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyCommand } from './approvals.js';
import { shellEnvironment, type Sandbox } from './sandbox.js';
import { redact } from './redact.js';
import type { Message } from './types.js';
import stripAnsi from 'strip-ansi';
import { Watch, pollWatch, stopWatch } from './watch.js';
export function plainJobOutput(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      stripAnsi(line.replace(/\r+$/, '').split('\r').at(-1) ?? '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .replaceAll('\t', '    '),
    )
    .join('\n');
}

export interface JobOwner {
  sessionId: string;
  parent?: string;
  startedBy?: 'model' | 'user';
}
export interface Job extends JobOwner {
  id: string;
  kind: 'shell' | 'adopted' | 'agent' | 'watch';
  title: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  reason: string;
  started: number;
  ended?: number;
  exitCode?: number;
  outputPath: string;
  virtualPath: string;
  detail?: string;
  source?: string;
}
interface Entry {
  watch?: Watch;
  job?: Job;
  owner: JobOwner;
  command: string;
  started: number;
  path: string;
  child?: ChildProcess;
  pid?: number;
  shellExited?: boolean;
  exitCode?: number;
  deadline?: number;
  reason?: string;
  stopPromise?: Promise<void>;
  controller: AbortController;
  settled: Promise<void>;
  settle: () => void;
  finished: boolean;
  interrupt?: () => void;
}
export interface ExecuteResult {
  output: string;
  exit_code?: number;
  job?: Job;
  how?: string;
}

export function elapsed(job: Job): string {
  const seconds = Math.floor(((job.ended ?? Date.now()) - job.started) / 1000);
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}
export function outputTail(
  path: string,
  maxBytes = 32_768,
  lines = 20,
): string {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const count = readSync(fd, buffer, 0, buffer.length, start);
    // A tail may start in the middle of a UTF-8 character or a line.
    let skip = 0;
    if (start > 0)
      while (skip < count && (buffer[skip]! & 0xc0) === 0x80) skip++;
    const text = buffer.subarray(skip, count).toString('utf8').trimEnd();
    const firstNewline = text.indexOf('\n');
    return (
      start > 0 && firstNewline >= 0 ? text.slice(firstNewline + 1) : text
    )
      .split('\n')
      .slice(-lines)
      .join('\n');
  } finally {
    closeSync(fd);
  }
}
export function jobLine(job: Job): string {
  return `${job.id} · ${job.kind} · ${job.status}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ''}${job.reason && job.reason !== 'exit' ? ` (${job.reason})` : ''} · ${elapsed(job)} · ${job.title} · output ${job.virtualPath}`;
}
export function jobNotice(job: Job): string {
  let output = 'Output is unavailable.';
  try {
    output =
      redact(outputTail(job.outputPath, job.kind === 'watch' ? 4096 : 32768)) ||
      '(empty)';
  } catch {
    /* Preserve the notice even if an external process removed its output. */
  }
  return `${jobLine(job)}\nLast output:\n${output}`;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function groupAlive(entry: Entry): boolean {
  return Boolean(
    entry.pid &&
    (process.platform === 'win32' ? !entry.shellExited : alive(-entry.pid)),
  );
}
async function kill(entry: Entry, force: boolean): Promise<void> {
  if (!entry.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) =>
      execFile('taskkill', ['/PID', String(entry.pid), '/T', '/F'], () =>
        resolve(),
      ),
    );
  } else {
    try {
      process.kill(-entry.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      /* Already gone. */
    }
  }
}

/** One application's jobs. Reopening a conversation never replays a command. */
export class JobRegistry {
  private entries = new Set<Entry>();
  private jobs = new Map<string, Entry>();
  private notices = new Map<string, Job[]>();
  private changes = new EventEmitter();
  private next = 1;
  private endSequence = 0;
  private ended: { sequence: number; job: Job }[] = [];
  private run = 0;
  private closed = false;
  private monitor: NodeJS.Timeout;
  readonly folder: string;
  readonly runName = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  constructor(
    readonly sandbox: Sandbox,
    private notify: (
      event: 'job_started' | 'job_updated' | 'job_ended',
      job: Job,
    ) => void = () => {},
    readonly maxRunning = 16,
    readonly outputLimit = JobRegistry.outputLimit(),
  ) {
    if (!sandbox.offloadRoot)
      throw new Error('background jobs need a data folder');
    const root = join(sandbox.offloadRoot, 'background_jobs');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root)) {
      const match = /^(\d+)-(\d+)-[a-z0-9]+$/.exec(name);
      if (
        match &&
        Date.now() - Number(match[2]) > 86_400_000 &&
        !alive(Number(match[1]))
      )
        rmSync(join(root, name), { recursive: true, force: true });
    }
    this.folder = join(root, this.runName);
    mkdirSync(this.folder, { mode: 0o700 });
    this.monitor = setInterval(() => this.tick(), 100);
    this.monitor.unref();
  }
  static outputLimit(): number {
    const value = Number(process.env.CIRCLE_JOB_OUTPUT_LIMIT_MB);
    return (Number.isFinite(value) && value > 0 ? value : 1024) * 1024 * 1024;
  }
  private tick(): void {
    for (const entry of this.entries) {
      if (entry.finished) continue;
      if (!entry.stopPromise) {
        let size = 0;
        try {
          size = statSync(entry.path).size;
        } catch {
          void this.stopEntry(entry, 'output unavailable');
          continue;
        }
        if (size > this.outputLimit) void this.stopEntry(entry, 'output limit');
        else if (entry.deadline && Date.now() >= entry.deadline)
          void this.stopEntry(entry, 'timeout');
        else if (entry.shellExited && !groupAlive(entry)) this.finish(entry);
      }
    }
  }
  private checkCapacity(kind: Job['kind']): void {
    if (this.closed) throw new Error('background jobs are closed');
    const count = this.list().filter(
      (job) =>
        job.status === 'running' &&
        (kind === 'agent' ? job.kind === 'agent' : job.kind !== 'agent'),
    ).length;
    const limit = kind === 'agent' ? 4 : this.maxRunning;
    if (count >= limit)
      throw new Error(
        `${limit} background ${kind === 'agent' ? 'subagents' : 'jobs'} are already running`,
      );
  }
  private entry(command: string, owner: JobOwner): Entry {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const path = join(this.folder, `run-${++this.run}.log`);
    writeFileSync(path, '', { mode: 0o600 });
    const entry: Entry = {
      command,
      started: Date.now(),
      owner,
      path,
      controller: new AbortController(),
      settled,
      settle,
      finished: false,
    };
    this.entries.add(entry);
    return entry;
  }
  private publish(entry: Entry, kind: Job['kind'], detail?: string): Job {
    if (entry.job) return entry.job;
    const id = `j${this.next++}`;
    // Do not rename an open output file: Windows and child-inherited file handles
    // must keep writing to the exact same inode after foreground promotion.
    const job: Job = {
      ...entry.owner,
      id,
      kind,
      title: entry.command.replace(/\s+/g, ' ').slice(0, 160),
      status: 'running',
      reason: '',
      started: entry.started,
      outputPath: entry.path,
      virtualPath: `/background_jobs/${this.runName}/${entry.path.split(/[\\/]/).at(-1)}`,
      ...(detail ? { detail } : {}),
    };
    entry.job = job;
    this.jobs.set(id, entry);
    this.emit('job_started', job);
    return job;
  }
  private emit(
    event: 'job_started' | 'job_updated' | 'job_ended',
    job: Job,
  ): void {
    this.changes.emit('change');
    try {
      this.notify(event, { ...job });
    } catch {
      /* UI must not own process lifetime. */
    }
  }
  private finish(entry: Entry): void {
    if (entry.finished) return;
    entry.finished = true;
    this.entries.delete(entry);
    const job = entry.job;
    if (job) {
      job.ended = Date.now();
      job.reason = entry.reason ?? 'exit';
      job.exitCode = entry.exitCode;
      job.status = [
        'user',
        'model',
        'exit',
        'parent ended',
        'cancelled',
      ].includes(entry.reason ?? '')
        ? 'stopped'
        : entry.reason || (entry.exitCode !== undefined && entry.exitCode !== 0)
          ? 'failed'
          : 'done';
      const queue = this.notices.get(job.sessionId) ?? [];
      this.ended.push({ sequence: ++this.endSequence, job: { ...job } });
      if (this.ended.length > 1024) this.ended.shift();
      queue.push({ ...job });
      this.notices.set(job.sessionId, queue);
      this.emit('job_ended', job);
    }
    entry.settle();
    this.changes.emit('change');
  }
  private launch(command: string, owner: JobOwner): Entry {
    const verdict = classifyCommand(command, this.sandbox.credentialFiles);
    if (verdict.verdict === 'DENY')
      throw new Error(verdict.message || verdict.reason);
    const entry = this.entry(command, owner);
    const fd = openSync(entry.path, 'a', 0o600);
    try {
      const child = spawn(command, {
        cwd: this.sandbox.workspace,
        env: shellEnvironment(),
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', fd, fd],
      });
      entry.child = child;
      entry.pid = child.pid;
      child.once('error', (error) => {
        writeFileSync(entry.path, redact(error.message), { flag: 'a' });
        entry.reason = 'spawn error';
        this.finish(entry);
      });
      child.once('exit', (code) => {
        entry.shellExited = true;
        entry.exitCode = code ?? 130;
        if (!groupAlive(entry)) this.finish(entry);
        else if (!entry.job && !entry.stopPromise) {
          this.publish(entry, 'adopted', 'left running');
          entry.interrupt?.();
        }
      });
    } finally {
      closeSync(fd);
    }
    return entry;
  }
  startShell(command: string, owner: JobOwner, timeout?: number): Job {
    this.checkCapacity('shell');
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) || timeout < 0 || timeout > 86_400)
    )
      throw new Error('background timeout must be between 0 and 86400 seconds');
    const entry = this.launch(command, owner);
    if (timeout) entry.deadline = Date.now() + timeout * 1000;
    return this.publish(entry, 'shell');
  }
  async execute(
    command: string,
    owner: JobOwner,
    signal: AbortSignal,
    timeout?: number,
    defaultTimeout = 120_000,
  ): Promise<ExecuteResult> {
    if (this.closed) throw new Error('background jobs are closed');
    if (
      timeout !== undefined &&
      (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600)
    )
      throw new Error(
        'foreground timeout must be positive and at most 600 seconds',
      );
    signal.throwIfAborted();
    const entry = this.launch(command, owner);
    const sequence = this.endSequence;
    let awakened: Job[] = [];
    const sleeping = /^\s*sleep\s+\d+(?:\.\d+)?[smhd]?\s*$/.test(command);
    const wake = (): void => {
      if (!sleeping || entry.job || entry.finished || entry.stopPromise) return;
      awakened = this.ended
        .filter(
          (notice) =>
            notice.sequence > sequence &&
            notice.job.sessionId === owner.sessionId,
        )
        .map((notice) => notice.job);
      if (awakened.length) void this.stopEntry(entry, 'background job ended');
    };
    if (sleeping) this.changes.on('change', wake);
    let release!: () => void;
    const promoted = new Promise<void>((resolve) => {
      release = resolve;
    });
    entry.interrupt = release;
    const promote = (): void => {
      if (!entry.finished && !entry.stopPromise) {
        this.publish(entry, 'shell', 'moved to background');
        release();
      }
    };
    const timer = setTimeout(
      () => {
        if (timeout === undefined) promote();
        else void this.stopEntry(entry, 'timeout');
      },
      timeout === undefined ? defaultTimeout : timeout * 1000,
    );
    const cancel = (): void => {
      void this.stopEntry(entry, 'cancelled');
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await Promise.race([entry.settled, promoted]);
      if (signal.aborted) {
        await this.stopEntry(entry, 'cancelled');
        signal.throwIfAborted();
      }
      if (entry.job)
        return {
          job: { ...entry.job },
          how: entry.job.kind === 'adopted' ? 'adopted' : 'moved',
          output: `Command continues in background: ${jobLine(entry.job)}. A notice will arrive when it ends; do not poll or sleep.`,
        };
      const fd = openSync(entry.path, 'r');
      try {
        const size = statSync(entry.path).size;
        const data = Buffer.alloc(Math.min(size, 80_000));
        readSync(fd, data, 0, data.length, 0);
        return {
          output:
            (awakened.length
              ? `Stopped waiting because background jobs ended: ${awakened.map((job) => `${job.id} ${job.status}`).join(', ')}. Their notices reach the next model request.`
              : data.toString('utf8')) +
            (size > data.length
              ? `\nOutput continues in /background_jobs/${this.runName}/${entry.path.split(/[\\/]/).at(-1)}`
              : '') +
            (entry.reason ? `\nCommand ended: ${entry.reason}` : ''),
          exit_code: awakened.length ? 0 : (entry.exitCode ?? 130),
        };
      } finally {
        closeSync(fd);
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      entry.interrupt = undefined;
      if (sleeping) this.changes.off('change', wake);
    }
  }
  backgroundForeground(): number {
    let count = 0;
    for (const entry of this.entries)
      if (entry.child && !entry.job && !entry.stopPromise) {
        this.publish(entry, 'shell', 'moved to background');
        entry.interrupt?.();
        count++;
      }
    return count;
  }
  startAgent(
    title: string,
    owner: JobOwner,
    run: (
      signal: AbortSignal,
      log: (text: string) => void,
      job: Job,
    ) => Promise<string>,
  ): Job {
    this.checkCapacity('agent');
    const entry = this.entry(title, owner);
    const job = this.publish(entry, 'agent');
    const log = (text: string): void => {
      if (!entry.finished) {
        writeFileSync(entry.path, redact(text) + '\n', { flag: 'a' });
        job.detail = redact(text).split('\n').at(-1)?.slice(0, 200);
        this.emit('job_updated', job);
      }
    };
    void Promise.resolve()
      .then(async () => {
        entry.controller.signal.throwIfAborted();
        log(await run(entry.controller.signal, log, job));
      })
      .catch((error: unknown) => {
        if (!entry.controller.signal.aborted) {
          entry.reason = 'agent error';
          log(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(async () => {
        await this.stopOwned(job.id);
        this.finish(entry);
      });
    return { ...job };
  }
  startWatch(watch: Watch, owner: JobOwner, source = ''): Job {
    this.checkCapacity('watch');
    const entry = this.entry(watch.title, owner);
    entry.watch = watch;
    entry.deadline = Date.now() + watch.deadline;
    const job = this.publish(entry, 'watch');
    job.source = source;
    void pollWatch(watch, entry.controller.signal)
      .then((result) => {
        if (!entry.controller.signal.aborted && !entry.finished) {
          const text =
            typeof result === 'string' ? result : JSON.stringify(result);
          writeFileSync(entry.path, redact(text) + '\n', { flag: 'a' });
        }
      })
      .catch((error: unknown) => {
        if (!entry.controller.signal.aborted) {
          entry.reason = 'watch error';
          writeFileSync(
            entry.path,
            redact(error instanceof Error ? error.message : String(error)) +
              '\n',
            { flag: 'a' },
          );
        }
      })
      .finally(() => {
        if (!entry.stopPromise) this.finish(entry);
      });
    return { ...job };
  }
  list(sessionId?: string): Job[] {
    return [...this.jobs.values()]
      .flatMap((entry) =>
        entry.job && (!sessionId || entry.job.sessionId === sessionId)
          ? [{ ...entry.job }]
          : [],
      )
      .sort(
        (a, b) =>
          Number(b.status === 'running') - Number(a.status === 'running') ||
          a.started - b.started,
      );
  }
  get(id: string): Job | undefined {
    const job = this.jobs.get(id)?.job;
    return job ? { ...job } : undefined;
  }
  activity(id: string, detail: string): void {
    const job = this.jobs.get(id)?.job;
    if (job?.status === 'running') {
      job.detail = detail;
      this.emit('job_updated', job);
    }
  }
  remove(id: string): void {
    const entry = this.jobs.get(id);
    if (entry && !entry.finished)
      throw new Error('stop the job before removing it');
    this.jobs.delete(id);
  }
  private async stopEntry(entry: Entry, reason: string): Promise<void> {
    if (entry.finished) return;
    if (entry.stopPromise) return entry.stopPromise;
    entry.reason = reason;
    entry.controller.abort(new Error('Interrupted'));
    entry.stopPromise = (async () => {
      if (entry.child) {
        await kill(entry, false);
        await Promise.race([entry.settled, delay(1000)]);
        await kill(entry, true);
        // Do not resolve a stop before the shell has exited. Output is file-backed,
        // so grandchildren cannot keep the parent's stdio pipes open indefinitely.
        if (!entry.shellExited)
          await new Promise<void>((resolve) =>
            entry.child!.once('close', () => resolve()),
          );
        this.finish(entry);
      } else if (entry.watch) {
        await stopWatch(entry.watch);
        this.finish(entry);
      } else await entry.settled;
    })();
    return entry.stopPromise;
  }
  async stop(id: string, reason = 'model'): Promise<void> {
    const entry = this.jobs.get(id);
    if (!entry) throw new Error(`there is no job ${id}`);
    await this.stopEntry(entry, reason);
  }
  async stopOwned(parent: string): Promise<void> {
    await Promise.all(
      [...this.entries]
        .filter((entry) => entry.owner.parent === parent)
        .map((entry) => this.stopEntry(entry, 'parent ended')),
    );
  }
  hasNotices(sessionId: string, wakeOnly = false): boolean {
    return (this.notices.get(sessionId) ?? []).some(
      (job) =>
        !wakeOnly ||
        (job.status !== 'stopped' && job.startedBy !== 'user' && !job.parent),
    );
  }
  takeNotices(sessionId: string, ids?: string[]): Message[] {
    const pending = this.notices.get(sessionId) ?? [];
    const taken = pending.filter((job) => !ids || ids.includes(job.id));
    this.notices.set(
      sessionId,
      pending.filter((job) => !taken.includes(job)),
    );
    if (!taken.length) return [];
    return [
      {
        id: randomUUID(),
        role: 'user',
        content: `<system-reminder data-source="circle-jobs">\n${taken.map(jobNotice).join('\n\n')}\n\nThis is a background-job notice.\n</system-reminder>`,
        display: taken
          .map(
            (job) =>
              `◆ ${job.id} ${job.status} · ${job.title} · ${elapsed(job)}`,
          )
          .join('\n'),
        internal: 'job_notice',
      },
    ];
  }
  async wait(
    ids: string[],
    timeout: number,
    signal: AbortSignal,
  ): Promise<Job[]> {
    const known = ids.filter((id) => this.jobs.has(id));
    if (!known.length) throw new Error('none of these jobs exist');
    const deadline = Date.now() + Math.max(1, Math.min(600, timeout)) * 1000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const jobs = known.map((id) => this.get(id)!).filter(Boolean);
      if (jobs.some((job) => job.status !== 'running')) return jobs;
      await delay(50, undefined, { signal });
    }
    return known.map((id) => this.get(id)!).filter(Boolean);
  }
  async close(): Promise<Job[]> {
    this.closed = true;
    const running = this.list().filter((job) => job.status === 'running');
    await Promise.all(
      [...this.entries].map((entry) => this.stopEntry(entry, 'exit')),
    );
    clearInterval(this.monitor);
    return running;
  }
}
