// The conversation as a tree, as /tree lists it (0.5.0's circle/tui/conversation_tree.py).
// Going back to an earlier message and sending something else erases nothing: both branches
// stay in the session. The entries are your messages and the model's answers; tool calls,
// their results and Circle's own notes are steps between them and are not listed.
import type { CheckpointStore } from '../checkpoint_store.js';
import type { Message } from '../types.js';

const LINK = /!?\[([^\]]*)\]\([^)\s]*\)/g;
const LINE_MARK =
  /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(?=\S)|```\S*)/gm;

/** A message as one row of a list: the words without Markdown's marks, on one line. */
export function rowText(text: string): string {
  return (text || '')
    .replace(LINK, '$1')
    .replace(LINE_MARK, '')
    .replaceAll('**', '')
    .replaceAll('`', '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

export interface TreeEntry {
  /** The checkpoint that holds the message. */
  key: string;
  role: 'user' | 'assistant';
  text: string;
  message: Message;
  /** The entry before it on its branch; undefined at the start of the conversation. */
  parent?: string;
  /** The entries after it, oldest first. */
  children: string[];
}

export interface ConversationTree {
  entries: Map<string, TreeEntry>;
  roots: string[];
  /** The entry the conversation is at now. */
  leaf?: string;
}

// Something you wrote, or an answer with words and no tool call.
function entryRole(message: Message): TreeEntry['role'] | undefined {
  if (message.internal) return undefined;
  if (message.role === 'user') return 'user';
  if (
    message.role === 'assistant' &&
    !message.tool_calls?.length &&
    message.content.trim()
  )
    return 'assistant';
  return undefined;
}

/** Every branch of a session, read from its checkpoints. */
export function conversationTree(
  store: CheckpointStore,
  sessionId: string,
): ConversationTree {
  const rows = store.tree(sessionId);
  const parents = new Map(rows.map((row) => [row.id, row.parent]));
  const roles = new Map<string, TreeEntry['role']>();
  for (const row of rows) {
    const role = entryRole(row.message);
    if (role) roles.set(row.id, role);
  }
  // The nearest entry at or above a checkpoint; steps between are walked over once.
  const found = new Map<string, string | undefined>();
  const entryAt = (id: string | null | undefined): string | undefined => {
    const walked: string[] = [];
    let cursor = id ?? null;
    let entry: string | undefined;
    while (cursor) {
      if (roles.has(cursor)) {
        entry = cursor;
        break;
      }
      if (found.has(cursor)) {
        entry = found.get(cursor);
        break;
      }
      if (walked.includes(cursor)) break; // a broken ancestry ends the walk
      walked.push(cursor);
      cursor = parents.has(cursor)
        ? parents.get(cursor)!
        : (store.checkpoint(cursor)?.parent ?? null);
    }
    for (const step of walked) found.set(step, entry);
    return entry;
  };
  const entries = new Map<string, TreeEntry>();
  for (const row of rows) {
    const role = roles.get(row.id);
    if (!role) continue;
    entries.set(row.id, {
      key: row.id,
      role,
      text:
        role === 'user'
          ? row.message.display || row.message.content
          : row.message.content.trim(),
      message: row.message,
      parent: entryAt(row.parent),
      children: [],
    });
  }
  const roots: string[] = [];
  for (const entry of entries.values())
    if (entry.parent) entries.get(entry.parent)?.children.push(entry.key);
    else roots.push(entry.key);
  return {
    entries,
    roots,
    leaf: entryAt(store.get(sessionId)?.head),
  };
}

/** The entries from the start of the conversation to `key`. */
export function pathTo(tree: ConversationTree, key?: string): string[] {
  const path: string[] = [];
  while (key && tree.entries.has(key)) {
    path.push(key);
    key = tree.entries.get(key)!.parent;
  }
  return path.reverse();
}

/**
 * Every entry with its depth in branches, siblings oldest first: a branch point puts its
 * children one level deeper. Iterative, as a long session is thousands of entries deep.
 */
export function walk(tree: ConversationTree): [string, number][] {
  const out: [string, number][] = [];
  const stack: [string, number][] = [];
  const push = (keys: string[], depth: number): void => {
    for (const key of [...keys].reverse()) stack.push([key, depth]);
  };
  push(tree.roots, tree.roots.length > 1 ? 1 : 0);
  while (stack.length) {
    const [key, depth] = stack.pop()!;
    out.push([key, depth]);
    const children = tree.entries.get(key)!.children;
    push(children, depth + (children.length > 1 ? 1 : 0));
  }
  return out;
}

/** An entry's row in /tree: indented by branch, `├` where a branch starts, `›` yours, `⏺` an answer. */
export function treeRow(
  tree: ConversationTree,
  key: string,
  depth: number,
  label = '',
): string {
  const entry = tree.entries.get(key)!;
  const parent = entry.parent ? tree.entries.get(entry.parent) : undefined;
  const fork = Boolean(parent && parent.children.length > 1);
  const lead =
    '  '.repeat(Math.max(0, depth - (fork ? 1 : 0))) + (fork ? '├ ' : '');
  const mark = entry.role === 'user' ? '›' : '⏺';
  return `${lead}${mark} ${label ? `[${label}] ` : ''}${rowText(entry.text)}`;
}
