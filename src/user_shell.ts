import { randomUUID } from 'node:crypto';
import type { JobRegistry, Job, ExecuteResult } from './jobs.js';
import { outputTail } from './jobs.js';
import type { Message } from './types.js';
import type { CheckpointStore } from './checkpoint_store.js';
import { redact } from './redact.js';
export interface UserShellView {
  id: string;
  sessionId: string;
  anchor?: string;
  persistedMessageId?: string;
  command: string;
  quiet: boolean;
  output: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'background';
  exitCode?: number;
  jobId?: string;
}
export class UserShells {
  readonly views: UserShellView[] = [];
  private active?: Promise<ExecuteResult>;
  private controller?: AbortController;
  private jobs = new Map<string, UserShellView>();
  private pending: { sessionId: string; message: Message }[] = [];
  constructor(
    private registry: JobRegistry,
    private store: CheckpointStore,
    private hooks: {
      sessionId(): string;
      busy(): boolean;
      modelBusy(): boolean;
      planMode(): boolean;
      changed(): void;
    },
  ) {}
  get busy(): boolean {
    return Boolean(this.active);
  }
  private share(view: UserShellView): void {
    if (
      view.quiet ||
      view.status === 'stopped' ||
      !this.store.get(view.sessionId)
    )
      return;
    const message: Message = {
      id: randomUUID(),
      role: 'user',
      content: `I ran this command myself:\n$ ${view.command}\n${view.output}`,
      display: '!' + view.command,
      shell: {
        command: view.command,
        output: view.output,
        exit_code: view.exitCode ?? 130,
      },
    };
    view.persistedMessageId = message.id;
    this.pending.push({ sessionId: view.sessionId, message });
    if (!this.hooks.modelBusy()) this.flush();
  }
  flush(): void {
    for (const item of this.pending.splice(0))
      if (this.store.get(item.sessionId)) {
        this.store.append(item.sessionId, [item.message]);
        if (!this.store.get(item.sessionId)!.title)
          this.store.rename(item.sessionId, item.message.display!.slice(0, 60));
      }
  }
  async run(command: string, quiet = false): Promise<ExecuteResult> {
    if (this.hooks.busy() || this.busy)
      throw new Error('Busy · run it when the turn has finished');
    if (this.hooks.planMode())
      throw new Error(
        'Plan mode is active: shell execute is blocked. Use /plan off.',
      );
    if (!command.trim())
      throw new Error('!command shares output · !!command keeps it to you');
    const sessionId = this.hooks.sessionId();
    const view: UserShellView = {
      id: randomUUID(),
      sessionId,
      anchor: this.store
        .messages(sessionId)
        .filter(
          (message) => !message.internal || message.internal === 'job_notice',
        )
        .at(-1)?.id,
      command: command.trim(),
      quiet,
      output: '',
      status: 'running',
    };
    this.views.push(view);
    const controller = (this.controller = new AbortController());
    // Defer launch until active ownership is visible to cancellation and model guards.
    const active = (this.active = Promise.resolve().then(() =>
      this.registry.execute(
        view.command,
        { sessionId, startedBy: 'user' },
        controller.signal,
      ),
    ));
    this.hooks.changed();
    try {
      const result = await active;
      view.output = redact(result.output);
      view.exitCode = result.exit_code;
      if (result.job && result.exit_code === undefined) {
        view.status = 'background';
        view.jobId = result.job.id;
        this.jobs.set(result.job.id, view);
        const latest = this.registry.get(result.job.id);
        if (latest && latest.status !== 'running') this.ended(latest);
      } else {
        view.status = result.exit_code === 0 ? 'done' : 'error';
        if (!controller.signal.aborted) this.share(view);
      }
      return result;
    } catch (error) {
      view.status = controller.signal.aborted ? 'stopped' : 'error';
      view.output = redact(
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      this.active = undefined;
      this.controller = undefined;
      this.hooks.changed();
    }
  }
  ended(job: Job): void {
    const view = this.jobs.get(job.id);
    if (!view) return;
    this.jobs.delete(job.id);
    // User jobs do not wake a model turn. Quiet output must not become a later notice.
    this.registry.takeNotices(job.sessionId, [job.id]);
    view.status =
      job.status === 'done'
        ? 'done'
        : job.status === 'stopped'
          ? 'stopped'
          : 'error';
    view.exitCode = job.exitCode;
    try {
      view.output = redact(outputTail(job.outputPath, 80000, 2000));
      view.output += '\nFull output: ' + job.virtualPath;
    } catch {
      view.output = 'Output is unavailable.';
    }
    this.share(view);
    this.hooks.changed();
  }
  async cancel(): Promise<void> {
    this.controller?.abort(new Error('Interrupted'));
    await this.active?.catch(() => {});
  }
}
