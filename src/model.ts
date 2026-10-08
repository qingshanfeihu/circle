import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatCompletionMessageParam,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions';
import type {
  ContentBlockParam,
  MessageParam,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  ChatModel,
  Message,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from './types.js';
import { emptyUsage } from './types.js';
import { loadCredentials, type CircleSettings } from './settings.js';
export const EFFORT_LEVELS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export class GatewayModel implements ChatModel {
  readonly model: string;
  private openai?: OpenAI;
  private anthropic?: Anthropic;
  effort: string;
  constructor(
    readonly settings: CircleSettings,
    home?: string,
    modelOverride?: string,
  ) {
    this.model = modelOverride || settings.auth.model;
    if (!this.model)
      throw new Error('no model name in settings; re-run circle --init');
    const credentials = loadCredentials(home);
    const apiKey =
      credentials[settings.auth.api_key_ref] || credentials.api_key;
    if (!apiKey) throw new Error('missing API key; re-run circle --init');
    const timeout = Math.max(
      5000,
      (Number(process.env.CIRCLE_LLM_TIMEOUT) || 45) * 1000,
    );
    const options = {
      apiKey,
      baseURL: settings.auth.base_url,
      timeout,
      maxRetries: 0,
    };
    if (settings.auth.protocol === 'anthropic')
      this.anthropic = new Anthropic(options);
    else this.openai = new OpenAI(options);
    this.effort =
      process.env.CIRCLE_REASONING_EFFORT ||
      settings.default_thinking ||
      (this.anthropic ? 'xhigh' : '');
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    return this.anthropic
      ? this.completeAnthropic(request)
      : this.completeOpenAI(request);
  }
  private async completeOpenAI(request: ModelRequest): Promise<ModelResponse> {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ];
    for (const message of request.messages) {
      if (message.role === 'tool')
        messages.push({
          role: 'tool',
          content: message.content,
          tool_call_id: message.tool_call_id!,
        });
      else if (message.role === 'assistant')
        messages.push({
          role: 'assistant',
          content: message.content || null,
          ...(message.tool_calls?.length
            ? {
                tool_calls: message.tool_calls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args),
                  },
                })),
              }
            : {}),
        });
      else messages.push({ role: 'user', content: message.content });
    }
    const body: ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools.length)
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    if (this.effort)
      body.reasoning_effort = this
        .effort as ChatCompletionCreateParamsStreaming['reasoning_effort'];
    const stream = await this.openai!.chat.completions.create(body, {
      signal: request.signal,
    });
    let content = '';
    let thinking = '';
    let finish = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const usage = emptyUsage();
    for await (const chunk of stream) {
      if (chunk.usage) {
        usage.input_tokens = chunk.usage.prompt_tokens;
        usage.output_tokens = chunk.usage.completion_tokens;
        usage.cache_read_tokens =
          chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta.content) {
        content += delta.content;
        request.token(delta.content);
      }
      const extra = delta as unknown as Record<string, unknown>;
      const reasoning = extra.reasoning_content ?? extra.reasoning;
      if (typeof reasoning === 'string') {
        thinking += reasoning;
        request.token(reasoning, true);
      }
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: '', name: '', args: '' };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.name += part.function.name;
        if (part.function?.arguments) call.args += part.function.arguments;
        calls.set(part.index, call);
      }
    }
    request.signal.throwIfAborted();
    if (!finish || finish === 'length')
      throw new Error(
        `model stream did not complete (${finish || 'missing finish_reason'})`,
      );
    const tool_calls: ToolCall[] = [...calls.values()].map((call) => {
      if (!call.id || !call.name) throw new Error('incomplete tool call');
      const args: unknown = JSON.parse(call.args || '{}');
      if (typeof args !== 'object' || args === null || Array.isArray(args))
        throw new Error('tool arguments must be an object');
      return {
        id: call.id,
        name: call.name,
        args: args as Record<string, unknown>,
      };
    });
    return {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        thinking,
        tool_calls,
      },
      usage,
    };
  }
  private async completeAnthropic(
    request: ModelRequest,
  ): Promise<ModelResponse> {
    const messages: MessageParam[] = [];
    for (const message of request.messages) {
      let role: 'user' | 'assistant';
      let content: ContentBlockParam[];
      if (message.role === 'tool') {
        role = 'user';
        content = [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id!,
            content: message.content,
            is_error: message.status === 'error',
          },
        ];
      } else if (message.role === 'assistant') {
        role = 'assistant';
        content = message.provider_content
          ? (message.provider_content as ContentBlockParam[])
          : [
              ...(message.content
                ? [{ type: 'text' as const, text: message.content }]
                : []),
              ...(message.tool_calls ?? []).map((call) => ({
                type: 'tool_use' as const,
                id: call.id,
                name: call.name,
                input: call.args,
              })),
            ];
      } else {
        role = 'user';
        content = [{ type: 'text', text: message.content }];
      }
      const previous = messages.at(-1);
      if (previous?.role === role && Array.isArray(previous.content))
        previous.content.push(...content);
      else messages.push({ role, content });
    }
    const body: MessageCreateParamsNonStreaming = {
      model: this.model,
      system: request.system,
      messages,
      max_tokens: 32000,
    };
    if (request.tools.length)
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: { ...tool.parameters, type: 'object' },
      }));
    if (this.effort) {
      body.thinking = { type: 'adaptive' };
      body.output_config = {
        effort: this.effort as NonNullable<
          MessageCreateParamsNonStreaming['output_config']
        >['effort'],
      };
    }
    const stream = this.anthropic!.messages.stream(body, {
      signal: request.signal,
    });
    stream.on('text', (text) => request.token(text));
    for await (const event of stream)
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'thinking_delta'
      )
        request.token(event.delta.thinking, true);
    const final = await stream.finalMessage();
    request.signal.throwIfAborted();
    if (final.stop_reason === 'max_tokens' || !final.stop_reason)
      throw new Error('model response did not complete');
    const tool_calls: ToolCall[] = [];
    let content = '';
    let thinking = '';
    for (const block of final.content) {
      if (block.type === 'text') content += block.text;
      else if (block.type === 'thinking') thinking += block.thinking;
      else if (block.type === 'tool_use')
        tool_calls.push({
          id: block.id,
          name: block.name,
          args: block.input as Record<string, unknown>,
        });
    }
    return {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content,
        thinking,
        tool_calls,
        provider_content: final.content,
      },
      usage: {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
        cache_read_tokens: final.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
