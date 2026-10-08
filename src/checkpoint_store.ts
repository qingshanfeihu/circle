import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome, normalizeWorkspace } from './paths.js';
import type { Message } from './types.js';
export interface Session {
  id: string;
  workspace: string;
  title: string;
  model: string;
  head: string | null;
  created: number;
  updated: number;
}
export interface Checkpoint {
  id: string;
  session_id: string;
  parent: string | null;
  message: Message;
  created: number;
}
export class CheckpointStore {
  private db: DatabaseSync;
  private closed = false;
  constructor(home?: string) {
    this.db = new DatabaseSync(
      home ? join(ensureHome(home), 'circle-next.sqlite') : ':memory:',
    );
    this.db
      .exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL, head TEXT, created REAL NOT NULL, updated REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, parent TEXT REFERENCES checkpoints(id), message TEXT NOT NULL, created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoints_session ON checkpoints(session_id);
      CREATE TABLE IF NOT EXISTS context_projections (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, at_checkpoint TEXT NOT NULL, summary TEXT NOT NULL);
      PRAGMA user_version = 1;`);
  }
  create(
    workspace: string,
    model: string,
    title = '',
    id = 'circle-' + randomUUID().slice(0, 8),
  ): Session {
    const existing = this.get(id);
    if (existing) {
      if (existing.workspace !== normalizeWorkspace(workspace))
        throw new Error('session belongs to a different workspace');
      return existing;
    }
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(id, normalizeWorkspace(workspace), title, model, now, now);
    return this.get(id)!;
  }
  get(id: string): Session | undefined {
    return this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as Session | undefined;
  }
  find(suffix: string): Session | undefined {
    const sessions = this.list().filter(
      (session) => session.id === suffix || session.id.endsWith(suffix),
    );
    if (sessions.length > 1) throw new Error('session id is ambiguous');
    return sessions[0];
  }
  list(workspace?: string): Session[] {
    return (workspace
      ? this.db
          .prepare(
            'SELECT * FROM sessions WHERE workspace = ? ORDER BY updated DESC',
          )
          .all(normalizeWorkspace(workspace))
      : this.db
          .prepare('SELECT * FROM sessions ORDER BY updated DESC')
          .all()) as unknown as Session[];
  }
  rename(id: string, title: string): void {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated = ? WHERE id = ?')
      .run(title, Date.now(), id);
  }
  private decode(row: Record<string, unknown>): Checkpoint {
    return {
      id: String(row.id),
      session_id: String(row.session_id),
      parent: row.parent === null ? null : String(row.parent),
      message: JSON.parse(String(row.message)) as Message,
      created: Number(row.created),
    };
  }
  checkpoint(id: string): Checkpoint | undefined {
    const row = this.db
      .prepare('SELECT * FROM checkpoints WHERE id = ?')
      .get(id);
    return row ? this.decode(row) : undefined;
  }
  tree(session: string): Checkpoint[] {
    return this.db
      .prepare(
        'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created, rowid',
      )
      .all(session)
      .map((row) => this.decode(row));
  }
  append(
    sessionId: string,
    messages: Message[],
    expectedHead?: string | null,
  ): string | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.get(sessionId);
      if (!session) throw new Error('unknown session');
      if (expectedHead !== undefined && expectedHead !== session.head)
        throw new Error('session changed in another process');
      let head = session.head;
      for (const message of messages) {
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
          .run(id, sessionId, head, JSON.stringify(message), Date.now());
        head = id;
      }
      this.db
        .prepare('UPDATE sessions SET head = ?, updated = ? WHERE id = ?')
        .run(head, Date.now(), sessionId);
      this.db.exec('COMMIT');
      return head;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  messages(sessionId: string, head?: string | null): Message[] {
    let cursor = head === undefined ? this.get(sessionId)?.head : head;
    const messages: Message[] = [];
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error('checkpoint ancestry cycle');
      seen.add(cursor);
      const row = this.checkpoint(cursor);
      if (!row || row.session_id !== sessionId)
        throw new Error('invalid checkpoint ancestry');
      messages.push(row.message);
      cursor = row.parent;
    }
    return messages.reverse();
  }
  select(sessionId: string, head: string | null): void {
    const messages = this.messages(sessionId, head);
    this.requireBalancedTools(messages);
    this.db
      .prepare('UPDATE sessions SET head = ?, updated = ? WHERE id = ?')
      .run(head, Date.now(), sessionId);
  }
  fork(sessionId: string, workspace: string, head?: string | null): Session {
    const parent = this.get(sessionId);
    if (!parent) throw new Error('unknown session');
    const messages = this.messages(sessionId, head);
    this.requireBalancedTools(messages);
    const session = this.create(workspace, parent.model, parent.title);
    this.append(session.id, structuredClone(messages));
    return this.get(session.id)!;
  }
  delete(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  requireBalancedTools(messages: Message[]): void {
    const pending = new Set<string>();
    for (const message of messages) {
      for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === 'tool') pending.delete(message.tool_call_id!);
    }
    if (pending.size)
      throw new Error('cannot select a checkpoint with pending tool calls');
  }
  repairInterrupted(sessionId: string): void {
    const messages = this.messages(sessionId);
    const pending = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.tool_calls ?? [])
        pending.set(call.id, call.name);
      if (message.role === 'tool') pending.delete(message.tool_call_id!);
    }
    this.append(
      sessionId,
      [...pending].map(([id, name]) => ({
        id: randomUUID(),
        role: 'tool',
        tool_call_id: id,
        name,
        status: 'error',
        content:
          'Interrupted before a tool result was saved. The tool is not replayed.',
      })),
    );
  }
  setSummary(sessionId: string, at: string, summary: string): void {
    const checkpoint = this.checkpoint(at);
    if (checkpoint?.session_id !== sessionId)
      throw new Error('invalid summary checkpoint');
    this.db
      .prepare('INSERT OR REPLACE INTO context_projections VALUES (?, ?, ?)')
      .run(sessionId, at, summary);
  }
  projectedMessages(sessionId: string): Message[] {
    const raw = this.messages(sessionId);
    const projection = this.db
      .prepare(
        'SELECT at_checkpoint, summary FROM context_projections WHERE session_id = ?',
      )
      .get(sessionId);
    if (!projection) return raw;
    const checkpoint = this.checkpoint(String(projection.at_checkpoint));
    const index = raw.findIndex(
      (message) => message.id === checkpoint?.message.id,
    );
    if (index < 0) return raw;
    return [
      {
        id: 'summary-' + projection.at_checkpoint,
        role: 'user',
        content: `Earlier conversation summary:\n${projection.summary}`,
      },
      ...raw.slice(index + 1),
    ];
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
