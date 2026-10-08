import { createInterface } from 'node:readline';
import type { AgentRuntime } from './runtime.js';
import type { CircleEvent } from './events.js';
export function jsonEvent(
  event: CircleEvent,
): Record<string, unknown> | undefined {
  const data = event.payload;
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
  options: { json?: boolean; verbose?: boolean } = {},
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
  const cancel = (): void => {
    void runtime.harness.cancel();
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
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`✖ ${message}\n`);
    return message === 'Interrupted' ? 130 : 1;
  } finally {
    off();
    process.off('SIGINT', cancel);
  }
}
export async function runLine(runtime: AgentRuntime): Promise<number> {
  const input = createInterface({ input: process.stdin, terminal: false });
  let code = 0;
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
    if (line.trim()) code = await runPrint(runtime, [line]);
  }
  return code;
}
