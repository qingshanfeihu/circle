import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ensureHome, normalizeWorkspace } from './paths.js';
import type { Message } from './types.js';
import type { LegacyImportPlan } from './legacy_sessions.js';
import { createHash } from 'node:crypto';
import {
  validateSessionGraph,
  orderedCheckpoints,
  type SessionGraph,
  type SessionGraphNode,
} from './session_graph.js';
export interface Session {
  id: string;
  workspace: string;
  title: string;
  model: string;
  head: string | null;
  created: number;
  updated: number;
  parent_id: string | null;
}
export interface Checkpoint {
  id: string;
  session_id: string;
  parent: string | null;
  message: Message | null;
  created: number;
}
export interface ContextState {
  subagentSessionIds?: string[];
  compactionCalls?: {
    id: string;
    model: string;
    usage: import('./types.js').Usage;
    cost?: import('./pricing.js').PriceReceipt;
  }[];
  summary?: {
    cutoffMessageId: string;
    text: string;
    historyPath?: string;
    usage?: import('./types.js').Usage;
    response?: Message;
    model?: string;
  };
  prunedIds: string[];
  stripThinkingIds: string[];
  offloaded: Record<string, string>;
}
export const emptyContextState = (): ContextState => ({
  prunedIds: [],
  stripThinkingIds: [],
  offloaded: {},
});
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
      CREATE TABLE IF NOT EXISTS context_versions (version INTEGER PRIMARY KEY AUTOINCREMENT, checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE, state TEXT NOT NULL, created REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS context_versions_checkpoint ON context_versions(checkpoint_id, version);
      CREATE TABLE IF NOT EXISTS labels (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, message_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(session_id, message_id));
      CREATE TABLE IF NOT EXISTS legacy_imports (source_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, receipt TEXT NOT NULL, created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_checkpoints (source_key TEXT NOT NULL, legacy_id TEXT NOT NULL, native_head TEXT, PRIMARY KEY(source_key, legacy_id));
      `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(
        this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
      );
      const columns = this.db.prepare('PRAGMA table_info(sessions)').all();
      if (!columns.some((row) => row.name === 'parent_id'))
        this.db.exec('ALTER TABLE sessions ADD COLUMN parent_id TEXT');
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);',
      );
      // Upgrade native children once, without changing history or replaying work.
      if (version < 4)
        for (const row of this.db
          .prepare(
            'SELECT c.session_id,v.state FROM context_versions v JOIN checkpoints c ON c.id=v.checkpoint_id ORDER BY v.version',
          )
          .all()) {
          const state = JSON.parse(String(row.state)) as ContextState;
          for (const child of state.subagentSessionIds ?? [])
            if (child !== row.session_id)
              this.db
                .prepare(
                  'UPDATE sessions SET parent_id=? WHERE id=? AND parent_id IS NULL',
                )
                .run(String(row.session_id), child);
        }
      this.db.exec('PRAGMA user_version = 4; COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  create(
    workspace: string,
    model: string,
    title = '',
    id = 'circle-' + randomUUID().slice(0, 8),
    parentId: string | null = null,
  ): Session {
    const existing = this.get(id);
    if (existing) {
      if (existing.workspace !== normalizeWorkspace(workspace))
        throw new Error('session belongs to a different workspace');
      if (existing.parent_id !== parentId)
        throw new Error('session belongs to a different parent');
      return existing;
    }
    const now = Date.now();
    if (parentId && !this.get(parentId))
      throw new Error('parent session is missing');
    this.db
      .prepare(
        'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
      )
      .run(id, normalizeWorkspace(workspace), title, model, now, now, parentId);
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
  list(workspace?: string, includeChildren = false): Session[] {
    return (workspace
      ? this.db
          .prepare(
            `SELECT * FROM sessions WHERE workspace = ? ${includeChildren ? '' : 'AND parent_id IS NULL'} ORDER BY updated DESC`,
          )
          .all(normalizeWorkspace(workspace))
      : this.db
          .prepare(
            `SELECT * FROM sessions ${includeChildren ? '' : 'WHERE parent_id IS NULL'} ORDER BY updated DESC`,
          )
          .all()) as unknown as Session[];
  }
  children(parentId: string): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE parent_id=? ORDER BY created,id')
      .all(parentId) as unknown as Session[];
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
  tree(session: string): (Checkpoint & { message: Message })[] {
    return this.db
      .prepare(
        'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created, rowid',
      )
      .all(session)
      .map((row) => this.decode(row))
      .filter(
        (row): row is Checkpoint & { message: Message } => row.message !== null,
      );
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
      if (row.message) messages.push(row.message);
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
    return this.importGraph(this.exportGraph(sessionId, head, true), workspace);
  }
  delete(sessionId: string): void {
    const visit = (id: string, seen: Set<string>): void => {
      if (seen.has(id)) throw new Error('session parent cycle');
      seen.add(id);
      for (const child of this.children(id)) visit(child.id, seen);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      visit(sessionId, new Set());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  labels(sessionId: string): Record<string, string> {
    return Object.fromEntries(
      this.db
        .prepare('SELECT message_id, label FROM labels WHERE session_id = ?')
        .all(sessionId)
        .map((row) => [String(row.message_id), String(row.label)]),
    );
  }
  setLabel(sessionId: string, messageId: string, label: string): void {
    const clean = label.trim().replace(/\s+/gu, ' ').slice(0, 40);
    if (
      !this.tree(sessionId).some(
        (checkpoint) => checkpoint.message.id === messageId,
      )
    )
      throw new Error('label names no message');
    if (clean)
      this.db
        .prepare('INSERT OR REPLACE INTO labels VALUES (?, ?, ?)')
        .run(sessionId, messageId, clean);
    else
      this.db
        .prepare('DELETE FROM labels WHERE session_id = ? AND message_id = ?')
        .run(sessionId, messageId);
  }
  migrationReceipts(): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT receipt FROM legacy_imports ORDER BY created')
      .all()
      .map((row) => JSON.parse(String(row.receipt)) as Record<string, unknown>);
  }
  importedLegacyKeys(): Set<string> {
    return new Set(
      this.db
        .prepare('SELECT source_key FROM legacy_imports')
        .all()
        .map((row) => String(row.source_key)),
    );
  }
  legacyHead(
    sourceKey: string,
    checkpointId: string,
  ): string | null | undefined {
    const row = this.db
      .prepare(
        'SELECT native_head FROM legacy_checkpoints WHERE source_key = ? AND legacy_id = ?',
      )
      .get(sourceKey, checkpointId);
    return row
      ? row.native_head === null
        ? null
        : String(row.native_head)
      : undefined;
  }
  importLegacy(plan: LegacyImportPlan): 'imported' | 'skipped' {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.db
          .prepare('SELECT source_key FROM legacy_imports WHERE source_key = ?')
          .get(plan.sourceKey)
      ) {
        this.db.exec('ROLLBACK');
        return 'skipped';
      }
      if (this.get(plan.session.thread_id))
        throw new Error(
          'legacy session ID conflicts with an existing native session',
        );
      const session = plan.session;
      if (plan.parentId && !this.get(plan.parentId))
        throw new Error('legacy parent session is missing');
      this.db
        .prepare(
          'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
        )
        .run(
          session.thread_id,
          session.workspace,
          session.title,
          session.model,
          session.created * 1000,
          session.updated * 1000,
          plan.parentId ?? null,
        );
      const paths = new Map<
        string,
        { messages: Message[]; ids: string[]; head: string | null }
      >();
      const maps = new Map<string, string | null>();
      for (const snapshot of plan.snapshots) {
        const parent = snapshot.parent ? paths.get(snapshot.parent) : undefined;
        if (snapshot.parent && !parent)
          throw new Error('migration checkpoint parent is missing');
        const parentMessages = parent?.messages ?? [];
        const ids = parent?.ids ?? [];
        let prefix = 0;
        while (
          prefix < Math.min(parentMessages.length, snapshot.messages.length) &&
          JSON.stringify(parentMessages[prefix]) ===
            JSON.stringify(snapshot.messages[prefix])
        )
          prefix++;
        const current = ids.slice(0, prefix);
        let head =
          parent && prefix === parentMessages.length
            ? parent.head
            : (current.at(-1) ?? null);
        for (let index = prefix; index < snapshot.messages.length; index++) {
          const message = snapshot.messages[index]!;
          const id =
            'legacy-' +
            createHash('sha256')
              .update(
                plan.sourceKey +
                  ':' +
                  snapshot.id +
                  ':' +
                  index +
                  ':' +
                  JSON.stringify(message),
              )
              .digest('hex');
          this.db
            .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
            .run(
              id,
              session.thread_id,
              head,
              JSON.stringify(message),
              snapshot.timestamp || session.updated * 1000,
            );
          current.push(id);
          head = id;
        }
        const boundary =
          'legacy-boundary-' +
          createHash('sha256')
            .update(plan.sourceKey + ':' + snapshot.id)
            .digest('hex');
        this.db
          .prepare('INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?)')
          .run(
            boundary,
            session.thread_id,
            head,
            'null',
            snapshot.timestamp || session.updated * 1000,
          );
        head = boundary;
        paths.set(snapshot.id, {
          messages: snapshot.messages,
          ids: current,
          head,
        });
        maps.set(snapshot.id, head);
        this.db
          .prepare('INSERT INTO legacy_checkpoints VALUES (?, ?, ?)')
          .run(plan.sourceKey, snapshot.id, head);
        if (head)
          this.db
            .prepare(
              'INSERT INTO context_versions (checkpoint_id,state,created) VALUES (?, ?, ?)',
            )
            .run(
              head,
              JSON.stringify(snapshot.context),
              snapshot.timestamp || session.updated * 1000,
            );
      }
      if (!maps.has(plan.selected))
        throw new Error('migration selected checkpoint is missing');
      this.db
        .prepare('UPDATE sessions SET head = ? WHERE id = ?')
        .run(maps.get(plan.selected)!, session.thread_id);
      for (const [id, label] of Object.entries(plan.labels))
        this.db
          .prepare('INSERT INTO labels VALUES (?, ?, ?)')
          .run(session.thread_id, id, label);
      this.db
        .prepare('INSERT INTO legacy_imports VALUES (?, ?, ?, ?)')
        .run(
          plan.sourceKey,
          session.thread_id,
          JSON.stringify(plan.receipt),
          Date.now(),
        );
      this.db.exec('COMMIT');
      return 'imported';
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
  exportGraph(
    sessionId: string,
    head?: string | null,
    branchOnly = false,
  ): SessionGraph {
    this.db.exec('BEGIN');
    try {
      const graph: SessionGraph = { root: sessionId, sessions: [] };
      const queue: {
        id: string;
        parent: string | null;
        head?: string | null;
      }[] = [{ id: sessionId, parent: null, head }];
      const owners = new Map<string, string | null>();
      while (queue.length) {
        const item = queue.shift()!;
        if (owners.has(item.id)) {
          if (owners.get(item.id) !== item.parent)
            throw new Error('child session has multiple owners');
          continue;
        }
        owners.set(item.id, item.parent);
        const session = this.get(item.id);
        if (!session) throw new Error('referenced session is missing');
        const selected = item.head === undefined ? session.head : item.head;
        let checkpoints = this.db
          .prepare(
            'SELECT * FROM checkpoints WHERE session_id=? ORDER BY rowid',
          )
          .all(item.id)
          .map((row) => this.decode(row));
        if (branchOnly) {
          const byId = new Map(
            checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
          );
          const included = new Set<string>();
          let cursor = selected;
          while (cursor) {
            if (included.has(cursor))
              throw new Error('checkpoint ancestry cycle');
            included.add(cursor);
            const checkpoint = byId.get(cursor);
            if (!checkpoint) throw new Error('checkpoint is missing');
            cursor = checkpoint.parent;
          }
          checkpoints = checkpoints.filter((checkpoint) =>
            included.has(checkpoint.id),
          );
        }
        const checkpointIds = new Set(
          checkpoints.map((checkpoint) => checkpoint.id),
        );
        const contexts = this.db
          .prepare(
            'SELECT v.checkpoint_id,v.state,v.created FROM context_versions v JOIN checkpoints c ON c.id=v.checkpoint_id WHERE c.session_id=? ORDER BY v.version',
          )
          .all(item.id)
          .filter((row) => checkpointIds.has(String(row.checkpoint_id)))
          .map((row) => ({
            checkpoint_id: String(row.checkpoint_id),
            state: JSON.parse(String(row.state)) as ContextState,
            created: Number(row.created),
          }));
        const effective = this.contextState(item.id, selected);
        if (selected && !contexts.some((row) => row.checkpoint_id === selected))
          contexts.push({
            checkpoint_id: selected,
            state: effective,
            created: Date.now(),
          });
        const messageIds = new Set(
          checkpoints.flatMap((checkpoint) =>
            checkpoint.message ? [checkpoint.message.id] : [],
          ),
        );
        const labels = Object.fromEntries(
          Object.entries(this.labels(item.id)).filter(([id]) =>
            messageIds.has(id),
          ),
        );
        const node: SessionGraphNode = {
          session: { ...session, head: selected, parent_id: item.parent },
          checkpoints,
          contexts,
          labels,
        };
        graph.sessions.push(node);
        const children = new Set(
          contexts.flatMap((row) => row.state.subagentSessionIds ?? []),
        );
        if (!branchOnly)
          for (const child of this.children(item.id)) children.add(child.id);
        for (const id of children) queue.push({ id, parent: item.id });
      }
      validateSessionGraph(graph);
      this.db.exec('COMMIT');
      return graph;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  importGraph(graph: SessionGraph, workspace: string): Session {
    validateSessionGraph(graph);
    const sessionIds = new Map(
      graph.sessions.map((node) => [node.session.id, 'circle-' + randomUUID()]),
    );
    const checkpointIds = new Map(
      graph.sessions.flatMap((node) =>
        node.checkpoints.map(
          (checkpoint) => [checkpoint.id, randomUUID()] as const,
        ),
      ),
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const node of graph.sessions) {
        const session = node.session;
        this.db
          .prepare(
            'INSERT INTO sessions (id,workspace,title,model,head,created,updated,parent_id) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            sessionIds.get(session.id)!,
            normalizeWorkspace(workspace),
            session.title,
            session.model,
            session.head ? checkpointIds.get(session.head)! : null,
            session.created,
            session.updated,
            session.parent_id ? sessionIds.get(session.parent_id)! : null,
          );
      }
      for (const node of graph.sessions) {
        for (const checkpoint of orderedCheckpoints(node))
          this.db
            .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?)')
            .run(
              checkpointIds.get(checkpoint.id)!,
              sessionIds.get(node.session.id)!,
              checkpoint.parent ? checkpointIds.get(checkpoint.parent)! : null,
              JSON.stringify(checkpoint.message),
              checkpoint.created,
            );
        for (const context of node.contexts) {
          const state = structuredClone(context.state);
          if (state.subagentSessionIds)
            state.subagentSessionIds = state.subagentSessionIds.map((id) =>
              sessionIds.get(id)!,
            );
          this.db
            .prepare(
              'INSERT INTO context_versions (checkpoint_id,state,created) VALUES (?,?,?)',
            )
            .run(
              checkpointIds.get(context.checkpoint_id)!,
              JSON.stringify(state),
              context.created,
            );
        }
        for (const [id, label] of Object.entries(node.labels))
          this.db
            .prepare('INSERT INTO labels VALUES (?,?,?)')
            .run(sessionIds.get(node.session.id)!, id, label);
      }
      this.db.exec('COMMIT');
      return this.get(sessionIds.get(graph.root)!)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    if (checkpoint?.session_id !== sessionId || !checkpoint.message)
      throw new Error('invalid summary checkpoint');
    if (
      !this.messages(sessionId).some(
        (message) => message.id === checkpoint.message?.id,
      )
    )
      throw new Error('summary checkpoint is not on the active branch');
    this.setContextState(sessionId, {
      ...this.contextState(sessionId),
      summary: { cutoffMessageId: checkpoint.message.id, text: summary },
    });
  }
  contextState(sessionId: string, head?: string | null): ContextState {
    let cursor = head === undefined ? this.get(sessionId)?.head : head;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error('checkpoint ancestry cycle');
      seen.add(cursor);
      const checkpoint = this.checkpoint(cursor);
      if (!checkpoint || checkpoint.session_id !== sessionId)
        throw new Error('invalid checkpoint ancestry');
      const row = this.db
        .prepare(
          'SELECT state FROM context_versions WHERE checkpoint_id = ? ORDER BY version DESC LIMIT 1',
        )
        .get(cursor);
      if (row) return JSON.parse(String(row.state)) as ContextState;
      cursor = checkpoint.parent;
    }
    const legacy = this.db
      .prepare(
        'SELECT at_checkpoint, summary FROM context_projections WHERE session_id = ?',
      )
      .get(sessionId);
    if (legacy) {
      const checkpoint = this.checkpoint(String(legacy.at_checkpoint));
      if (
        checkpoint?.message &&
        this.messages(sessionId, head).some(
          (message) => message.id === checkpoint.message?.id,
        )
      )
        return {
          ...emptyContextState(),
          summary: {
            cutoffMessageId: checkpoint.message.id,
            text: String(legacy.summary),
          },
        };
    }
    return emptyContextState();
  }
  setContextState(
    sessionId: string,
    state: ContextState,
    expectedHead?: string | null,
  ): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.get(sessionId);
      if (!session) throw new Error('unknown session');
      if (expectedHead !== undefined && session.head !== expectedHead)
        throw new Error('session changed in another process');
      if (!session.head) throw new Error('context state needs a checkpoint');
      this.db
        .prepare(
          'INSERT INTO context_versions (checkpoint_id, state, created) VALUES (?, ?, ?)',
        )
        .run(session.head, JSON.stringify(state), Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  projectedMessages(sessionId: string): Message[] {
    const raw = this.messages(sessionId);
    const projection = this.contextState(sessionId).summary;
    if (!projection) return raw;
    const index = raw.findIndex(
      (message) => message.id === projection.cutoffMessageId,
    );
    if (index < 0) return raw;
    return [
      {
        id: 'summary-' + projection.cutoffMessageId,
        role: 'user',
        content: `Earlier conversation summary:\n${projection.text}${projection.historyPath ? '\nFull earlier history: ' + projection.historyPath : ''}`,
        internal: 'summary',
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
