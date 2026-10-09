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
export async function runPrint(
  runtime: AgentRuntime,
  prompts: string[],
  options: { json?: boolean; verbose?: boolean; waitJobs?: boolean } = {},
): Promise<number> {
  const off = runtime.bus.subscribe((event) => {
    const record = jsonEvent(event);
    if (options.json && record)
      process.stdout.write(JSON.stringify(record) + '\n');
    else if (options.verbose && event.kind === 'tool_call')
      process.stderr.write(
        `${event.payload.name}(${JSON.stringify(event.payload.args)})\n`,
      );
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
  try {
    for (const prompt of prompts) {
      const result = await runtime.harness.run(prompt);
      if (!options.json) process.stdout.write(result.answer + '\n');
    }
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
          const answer = await runtime.runJobNotices();
          if (answer !== undefined && !options.json)
            process.stdout.write(answer + '\n');
        } else if (
          !runtime.jobs
            .list(runtime.session.id)
            .some((job) => job.status === 'running' && job.startedBy !== 'user')
        )
          break;
        else await delay(50, undefined, { signal: waiting.signal });
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✖ ${message}\n`);
    return waiting.signal.aborted || message === 'Interrupted' ? 130 : 1;
  } finally {
    off();
    process.off('SIGINT', cancel);
  }
}
export async function runLine(runtime: AgentRuntime): Promise<number> {
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
        code = await runPrint(runtime, [line], { waitJobs: false });
    }
  } finally {
    off();
    input.close();
    process.off('SIGINT', interrupt);
  }
  return code;
}
