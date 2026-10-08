import { createInterface } from 'node:readline';
import type { AgentRuntime } from './runtime.js';
import { jsonEvent } from './headless.js';
import { loadCredentials } from './settings.js';
import { resolveEndpoint } from './probe.js';
import { toHtml } from './session_export.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
export interface RpcIO {
  input: Readable;
  write(text: string): void;
}
export async function runRpc(
  runtime: AgentRuntime,
  io: RpcIO = {
    input: process.stdin,
    write: (text) => {
      process.stdout.write(text);
    },
  },
): Promise<number> {
  const send = (record: unknown): void => {
    io.write(JSON.stringify(record) + '\n');
  };
  const off = runtime.bus.subscribe((event) => {
    const record = jsonEvent(event);
    if (record) send(record);
  });
  const input = createInterface({ input: io.input, terminal: false });
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
        response({ cancelled: false, sessionId: runtime.session.id });
      } else if (type === 'get_state')
        response({
          model: runtime.harness.model.model,
          thinkingLevel: runtime.thinkingLevel,
          isStreaming: runtime.harness.busy,
          sessionId: runtime.session.id,
          sessionName: runtime.store.get(runtime.session.id)?.title,
          messageCount: runtime.harness.messages.length,
          pendingMessageCount: runtime.harness.pendingMessageCount,
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
      else if (type === 'get_session_stats') {
        const stats = runtime.stats();
        const messages = runtime.harness.messages;
        response({
          sessionId: runtime.session.id,
          userMessages: messages.filter((message) => message.role === 'user')
            .length,
          assistantMessages: messages.filter(
            (message) => message.role === 'assistant',
          ).length,
          toolCalls: stats.toolCalls,
          toolResults: messages.filter((message) => message.role === 'tool')
            .length,
          totalMessages: stats.messages,
          tokens: {
            input: stats.usage.input_tokens,
            output: stats.usage.output_tokens,
            total: stats.usage.input_tokens + stats.usage.output_tokens,
          },
        });
      } else if (type === 'get_available_models') {
        const settings = runtime.options.settings;
        const credentials = loadCredentials(runtime.options.home);
        const discovered = await resolveEndpoint(
          settings.auth.base_url,
          credentials[settings.auth.api_key_ref] || '',
          { protocol: settings.auth.protocol },
        );
        if (discovered.status === 'failed') throw new Error(discovered.detail);
        response({ models: discovered.models });
      } else if (type === 'set_model') {
        runtime.setModel(String(command.modelId || command.model || ''));
        response({ model: runtime.harness.model.model });
      } else if (type === 'set_thinking_level') {
        runtime.setThinkingLevel(String(command.level || ''));
        response({ level: runtime.thinkingLevel });
      } else if (type === 'export_html') {
        const session = runtime.store.get(runtime.session.id)!;
        const path = resolve(
          runtime.options.workspace,
          String(command.outputPath || session.id + '.html'),
        );
        writeFileSync(
          path,
          toHtml(runtime.harness.messages, {
            thread_id: session.id,
            title: session.title,
            workspace: session.workspace,
            model: runtime.harness.model.model,
          }),
        );
        response({ path });
      } else if (type === 'set_session_name') {
        const name = String(command.name || '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!name) throw new Error('name is required');
        runtime.store.rename(runtime.session.id, name);
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
