import type { Session, Checkpoint, ContextState } from './checkpoint_store.js';
import type { Message } from './types.js';
import { isRecord } from './settings.js';
import { validateAttachments } from './media.js';
export interface SessionGraphNode {
  session: Session;
  checkpoints: Checkpoint[];
  contexts: { checkpoint_id: string; state: ContextState; created: number }[];
  labels: Record<string, string>;
}
export interface SessionGraph {
  root: string;
  sessions: SessionGraphNode[];
}
const string = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function validateMessages(messages: Message[], balanced = true): void {
  let pending = new Set<string>();
  for (const message of messages) pending = validateMessage(message, pending);
  if (balanced && pending.size)
    throw new Error('export has pending tool calls');
}
function validateMessage(message: Message, previous: Set<string>): Set<string> {
  const pending =
    message?.tool_calls?.length || message?.role === 'tool'
      ? new Set(previous)
      : previous;
  if (
    !isRecord(message) ||
    !string(message.id) ||
    !['user', 'assistant', 'tool', 'system'].includes(message.role) ||
    typeof message.content !== 'string'
  )
    throw new Error('invalid session message');
  if (message.attachments !== undefined) {
    if (!['user', 'tool'].includes(message.role) || message.status === 'error')
      throw new Error('invalid media message');
    validateAttachments(message.attachments);
  }
  if (
    message.shell !== undefined &&
    (message.role !== 'user' ||
      !isRecord(message.shell) ||
      typeof message.shell.command !== 'string' ||
      typeof message.shell.output !== 'string' ||
      !Number.isInteger(message.shell.exit_code))
  )
    throw new Error('invalid user shell message');
  if (
    message.tool_calls !== undefined &&
    (!Array.isArray(message.tool_calls) || message.role !== 'assistant')
  )
    throw new Error('invalid tool-call message');
  if (message.tool_calls?.length && pending.size)
    throw new Error('new tool calls before pending results');
  const seen = new Set<string>();
  for (const call of message.tool_calls ?? []) {
    if (
      !isRecord(call) ||
      !string(call.id) ||
      !string(call.name) ||
      !isRecord(call.args) ||
      seen.has(call.id)
    )
      throw new Error('invalid or duplicate tool call');
    pending.add(call.id);
    seen.add(call.id);
  }
  if (
    message.role === 'tool' &&
    (!message.tool_call_id || !pending.delete(message.tool_call_id))
  )
    throw new Error('tool result has no matching call');
  return pending;
}
export function graphMessages(
  node: SessionGraphNode,
  head: string | null = node.session.head,
): Message[] {
  const checkpoints = new Map(
    node.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const seen = new Set<string>();
  const messages: Message[] = [];
  while (head) {
    if (seen.has(head)) throw new Error('checkpoint ancestry cycle');
    seen.add(head);
    const checkpoint = checkpoints.get(head);
    if (!checkpoint || checkpoint.session_id !== node.session.id)
      throw new Error('invalid checkpoint ancestry');
    if (checkpoint.message) messages.push(checkpoint.message);
    head = checkpoint.parent;
  }
  return messages.reverse();
}
export function orderedCheckpoints(node: SessionGraphNode): Checkpoint[] {
  const byId = new Map(
    node.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const done = new Set<string>();
  const result: Checkpoint[] = [];
  for (const item of node.checkpoints) {
    const path: Checkpoint[] = [];
    const seen = new Set<string>();
    let cursor: string | null = item.id;
    while (cursor && !done.has(cursor)) {
      if (seen.has(cursor)) throw new Error('checkpoint ancestor is cyclic');
      seen.add(cursor);
      const checkpoint = byId.get(cursor);
      if (!checkpoint) throw new Error('checkpoint ancestor is missing');
      path.push(checkpoint);
      cursor = checkpoint.parent;
    }
    for (const checkpoint of path.reverse()) {
      done.add(checkpoint.id);
      result.push(checkpoint);
    }
  }
  return result;
}
const artifact = (path: unknown, kind: string, extension: string): boolean =>
  typeof path === 'string' &&
  new RegExp(`^/${kind}/[a-f0-9]{24}\\.${extension}$`).test(path);
function validateContext(
  state: unknown,
  contains: (id: string, role?: Message['role']) => boolean,
  sessionIds: Set<string>,
): asserts state is ContextState {
  if (
    !isRecord(state) ||
    !Array.isArray(state.prunedIds) ||
    !state.prunedIds.every(string) ||
    !Array.isArray(state.stripThinkingIds) ||
    !state.stripThinkingIds.every(string) ||
    !isRecord(state.offloaded)
  )
    throw new Error('invalid context state');
  if (
    state.prunedIds.some((id) => !contains(id, 'tool')) ||
    state.stripThinkingIds.some((id) => !contains(id, 'assistant'))
  )
    throw new Error('context references a missing message');
  for (const [id, path] of Object.entries(state.offloaded))
    if (!contains(id, 'tool') || !artifact(path, 'large_tool_results', 'txt'))
      throw new Error('invalid offloaded result reference');
  if (state.summary !== undefined) {
    if (
      !isRecord(state.summary) ||
      !string(state.summary.cutoffMessageId) ||
      !contains(state.summary.cutoffMessageId) ||
      typeof state.summary.text !== 'string'
    )
      throw new Error('invalid summary boundary');
    if (
      state.summary.historyPath !== undefined &&
      !artifact(state.summary.historyPath, 'conversation_history', 'jsonl')
    )
      throw new Error('invalid summary history path');
  }
  if (
    state.subagentSessionIds !== undefined &&
    (!Array.isArray(state.subagentSessionIds) ||
      !state.subagentSessionIds.every(
        (id) => string(id) && sessionIds.has(id),
      ) ||
      new Set(state.subagentSessionIds).size !==
        state.subagentSessionIds.length)
  )
    throw new Error('invalid child-session reference');
  if (state.compactionCalls !== undefined) {
    if (!Array.isArray(state.compactionCalls))
      throw new Error('invalid compaction accounting');
    const seen = new Set<string>();
    for (const call of state.compactionCalls) {
      if (
        !isRecord(call) ||
        !string(call.id) ||
        seen.has(call.id) ||
        typeof call.model !== 'string' ||
        !isRecord(call.usage)
      )
        throw new Error('invalid compaction accounting');
      seen.add(call.id);
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens'])
        if (
          !Number.isSafeInteger(call.usage[key]) ||
          (call.usage[key] as number) < 0
        )
          throw new Error('invalid compaction usage');
    }
  }
}
function ancestorMessages(
  node: SessionGraphNode,
): (head: string, message: string, role?: Message['role']) => boolean {
  const children = new Map<string | null, Checkpoint[]>();
  const messages = new Map<string, Checkpoint[]>();
  for (const checkpoint of node.checkpoints) {
    children.set(checkpoint.parent, [
      ...(children.get(checkpoint.parent) ?? []),
      checkpoint,
    ]);
    if (checkpoint.message)
      messages.set(checkpoint.message.id, [
        ...(messages.get(checkpoint.message.id) ?? []),
        checkpoint,
      ]);
  }
  const positions = new Map<string, { begin: number; end: number }>();
  let counter = 0;
  const stack: { checkpoint: Checkpoint; leaving: boolean }[] = (
    children.get(null) ?? []
  ).map((checkpoint) => ({ checkpoint, leaving: false }));
  while (stack.length) {
    const { checkpoint, leaving } = stack.pop()!;
    if (leaving) positions.get(checkpoint.id)!.end = counter++;
    else {
      positions.set(checkpoint.id, { begin: counter++, end: -1 });
      stack.push({ checkpoint, leaving: true });
      for (const child of children.get(checkpoint.id) ?? [])
        stack.push({ checkpoint: child, leaving: false });
    }
  }
  return (head, message, role) => {
    const current = positions.get(head)!;
    return (messages.get(message) ?? []).some((checkpoint) => {
      const ancestor = positions.get(checkpoint.id)!;
      return (
        (!role || checkpoint.message!.role === role) &&
        ancestor.begin <= current.begin &&
        ancestor.end >= current.end
      );
    });
  };
}
export function validateSessionGraph(
  value: unknown,
): asserts value is SessionGraph {
  if (
    !isRecord(value) ||
    !string(value.root) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.length
  )
    throw new Error('invalid session graph');
  const ids = new Set<string>();
  const allCheckpoints = new Set<string>();
  for (const raw of value.sessions) {
    if (
      !isRecord(raw) ||
      !isRecord(raw.session) ||
      !string(raw.session.id) ||
      ids.has(raw.session.id) ||
      typeof raw.session.workspace !== 'string' ||
      typeof raw.session.title !== 'string' ||
      typeof raw.session.model !== 'string' ||
      !timestamp(raw.session.created) ||
      !timestamp(raw.session.updated) ||
      (raw.session.head !== null && !string(raw.session.head)) ||
      (raw.session.parent_id !== null && !string(raw.session.parent_id)) ||
      !Array.isArray(raw.checkpoints) ||
      !Array.isArray(raw.contexts) ||
      !isRecord(raw.labels)
    )
      throw new Error('invalid or duplicate session');
    ids.add(raw.session.id);
    for (const checkpoint of raw.checkpoints) {
      if (
        !isRecord(checkpoint) ||
        !string(checkpoint.id) ||
        allCheckpoints.has(checkpoint.id) ||
        checkpoint.session_id !== raw.session.id ||
        (checkpoint.parent !== null && !string(checkpoint.parent)) ||
        !timestamp(checkpoint.created) ||
        (checkpoint.message !== null && !isRecord(checkpoint.message))
      )
        throw new Error('invalid or duplicate checkpoint');
      allCheckpoints.add(checkpoint.id);
    }
  }
  if (!ids.has(value.root)) throw new Error('session graph root is missing');
  const nodes = new Map(
    (value.sessions as SessionGraphNode[]).map((node) => [
      node.session.id,
      node,
    ]),
  );
  for (const node of nodes.values()) {
    if (
      node.session.id === value.root
        ? node.session.parent_id !== null
        : !node.session.parent_id || !ids.has(node.session.parent_id)
    )
      throw new Error('invalid session parent');
    let parent: string | null = node.session.id;
    const seen = new Set<string>();
    while (parent) {
      if (seen.has(parent)) throw new Error('session parent cycle');
      seen.add(parent);
      parent = nodes.get(parent)!.session.parent_id;
    }
    const ordered = orderedCheckpoints(node);
    // Validate every branch, including unfinished intermediate tool-call rounds.
    const byId = new Set(node.checkpoints.map((checkpoint) => checkpoint.id));
    const pendingAt = new Map<string, Set<string>>();
    for (const checkpoint of ordered) {
      const pending = checkpoint.parent
        ? pendingAt.get(checkpoint.parent)!
        : new Set<string>();
      pendingAt.set(
        checkpoint.id,
        checkpoint.message
          ? validateMessage(checkpoint.message, pending)
          : pending,
      );
    }
    if (node.session.head && !byId.has(node.session.head))
      throw new Error('selected checkpoint is missing');
    if (
      node.session.id === value.root &&
      node.session.head &&
      pendingAt.get(node.session.head)!.size
    )
      throw new Error('export has pending tool calls');
    const contains = ancestorMessages(node);
    for (const context of node.contexts) {
      if (
        !isRecord(context) ||
        !string(context.checkpoint_id) ||
        !byId.has(context.checkpoint_id) ||
        !timestamp(context.created)
      )
        throw new Error('invalid context checkpoint');
      validateContext(
        context.state,
        (id, role) => contains(context.checkpoint_id, id, role),
        ids,
      );
      for (const child of context.state.subagentSessionIds ?? [])
        if (nodes.get(child)!.session.parent_id !== node.session.id)
          throw new Error('child-session owner does not match its context');
    }
    const messageIds = new Set(
      node.checkpoints.flatMap((checkpoint) =>
        checkpoint.message ? [checkpoint.message.id] : [],
      ),
    );
    for (const [id, label] of Object.entries(node.labels))
      if (!messageIds.has(id) || typeof label !== 'string')
        throw new Error('invalid message label');
  }
}
