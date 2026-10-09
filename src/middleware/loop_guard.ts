import { createHash, randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import { envFlag } from '../model_guard.js';
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, ordered(value)]),
    );
  return value;
}
const fingerprint = (name: string, args: unknown): string =>
  createHash('sha1')
    .update(name + '::' + JSON.stringify(ordered(args)))
    .digest('hex')
    .slice(0, 16);
const empty = (content: string): boolean => {
  const low = content.trim().toLowerCase();
  return (
    !low ||
    (low.length <= 200 &&
      [
        '(no matches)',
        'no matches',
        'not found',
        'file empty',
        '(empty)',
        'no files found',
        'no results',
      ].some((marker) => low.includes(marker)))
  );
};
const integer = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) ? value : fallback;
};
export interface LoopStats {
  toolCalls: number;
  duplicate: number;
  emptyRounds: number;
  loose: number;
}
export function analyze(messages: Message[], window = 8): LoopStats {
  const lastUser = Math.max(
    0,
    messages.findLastIndex(
      (message) =>
        message.role === 'user' &&
        !message.internal &&
        !message.content.trimStart().startsWith('<system-reminder'),
    ),
  );
  const calls: string[] = [];
  const loose: { key: string; offset: number }[] = [];
  const rounds: boolean[][] = [];
  for (const message of messages.slice(lastUser)) {
    if (message.tool_calls?.length) rounds.push([]);
    for (const call of message.tool_calls ?? []) {
      calls.push(fingerprint(call.name, call.args));
      if (call.name.toLowerCase().includes('read')) {
        const args = Object.fromEntries(
          Object.entries(call.args).filter(
            ([key]) =>
              ![
                'offset',
                'limit',
                'head_limit',
                'page',
                'page_size',
                'start_line',
                'end_line',
              ].includes(key),
          ),
        );
        loose.push({
          key: fingerprint('loose::' + call.name, args),
          offset: Number(
            call.args.offset || call.args.page || call.args.start_line || 0,
          ),
        });
      } else loose.push({ key: '', offset: 0 });
    }
    if (message.role === 'tool' && rounds.length)
      rounds.at(-1)!.push(empty(message.content));
  }
  const counts = new Map<string, number>();
  for (const key of calls.slice(-window))
    counts.set(key, (counts.get(key) ?? 0) + 1);
  const groups = new Map<string, number[]>();
  for (const call of loose.slice(-16))
    if (call.key)
      groups.set(call.key, [...(groups.get(call.key) ?? []), call.offset]);
  let looseCount = 0;
  for (const offsets of groups.values())
    if (
      offsets.length > 1 &&
      !offsets.slice(1).every((offset, index) => offset > offsets[index]!)
    )
      looseCount = Math.max(looseCount, offsets.length);
  let emptyRounds = 0;
  for (const round of rounds.reverse()) {
    if (!round.length) continue;
    if (!round.every(Boolean)) break;
    emptyRounds++;
  }
  return {
    toolCalls: calls.length,
    duplicate: Math.max(0, ...counts.values()),
    emptyRounds,
    loose: looseCount,
  };
}
export function loopReminder(messages: Message[]): Message | undefined {
  if (!envFlag('CIRCLE_LOOP_GUARD') || messages.at(-1)?.role !== 'tool')
    return undefined;
  const window = integer('CIRCLE_LOOP_WINDOW', 8);
  const lastUser = messages.findLastIndex(
    (message) => message.role === 'user' && !message.internal,
  );
  const previous = messages.findLastIndex(
    (message) => message.internal === 'loop-guard',
  );
  if (
    previous > lastUser &&
    messages
      .slice(previous + 1)
      .filter((message) => message.role === 'assistant').length < window
  )
    return undefined;
  const stats = analyze(messages, window);
  const repeated =
    stats.duplicate >= integer('CIRCLE_LOOP_DUP_THRESHOLD', 3) ||
    stats.emptyRounds >= integer('CIRCLE_LOOP_EMPTY_THRESHOLD', 4) ||
    stats.loose >= 6;
  if (!repeated && stats.toolCalls < integer('CIRCLE_LOOP_SOFT_BUDGET', 25))
    return undefined;
  const content = repeated
    ? `You appear to be going in circles: ${stats.duplicate} duplicate calls, ${stats.emptyRounds} empty rounds, ${stats.loose} unordered reads. Retrying the same thing will not change the outcome. Answer from what you have, search differently or ask the user for the missing information.`
    : `This turn has made ${stats.toolCalls} tool calls without repeated or empty calls. This is not a request to stop. Carry on while each call brings new information.`;
  return {
    id: randomUUID(),
    role: 'user',
    content:
      '<system-reminder data-source="loop-guard">\n' +
      content +
      '\n</system-reminder>',
    internal: 'loop-guard',
  };
}
