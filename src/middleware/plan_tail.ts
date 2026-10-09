import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { Todo } from '../tools.js';
export function planTail(todos: Todo[]): string {
  const items = todos.filter(
    (todo) =>
      todo.content.trim() &&
      ['pending', 'in_progress', 'completed'].includes(todo.status),
  );
  const first = items.findIndex((todo) => todo.status !== 'completed');
  if (first < 0) return '';
  const start =
    items.length > 15 ? Math.max(0, Math.min(first - 2, items.length - 15)) : 0;
  const window = items.slice(start, start + 15);
  const markers = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
  return [
    'This is a Circle automatically added reminder, not a user message. This is your current write_todos plan; privately update each step with write_todos when you finish it. Do not reply to this reminder.',
    ...(start ? [`… ${start} earlier steps`] : []),
    ...window.map((todo) => {
      const content = todo.content.replace(/\s+/gu, ' ').trim();
      return `${markers[todo.status]} ${Array.from(content).length > 96 ? Array.from(content).slice(0, 95).join('') + '…' : content}`;
    }),
    ...(start + window.length < items.length
      ? [`… ${items.length - start - window.length} later steps`]
      : []),
  ].join('\n');
}
export function planReminder(
  raw: Message[],
  visible: Message[],
  todos: Todo[],
  subagent = false,
): Message | undefined {
  if (
    subagent ||
    raw.at(-1)?.role !== 'tool' ||
    visible.at(-1)?.role !== 'tool'
  )
    return undefined;
  const content = planTail(todos);
  if (!content) return undefined;
  const lastUser = raw.findLastIndex(
    (message) => message.role === 'user' && !message.internal,
  );
  const completed = new Set(
    raw
      .slice(lastUser + 1)
      .filter(
        (message) => message.role === 'tool' && message.status !== 'error',
      )
      .map((message) => message.tool_call_id),
  );
  const lastWrite = raw.findLastIndex(
    (message, index) =>
      index > lastUser &&
      message.role === 'assistant' &&
      message.tool_calls?.some(
        (call) => call.name === 'write_todos' && completed.has(call.id),
      ) === true,
  );
  if (lastWrite < 0) return undefined;
  const write = visible.findIndex(
    (message) => message.id === raw[lastWrite]!.id,
  );
  const lastReminder = visible.findLastIndex(
    (message) => message.internal === 'plan-reminder',
  );
  const anchors = [write, lastReminder].filter((index) => index >= 0);
  if (
    anchors.length &&
    !anchors.every(
      (index) =>
        visible
          .slice(index + 1)
          .filter((message) => message.role === 'assistant').length >= 10,
    )
  )
    return undefined;
  return { id: randomUUID(), role: 'user', content, internal: 'plan-reminder' };
}
