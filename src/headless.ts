import { createInterface } from 'node:readline';
import type { AgentRuntime } from './runtime.js';
import type { CircleEvent } from './events.js';
import { setTimeout as delay } from 'node:timers/promises';
import { rpcJob } from './rpc_codec.js';
export function jsonEvent(
  event: CircleEvent,
): Record<string, unknown> | undefined {
  const data = event.payload;
  if (event.kind === 'compaction') return { type: 'compaction', ...data };
  if (['job_started', 'job_updated', 'job_ended'].includes(event.kind))
    return {
      type: 'job',
      event: event.kind.slice(4),
      job: rpcJob(data.job as import('./jobs.js').Job),
    };
  if (event.tags.subagent)
    return {
      type: 'subagent_event',
      event: event.kind,
      ...data,
      tags: event.tags,
      usage: event.usage,
    };
  if (event.kind === 'run_start')
    return { type: 'turn_start', message: data.message };
  if (event.kind === 'llm_end') {
    const message = data.message as {
      id: string;
      content: string;
      tool_calls?: unknown[];
    };
    return {
      type: 'assistant',
      id: message.id,
      text: message.content,
      tool_calls: message.tool_calls ?? [],
      usage: event.usage,
    };
  }
  if (event.kind === 'tool_result') return { type: 'tool_result', ...data };
  if (event.kind === 'tool_waiting')
    return {
      type: 'not_run',
      name: data.name,
      args: data.args,
      reason: data.reason,
    };
  if (event.kind === 'run_end')
    return { type: 'turn_end', answer: data.answer, usage: event.usage };
  if (event.kind === 'run_error')
    return { type: 'error', message: data.message };
  if (event.kind === 'steer') return { type: 'steer', message: data.message };
  return undefined;
}
// Tool rows for --verbose, as the Python releases wrote them: a short name and one phrase.
const SHORT_NAMES: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  apply_patch: 'Patch',
  delete: 'Delete',
  ls: 'Ls',
  glob: 'Glob',
  grep: 'Grep',
  execute: 'Bash',
  task: 'Agent',
  write_todos: 'TodoWrite',
  webfetch: 'Fetch',
  websearch: 'Search',
  question: 'Question',
  skill: 'Skill',
  lsp: 'Lsp',
  compact_conversation: 'Compact',
  list_jobs: 'Jobs',
  stop_job: 'StopJob',
  wait_jobs: 'WaitJobs',
};
type Style = 'path_tail' | 'first_line' | 'patch_target' | 'text';
const ARG_SUMMARY: Record<string, [string, Style][]> = {
  read_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  write_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  edit_file: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  delete: [
    ['file_path', 'path_tail'],
    ['path', 'path_tail'],
  ],
  apply_patch: [['patchText', 'patch_target']],
  ls: [['path', 'path_tail']],
  glob: [['pattern', 'text']],
  grep: [['pattern', 'text']],
  execute: [['command', 'first_line']],
  task: [
    ['description', 'first_line'],
    ['subagent_type', 'text'],
  ],
  webfetch: [['url', 'text']],
  websearch: [['query', 'text']],
  question: [['questions', 'first_line']],
  skill: [
    ['name', 'text'],
    ['skill', 'text'],
  ],
  lsp: [
    ['operation', 'text'],
    ['file_path', 'path_tail'],
  ],
  stop_job: [['job_id', 'text']],
};
function clip(text: string, width = 60): string {
  const chars = Array.from(text.split(/\s+/).filter(Boolean).join(' '));
  return chars.length > width
    ? chars.slice(0, width - 1).join('') + '…'
    : chars.join('');
}
function summarize(style: Style, value: unknown): string {
  if (value === null || value === undefined || typeof value === 'object')
    return '';
  const text = String(value).trim();
  if (!text) return '';
  if (style === 'path_tail') {
    const parts = text.replaceAll('\\', '/').split('/').filter(Boolean);
    const tail = parts.length > 2 ? parts.slice(-2).join('/') : text;
    return clip(tail === text ? tail : `…/${tail}`);
  }
  if (style === 'first_line') return clip(text.split(/\r?\n/)[0] ?? '');
  if (style === 'patch_target') {
    const match = text.match(/\*\*\* (?:Add|Update|Delete) File:\s*(\S+)/);
    return match ? summarize('path_tail', match[1]) : '';
  }
  return clip(text);
}
export function toolCallLine(name: string, args: unknown): string {
  const values = (
    args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  ) as Record<string, unknown>;
  const short = SHORT_NAMES[name] ?? name;
  return `${short}(${argSummary(name, values)})`;
}
function argSummary(name: string, values: Record<string, unknown>): string {
  if (name === 'execute') {
    const command = typeof values.command === 'string' ? values.command : '';
    const lines = command.split(/\r?\n/);
    const first = lines[0] ?? '';
    if (first.includes('<<')) {
      const head = first.split('<<')[0]!.trim();
      const comment = lines
        .slice(1)
        .map((line) => line.trim())
        .find((line) => line.startsWith('#'));
      return clip(
        `${head} · ${comment?.replace(/^#+/, '').trim() || 'multiline script'}`,
      );
    }
    return clip(first);
  }
  if (name === 'question') {
    const asked = values.questions;
    return Array.isArray(asked) && asked[0] && typeof asked[0] === 'object'
      ? summarize('first_line', (asked[0] as { question?: unknown }).question)
      : '';
  }
  const table = ARG_SUMMARY[name];
  if (table) {
    for (const [key, style] of table) {
      const shown = summarize(style, values[key]);
      if (shown) return shown;
    }
    return '';
  }
  const { kind, name: named, batch, autoid } = values;
  if (typeof kind === 'string' && kind && typeof named === 'string' && named)
    return clip(`kind=${kind}, name='${named}'`);
  if (
    typeof batch === 'string' &&
    batch &&
    autoid !== undefined &&
    autoid !== null &&
    autoid !== ''
  )
    return clip(`${batch} · ${String(autoid)}`);
  for (const key of [
    'file_path',
    'path',
    'name',
    'batch',
    'autoid',
    'query',
    'pattern',
  ]) {
    const value = values[key];
    if (typeof value === 'string' && value)
      return summarize(
        key === 'file_path' || key === 'path' ? 'path_tail' : 'text',
        value,
      );
  }
  for (const value of Object.values(values)) {
    const shown = summarize('text', value);
    if (shown) return shown;
  }
  return '';
}
const short = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
// What print and line mode write to standard error: with --verbose each tool call, calls not
// run, failed tool results and retries; at the end the tokens used, which is also written
// when calls were not run.
export class HeadlessProgress {
  tokensIn = 0;
  tokensOut = 0;
  notRun = 0;
  private calls = new Map<string, { name: string; args: unknown }>();
  constructor(
    readonly verbose = false,
    readonly yolo = false,
    private write: (line: string) => void = (line) =>
      process.stderr.write(line + '\n'),
  ) {}
  private say(line: string): void {
    if (this.verbose) this.write(line);
  }
  event(event: CircleEvent): void {
    const data = event.payload;
    const subagent = event.tags.subagent ? String(event.tags.subagent) : '';
    const key = `${subagent}:${String(data.id ?? '')}`;
    if (event.kind === 'llm_end' && !subagent) {
      this.tokensIn += Number(event.usage?.input_tokens ?? 0) || 0;
      this.tokensOut += Number(event.usage?.output_tokens ?? 0) || 0;
    } else if (event.kind === 'tool_call') {
      const call = { name: String(data.name ?? ''), args: data.args };
      this.calls.set(key, call);
      if (!subagent) this.say(`● ${toolCallLine(call.name, call.args)}`);
    } else if (event.kind === 'tool_result' && data.status === 'error') {
      const output = String(data.output ?? '').trim();
      const call = this.calls.get(key) ?? {
        name: String(data.name ?? ''),
        args: {},
      };
      if (output.startsWith('not run: ')) {
        this.notRun++;
        const job = event.tags.job_id ? `${String(event.tags.job_id)} · ` : '';
        const reason = output.includes('always asks')
          ? 'always asks'
          : 'needs --yolo';
        this.say(
          `  ⎿ ${job}${toolCallLine(call.name, call.args)} not run · ${reason}`,
        );
      } else if (!subagent) {
        const first = output.split('\n')[0];
        this.say(
          `  ⎿ ${first ? Array.from(first).slice(0, 100).join('') : 'failed'}`,
        );
      }
    } else if (event.kind === 'info' && !subagent && data.model_notice) {
      const notice = data.model_notice as Record<string, unknown>;
      if (notice.event === 'retry')
        this.say(
          `  … ${String(notice.kind)} error, retry ${String(notice.attempt)}/${String(notice.max)} in ${(Math.round(Number(notice.wait_ms) / 100) / 10).toFixed(1)}s`,
        );
      else if (notice.event === 'param_dropped')
        this.say(
          `  … the endpoint rejected ${String(notice.param)}; sent again without it`,
        );
    }
  }
  summary(): string {
    const parts = [`↑ ${short(this.tokensIn)} · ↓ ${short(this.tokensOut)}`];
    if (this.notRun)
      parts.push(
        `${this.notRun} ${this.notRun === 1 ? 'call' : 'calls'} not run${this.yolo ? '' : ' (use --yolo to allow commands and edits)'}`,
      );
    return parts.join(' · ');
  }
  finish(): void {
    if (this.verbose || this.notRun) this.write(this.summary());
  }
}
export interface HeadlessOptions {
  json?: boolean;
  verbose?: boolean;
  yolo?: boolean;
  waitJobs?: boolean;
  progress?: HeadlessProgress;
}
// `circle -p`: one turn for each prompt; only the last answer goes to standard output.
export async function runPrint(
  runtime: AgentRuntime,
  prompts: string[],
  options: HeadlessOptions = {},
): Promise<number> {
  const progress =
    options.progress ?? new HeadlessProgress(options.verbose, options.yolo);
  const off = runtime.bus.subscribe((event) => {
    const record = jsonEvent(event);
    if (options.json && record)
      process.stdout.write(JSON.stringify(record) + '\n');
    progress.event(event);
  });
  const waiting = new AbortController();
  const cancel = (): void => {
    waiting.abort(new Error('Interrupted'));
    void runtime.cancel();
  };
  process.on('SIGINT', cancel);
  if (options.json)
    process.stdout.write(
      JSON.stringify({
        type: 'session',
        id: runtime.session.id,
        workspace: runtime.session.workspace,
        model: runtime.harness.model.model,
      }) + '\n',
    );
  let answer = '';
  try {
    for (const prompt of prompts)
      answer = (await runtime.harness.run(prompt)).answer;
    if (options.waitJobs !== false) {
      for (const job of runtime.jobs
        .list()
        .filter((job) => job.kind === 'adopted' && job.status === 'running'))
        await runtime.jobs.stop(job.id, 'exit');
      const configured = Number(process.env.CIRCLE_JOB_WAIT ?? 1800);
      const deadline =
        Date.now() +
        (Number.isFinite(configured) && configured >= 0 ? configured : 1800) *
          1000;
      let wakes = 0;
      while (Date.now() < deadline) {
        waiting.signal.throwIfAborted();
        if (runtime.jobs.hasNotices(runtime.session.id, true)) {
          if (wakes++ >= 10) break;
          await delay(1000, undefined, { signal: waiting.signal });
          const later = await runtime.runJobNotices();
          if (later !== undefined) answer = later;
        } else if (
          !runtime.jobs
            .list(runtime.session.id)
            .some((job) => job.status === 'running' && job.startedBy !== 'user')
        )
          break;
        else await delay(50, undefined, { signal: waiting.signal });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✖ ${message}\n`);
    return waiting.signal.aborted || message === 'Interrupted' ? 130 : 1;
  } finally {
    off();
    process.off('SIGINT', cancel);
  }
  if (answer && !options.json) process.stdout.write(answer + '\n');
  if (!options.progress) progress.finish();
  return answer ? 0 : 1;
}
// Line mode: one prompt per line of standard input, all in one conversation.
export async function runLine(
  runtime: AgentRuntime,
  options: { verbose?: boolean; yolo?: boolean } = {},
): Promise<number> {
  const progress = new HeadlessProgress(options.verbose, options.yolo);
  const input = createInterface({ input: process.stdin, terminal: false });
  let code = 0;
  const interrupt = (): void => {
    code = 130;
    input.close();
    void runtime.cancel();
  };
  process.on('SIGINT', interrupt);
  const off = runtime.bus.subscribe((event) => {
    if (event.kind === 'job_ended')
      process.stderr.write(
        `Background job ${String((event.payload.job as { id: string }).id)} ended.\n`,
      );
  });
  try {
    for await (const line of input) {
      if (['/exit', '/quit', '/q'].includes(line.trim())) break;
      if (line.trim() === '/help') {
        process.stdout.write('/help · /exit\n');
        continue;
      }
      if (/^\/[A-Za-z-]+(?:\s|$)/.test(line)) {
        process.stderr.write(
          'This command works in the full-screen interface only.\n',
        );
        continue;
      }
      if (line.trim())
        code = await runPrint(runtime, [line], { waitJobs: false, progress });
    }
  } finally {
    off();
    input.close();
    process.off('SIGINT', interrupt);
  }
  progress.finish();
  return code;
}
