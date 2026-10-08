import { randomUUID } from 'node:crypto';
import type { ChatModel, ModelRequest, ModelResponse } from './types.js';
import { emptyUsage } from './types.js';
export class ScriptedModel implements ChatModel {
  model = 'scripted';
  requests: Omit<ModelRequest, 'signal' | 'token'>[] = [];
  constructor(
    private replies: (
      | Partial<ModelResponse>
      | ((request: ModelRequest) => Promise<ModelResponse>)
    )[] = [],
  ) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal.throwIfAborted();
    this.requests.push(
      structuredClone({
        system: request.system,
        messages: request.messages,
        tools: request.tools.map(({ run: _run, ...tool }) => tool),
      }) as Omit<ModelRequest, 'signal' | 'token'>,
    );
    const reply = this.replies.shift();
    if (!reply) throw new Error('ScriptedModel has no response left');
    if (typeof reply === 'function') return reply(request);
    const message = reply.message ?? {
      id: randomUUID(),
      role: 'assistant' as const,
      content: '',
    };
    if (message.content) request.token(message.content);
    return { message, usage: reply.usage ?? emptyUsage() };
  }
}
