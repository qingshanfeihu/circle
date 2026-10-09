import { createHash } from 'node:crypto';
import type { Message, ToolCall } from './types.js';
import { isRecord } from './settings.js';
import { isConstructor } from './legacy_codec.js';
import { inlineLegacyAttachments } from './media.js';
export interface LegacyMessage {
  type: string;
  data: Record<string, unknown>;
}
const TYPES: Record<string, string> = {
  HumanMessage: 'human',
  HumanMessageChunk: 'human',
  AIMessage: 'ai',
  AIMessageChunk: 'ai',
  ToolMessage: 'tool',
  ToolMessageChunk: 'tool',
  SystemMessage: 'system',
  SystemMessageChunk: 'system',
  RemoveMessage: 'remove',
};
export function legacyRecord(value: unknown): LegacyMessage {
  if (isConstructor(value)) {
    if (!isRecord(value.args))
      throw new Error('legacy message constructor has no keyword fields');
    const type = TYPES[value.name] || String(value.args.type || '');
    if (!type)
      throw new Error(
        `unsupported legacy message class: ${value.module}.${value.name}`,
      );
    return { type, data: value.args };
  }
  if (isRecord(value) && typeof value.type === 'string' && isRecord(value.data))
    return { type: value.type, data: value.data };
  if (isRecord(value) && typeof value.type === 'string')
    return { type: value.type, data: value };
  if (isRecord(value) && typeof value.role === 'string')
    return {
      type:
        value.role === 'user'
          ? 'human'
          : value.role === 'assistant'
            ? 'ai'
            : value.role,
      data: value,
    };
  throw new Error('invalid legacy message');
}
export function fromLegacyMessage(record: LegacyMessage, index = 0): Message {
  const { type, data } = record;
  const role =
    type === 'human' || type === 'user'
      ? 'user'
      : type === 'ai' || type === 'assistant'
        ? 'assistant'
        : type === 'tool'
          ? 'tool'
          : type === 'system'
            ? 'system'
            : null;
  if (!role) throw new Error(`unsupported legacy message type: ${type}`);
  const blocks = Array.isArray(data.content) ? data.content : [];
  if (typeof data.content !== 'string' && !Array.isArray(data.content))
    throw new Error('legacy message content is not text or blocks');
  const content =
    typeof data.content === 'string'
      ? data.content
      : blocks
          .filter(isRecord)
          .filter((block) => block.type === 'text')
          .map((block) => String(block.text || ''))
          .join('');
  const extra = isRecord(data.additional_kwargs) ? data.additional_kwargs : {};
  const attachments = ['user', 'tool'].includes(role)
    ? inlineLegacyAttachments(
        blocks,
        typeof extra.read_file_path === 'string'
          ? extra.read_file_path
          : 'attachment',
      )
    : [];
  const thinking =
    blocks
      .filter(isRecord)
      .filter((block) => ['thinking', 'reasoning'].includes(String(block.type)))
      .map((block) => String(block.thinking || block.reasoning || ''))
      .join('') ||
    (typeof extra.reasoning_content === 'string'
      ? extra.reasoning_content
      : '');
  const id =
    typeof data.id === 'string' && data.id
      ? data.id
      : 'legacy-' +
        index +
        '-' +
        createHash('sha256')
          .update(JSON.stringify(record))
          .digest('hex')
          .slice(0, 16);
  const calls: ToolCall[] = [];
  if (role === 'assistant' && Array.isArray(data.tool_calls))
    for (const call of data.tool_calls) {
      if (
        !isRecord(call) ||
        typeof call.id !== 'string' ||
        typeof call.name !== 'string' ||
        !isRecord(call.args)
      )
        throw new Error('invalid legacy tool call');
      calls.push({ id: call.id, name: call.name, args: call.args });
    }
  // The long pastes a message showed folded (0.5.0 kept them as circle_pastes, numbered
  // keys), so /fork and /tree put the paste back with the message.
  const pastes = isRecord(extra.circle_pastes)
    ? Object.fromEntries(
        Object.entries(extra.circle_pastes)
          .filter(([number]) => /^\d+$/.test(number))
          .map(([number, text]) => [String(Number(number)), String(text)]),
      )
    : {};
  const usage = isRecord(data.usage_metadata) ? data.usage_metadata : undefined;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  return {
    id,
    role,
    content,
    ...(isRecord(extra.circle_shell) &&
    typeof extra.circle_shell.command === 'string' &&
    typeof extra.circle_shell.output === 'string' &&
    typeof extra.circle_shell.exit_code === 'number'
      ? {
          shell: {
            command: extra.circle_shell.command,
            output: extra.circle_shell.output,
            exit_code: extra.circle_shell.exit_code,
          },
        }
      : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(thinking ? { thinking } : {}),
    ...(blocks.length ? { provider_content: blocks } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(typeof data.tool_call_id === 'string'
      ? { tool_call_id: data.tool_call_id }
      : {}),
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(role === 'tool'
      ? { status: data.status === 'error' ? 'error' : 'success' }
      : {}),
    ...(extra.circle_plan_reminder === true
      ? { internal: 'plan-reminder' }
      : extra.circle_loop_guard === true
        ? { internal: 'loop-guard' }
        : extra.circle_internal
          ? { internal: String(extra.circle_internal) }
          : extra.lc_source === 'summarization'
            ? { internal: 'summary' }
            : {}),
    ...(isRecord(extra.circle_shell)
      ? { display: '!' + String(extra.circle_shell.command || '') }
      : typeof extra.circle_shown === 'string'
        ? { display: extra.circle_shown }
        : {}),
    ...(Object.keys(pastes).length ? { pastes } : {}),
    ...(typeof input === 'number' && typeof output === 'number'
      ? {
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: isRecord(usage!.input_token_details)
              ? Number(usage!.input_token_details.cache_read || 0)
              : 0,
          },
        }
      : {}),
    legacy_data: { type, data },
  };
}
