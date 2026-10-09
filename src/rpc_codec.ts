import type { Message } from './types.js';
import type { Job } from './jobs.js';
import { isRecord } from './settings.js';

/** Compatibility DTOs are data only; the runtime stores native messages. */
export function rpcMessage(message: Message): {
  type: string;
  data: Record<string, unknown>;
} {
  const type = {
    user: 'human',
    assistant: 'ai',
    tool: 'tool',
    system: 'system',
  }[message.role];
  const legacy = message.legacy_data?.data ?? {};
  const extra = structuredClone(
    isRecord(legacy.additional_kwargs) ? legacy.additional_kwargs : {},
  );
  if (message.thinking && !message.provider_content)
    extra.reasoning_content = message.thinking;
  if (message.internal) extra.circle_internal = message.internal;
  if (message.shell) extra.circle_shell = { ...message.shell };
  if (message.display !== undefined && message.display !== message.content)
    extra.circle_shown = message.display;
  let content: unknown = message.provider_content ?? message.content;
  if (message.attachments?.length && !message.provider_content)
    content = [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...message.attachments.map((item) => ({
        type: item.kind === 'image' ? 'image' : 'file',
        base64: item.data,
        mime_type: item.mime_type,
        filename: item.filename,
      })),
    ];
  const data: Record<string, unknown> = {
    ...structuredClone(legacy),
    content,
    additional_kwargs: extra,
    response_metadata: structuredClone(
      isRecord(legacy.response_metadata) ? legacy.response_metadata : {},
    ),
    type,
    name: message.name ?? legacy.name ?? null,
    id: message.id,
  };
  if (message.role === 'assistant') {
    data.tool_calls = (message.tool_calls ?? []).map((call) => ({
      name: call.name,
      args: call.args,
      id: call.id,
      type: 'tool_call',
    }));
    data.invalid_tool_calls = legacy.invalid_tool_calls ?? [];
    data.usage_metadata = message.usage
      ? {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          total_tokens:
            message.usage.input_tokens + message.usage.output_tokens,
          input_token_details: {
            cache_read: message.usage.cache_read_tokens,
            ...(message.usage.cache_write_tokens !== undefined
              ? { cache_creation: message.usage.cache_write_tokens }
              : {}),
          },
        }
      : (legacy.usage_metadata ?? null);
  } else if (message.role === 'tool') {
    data.tool_call_id = message.tool_call_id;
    data.artifact = legacy.artifact ?? null;
    data.status = message.status ?? 'success';
  }
  return { type, data };
}
export function rpcJob(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    reason: job.reason,
    exitCode: job.exitCode ?? null,
    startedBy: job.startedBy ?? 'model',
    elapsed: Math.round(((job.ended ?? Date.now()) - job.started) / 100) / 10,
    output: job.virtualPath || job.outputPath,
    sessionId: job.sessionId,
  };
}
