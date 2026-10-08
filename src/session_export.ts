import { fromLegacyMessage } from './legacy_message.js';
import type { Message } from './types.js';
import { isRecord } from './settings.js';
import { createHash } from 'node:crypto';
import {
  graphMessages,
  validateSessionGraph,
  type SessionGraph,
} from './session_graph.js';
import type { CheckpointStore } from './checkpoint_store.js';
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
export function toSessionBundle(store: CheckpointStore, id: string): string {
  const graph = store.exportGraph(id);
  const root = graph.sessions.find(
    (node) => node.session.id === graph.root,
  )!.session;
  const lines = [
    JSON.stringify({
      format: 'circle-session',
      version: 3,
      id: root.id,
      title: root.title,
      workspace: root.workspace,
      model: root.model,
      exported: new Date().toISOString(),
    }),
    JSON.stringify({ type: 'session_graph', data: graph }),
  ];
  const body = lines.join('\n') + '\n';
  return (
    body +
    JSON.stringify({
      type: 'seal',
      algorithm: 'sha256',
      digest: createHash('sha256').update(body).digest('hex'),
    }) +
    '\n'
  );
}
export function fromJsonl(text: string): {
  header: Record<string, unknown>;
  messages: Message[];
  graph?: SessionGraph;
} {
  let header: Record<string, unknown> = {};
  const messages: Message[] = [];
  const lines = text.split('\n');
  const first = lines.find((line) => line.trim());
  if (first) {
    let initial: unknown;
    try {
      initial = JSON.parse(first);
    } catch {
      throw new Error('line 1 is not JSON');
    }
    if (
      isRecord(initial) &&
      initial.format === 'circle-session' &&
      initial.version === 3
    ) {
      if (lines.length !== 4 || lines[3] !== '')
        throw new Error('invalid session bundle framing');
      const payload: unknown = JSON.parse(lines[1]!);
      const seal: unknown = JSON.parse(lines[2]!);
      const body = lines.slice(0, 2).join('\n') + '\n';
      if (
        !isRecord(seal) ||
        seal.type !== 'seal' ||
        seal.algorithm !== 'sha256' ||
        seal.digest !== createHash('sha256').update(body).digest('hex')
      )
        throw new Error('session bundle integrity check failed');
      if (!isRecord(payload) || payload.type !== 'session_graph')
        throw new Error('invalid session graph record');
      const graph = payload.data;
      validateSessionGraph(graph);
      if (graph.root !== initial.id)
        throw new Error('session bundle root does not match header');
      const root = graph.sessions.find(
        (node) => node.session.id === graph.root,
      )!;
      return {
        header: initial,
        messages: graphMessages(root),
        graph,
      };
    }
  }
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
        !['user', 'assistant', 'tool', 'system'].includes(String(data.role)) ||
        typeof data.id !== 'string' ||
        typeof data.content !== 'string'
      )
        throw new Error(`line ${index + 1} has an invalid message`);
      messages.push(data as unknown as Message);
    } else {
      messages.push(
        fromLegacyMessage({ type: raw.type, data }, messages.length),
      );
    }
  }
  if (!messages.length) throw new Error('no messages in it');
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.tool_calls?.length && pending.size)
      throw new Error('new tool calls before pending results');
    const seen = new Set<string>();
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
