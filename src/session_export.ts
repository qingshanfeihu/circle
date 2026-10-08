import type { Message } from './types.js';
import { isRecord } from './settings.js';
export interface SessionMeta {
  thread_id: string;
  title: string;
  workspace: string;
  model: string;
}
export function toJsonl(messages: Message[], meta: SessionMeta): string {
  const header = {
    format: 'circle-session',
    version: 2,
    id: meta.thread_id,
    title: meta.title,
    workspace: meta.workspace,
    model: meta.model,
    exported: new Date().toISOString(),
  };
  return (
    [header, ...messages.map((message) => ({ type: 'message', data: message }))]
      .map((value) => JSON.stringify(value))
      .join('\n') + '\n'
  );
}
export function fromJsonl(text: string): {
  header: Record<string, unknown>;
  messages: Message[];
} {
  let header: Record<string, unknown> = {};
  const messages: Message[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`line ${index + 1} is not JSON`);
    }
    if (!isRecord(raw)) throw new Error(`line ${index + 1} is not an object`);
    if (raw.format === 'circle-session') {
      if (raw.version !== 1 && raw.version !== 2)
        throw new Error('unsupported session export version');
      header = raw;
      continue;
    }
    if (!isRecord(raw.data) || typeof raw.type !== 'string')
      throw new Error(`line ${index + 1} is not a message`);
    const data = raw.data;
    if (raw.type === 'message') {
      if (
        !['user', 'assistant', 'tool'].includes(String(data.role)) ||
        typeof data.id !== 'string' ||
        typeof data.content !== 'string'
      )
        throw new Error(`line ${index + 1} has an invalid message`);
      messages.push(data as unknown as Message);
    } else {
      const role =
        raw.type === 'human'
          ? 'user'
          : raw.type === 'ai'
            ? 'assistant'
            : raw.type === 'tool'
              ? 'tool'
              : null;
      if (!role)
        throw new Error(`unsupported legacy message type: ${raw.type}`);
      const blocks = Array.isArray(data.content) ? data.content : [];
      const content =
        typeof data.content === 'string'
          ? data.content
          : blocks
              .filter(isRecord)
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text || ''))
              .join('');
      const thinking = blocks
        .filter(isRecord)
        .filter(
          (block) => block.type === 'thinking' || block.type === 'reasoning',
        )
        .map((block) => String(block.thinking || block.reasoning || ''))
        .join('');
      messages.push({
        id: typeof data.id === 'string' ? data.id : crypto.randomUUID(),
        role,
        content,
        thinking,
        ...(isRecord(data.additional_kwargs) &&
        data.additional_kwargs.circle_plan_reminder === true
          ? { internal: 'plan-reminder' }
          : isRecord(data.additional_kwargs) &&
              data.additional_kwargs.circle_loop_guard === true
            ? { internal: 'loop-guard' }
            : isRecord(data.additional_kwargs) &&
                data.additional_kwargs.circle_internal
              ? { internal: String(data.additional_kwargs.circle_internal) }
              : {}),
        tool_calls:
          role === 'assistant' && Array.isArray(data.tool_calls)
            ? (data.tool_calls as Message['tool_calls'])
            : undefined,
        tool_call_id:
          typeof data.tool_call_id === 'string' ? data.tool_call_id : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
        status: data.status === 'error' ? 'error' : 'success',
      });
    }
  }
  if (!messages.length) throw new Error('no messages in it');
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (
        !call ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof call.name !== 'string' ||
        !isRecord(call.args) ||
        seen.has(call.id)
      )
        throw new Error('invalid or duplicate tool call');
      pending.add(call.id);
      seen.add(call.id);
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id))
        throw new Error('tool result has no matching call');
    }
  }
  if (pending.size) throw new Error('export has pending tool calls');
  return { header, messages };
}
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}
export function toMarkdown(messages: Message[], meta: SessionMeta): string {
  return (
    `# ${meta.title || meta.thread_id}\n\n` +
    messages
      .filter((message) => !message.internal)
      .map(
        (message) =>
          `## ${message.role === 'tool' ? message.name || 'tool' : message.role}\n\n${message.display ?? message.content}${message.thinking ? '\n\nThinking:\n' + message.thinking : ''}\n`,
      )
      .join('\n')
  );
}
export function toHtml(messages: Message[], meta: SessionMeta): string {
  const body = messages
    .filter((message) => !message.internal)
    .map((message) => {
      if (message.role === 'user')
        return `<div class="you">${escapeHtml(message.display ?? message.content)}</div>`;
      if (message.role === 'tool')
        return `<details><summary>${message.status === 'error' ? '✖' : '●'} ${escapeHtml(message.name || 'tool')}</summary><pre>${escapeHtml(message.content)}</pre></details>`;
      return `${message.thinking ? `<details><summary>thinking</summary><pre>${escapeHtml(message.thinking)}</pre></details>` : ''}<div class="answer">${escapeHtml(message.content)}</div>`;
    })
    .join('\n');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(meta.title || meta.thread_id)}</title><style>:root{color-scheme:light dark}body{font:15px/1.55 system-ui;max-width:52rem;margin:2rem auto;padding:0 1rem;background:Canvas;color:CanvasText}header{border-bottom:1px solid GrayText}.you,.answer,details{margin:1rem 0;white-space:pre-wrap}.you{border-left:3px solid LinkText;padding:.2rem .8rem}pre{overflow-x:auto;white-space:pre-wrap}summary{cursor:pointer;color:GrayText}</style></head><body><header><h1>${escapeHtml(meta.title || meta.thread_id)}</h1><p>${escapeHtml([meta.thread_id, meta.model, meta.workspace].join(' · '))}</p></header>${body}</body></html>\n`;
}
export function exportKind(path: string): 'html' | 'jsonl' | 'md' {
  const name = path.toLowerCase();
  return name === 'html' || /\.html?$/.test(name)
    ? 'html'
    : name === 'jsonl' || name.endsWith('.jsonl')
      ? 'jsonl'
      : 'md';
}
