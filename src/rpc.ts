import { createInterface } from 'node:readline';
import type { AgentRuntime } from './runtime.js';
import { jsonEvent } from './headless.js';
import { emptyUsage } from './types.js';
export async function runRpc(runtime: AgentRuntime): Promise<number> {
  const send = (record: unknown): void => {
    process.stdout.write(JSON.stringify(record) + '\n');
  };
  const off = runtime.bus.subscribe((event) => {
    const record = jsonEvent(event);
    if (record) send(record);
  });
  const input = createInterface({ input: process.stdin, terminal: false });
  let running: Promise<void> | undefined;
  for await (const line of input) {
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(line);
      if (!command || typeof command !== 'object' || Array.isArray(command))
        throw new Error('not an object');
    } catch {
      send({
        type: 'response',
        command: 'parse',
        success: false,
        error: 'invalid JSON command',
      });
      continue;
    }
    const type = String(command.type || '');
    const response = (data?: unknown): void =>
      send({
        type: 'response',
        command: type,
        success: true,
        ...(command.id !== undefined ? { id: command.id } : {}),
        ...(data !== undefined ? { data } : {}),
      });
    try {
      if (['prompt', 'steer', 'follow_up'].includes(type)) {
        if (typeof command.message !== 'string' || !command.message.trim())
          throw new Error('message is required');
        if (runtime.harness.busy) {
          const mode =
            type === 'steer'
              ? 'steer'
              : type === 'follow_up'
                ? 'followUp'
                : command.streamingBehavior;
          if (mode !== 'steer' && mode !== 'followUp')
            throw new Error('streamingBehavior must be steer or followUp');
          runtime.harness.queue(command.message, mode);
          response({ disposition: 'queued' });
        } else {
          response({ disposition: 'started' });
          running = runtime.harness
            .run(command.message)
            .then(
              () => {},
              () => {},
            )
            .finally(() => send({ type: 'agent_settled' }));
        }
      } else if (type === 'abort') {
        await runtime.harness.cancel();
        response();
      } else if (type === 'clear_queue') response(runtime.harness.clearQueue());
      else if (type === 'new_session') {
        await runtime.newSession();
        response({ sessionId: runtime.session.id });
      } else if (type === 'get_state')
        response({
          model: runtime.harness.model.model,
          thinkingLevel: runtime.options.settings.default_thinking,
          isStreaming: runtime.harness.busy,
          sessionId: runtime.session.id,
          sessionName: runtime.store.get(runtime.session.id)?.title,
          messageCount: runtime.harness.messages.length,
        });
      else if (type === 'get_messages')
        response({ messages: runtime.harness.messages });
      else if (type === 'get_last_assistant_text')
        response({
          text:
            runtime.harness.messages
              .filter((message) => message.role === 'assistant')
              .at(-1)?.content || '',
        });
      else if (type === 'get_session_stats')
        response({
          messages: runtime.harness.messages.length,
          toolCalls: runtime.harness.messages.reduce(
            (sum, message) => sum + (message.tool_calls?.length || 0),
            0,
          ),
          usage: emptyUsage(),
        });
      else if (type === 'set_session_name') {
        runtime.store.rename(runtime.session.id, String(command.name || ''));
        response();
      } else throw new Error(`unknown command: ${type}`);
    } catch (error) {
      send({
        type: 'response',
        command: type,
        success: false,
        ...(command.id !== undefined ? { id: command.id } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await running;
  off();
  return 0;
}
