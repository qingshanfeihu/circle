import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeLegacy,
  unwrapSnapshot,
  isConstructor,
  constructorData,
} from './legacy_codec.js';
import {
  legacyRecord,
  fromLegacyMessage,
  type LegacyMessage,
} from './legacy_message.js';
import { isRecord } from './settings.js';
import type { Message } from './types.js';
import type { ContextState } from './checkpoint_store.js';
import { circleHome } from './paths.js';
export interface LegacyCheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array | string | null;
}
export interface LegacyWriteRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}
export interface LegacySessionInfo {
  thread_id: string;
  workspace: string;
  title: string;
  model: string;
  created: number;
  updated: number;
  leaf?: string;
}
export interface LegacySnapshot {
  id: string;
  parent: string | null;
  messages: Message[];
  context: ContextState;
  timestamp: number;
}
export interface LegacyImportPlan {
  sourceKey: string;
  session: LegacySessionInfo;
  snapshots: LegacySnapshot[];
  selected: string;
  labels: Record<string, string>;
  receipt: {
    format: number;
    source: string;
    thread: string;
    rows: number;
    writes: number;
    fingerprint: string;
    archive: string;
  };
}
export interface MigrationReport {
  imported: string[];
  skipped: string[];
  errors: { thread: string; message: string }[];
}
const hash = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');
function mergeMessages(
  base: LegacyMessage[],
  values: unknown,
): LegacyMessage[] {
  if (isConstructor(values) && values.name === 'Overwrite') {
    const args = constructorData(values);
    return mergeMessages([], isRecord(args) ? args.value : args);
  }
  const incoming = Array.isArray(values) ? values : [values];
  const result = [...base];
  for (const [index, value] of incoming.entries()) {
    if (value === null || value === undefined)
      throw new Error('empty legacy message write');
    const message = legacyRecord(value);
    const id =
      typeof message.data.id === 'string'
        ? message.data.id
        : fromLegacyMessage(message, base.length + index).id;
    if (message.type === 'remove') {
      if (id === '__remove_all__') result.splice(0);
      else {
        const at = result.findIndex((item) => item.data.id === id);
        if (at < 0) throw new Error('legacy removal names no existing message');
        result.splice(at, 1);
      }
      continue;
    }
    if (!message.data.id) message.data = { ...message.data, id };
    const at = result.findIndex((item) => item.data.id === id);
    if (at < 0) result.push(message);
    else result[at] = message;
  }
  return result;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((value): value is string => typeof value === 'string')
    : [];
}
function stateFor(
  values: Record<string, unknown>,
  messages: Message[],
): ContextState {
  const state: ContextState = {
    prunedIds: stringList(values._circle_pruned_tool_ids),
    stripThinkingIds: stringList(values._circle_strip_thinking_ids),
    offloaded: {},
  };
  const event = constructorData(values._summarization_event);
  if (
    isRecord(event) &&
    typeof event.cutoff_index === 'number' &&
    event.cutoff_index > 0 &&
    event.summary_message
  ) {
    const summary = fromLegacyMessage(legacyRecord(event.summary_message));
    const cutoff = messages[event.cutoff_index - 1];
    if (!cutoff) throw new Error('invalid legacy summary boundary');
    state.summary = { cutoffMessageId: cutoff.id, text: summary.content };
  }
  return state;
}
export function reconstructLegacy(
  rows: LegacyCheckpointRow[],
  writes: LegacyWriteRow[],
): LegacySnapshot[] {
  const byId = new Map(rows.map((row) => [row.checkpoint_id, row]));
  const updates = new Map<string, LegacyWriteRow[]>();
  for (const row of writes.filter((row) => row.channel === 'messages'))
    updates.set(row.checkpoint_id, [
      ...(updates.get(row.checkpoint_id) ?? []),
      row,
    ]);
  for (const rows of updates.values())
    rows.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.idx - b.idx);
  const messages = new Map<string, LegacyMessage[]>();
  const snapshots = new Map<string, LegacySnapshot>();
  for (const row of [...rows].sort((a, b) =>
    a.checkpoint_id.localeCompare(b.checkpoint_id),
  )) {
    if (row.parent_checkpoint_id && !messages.has(row.parent_checkpoint_id))
      throw new Error('legacy checkpoint ancestor is missing or out of order');
    const checkpoint = decodeLegacy(row.type, row.checkpoint);
    if (!isRecord(checkpoint))
      throw new Error('legacy checkpoint is not an object');
    const values = isRecord(checkpoint.channel_values)
      ? checkpoint.channel_values
      : {};
    let current: LegacyMessage[];
    if (Object.hasOwn(values, 'messages')) {
      const seed = unwrapSnapshot(values.messages);
      current = seed === null ? [] : mergeMessages([], seed);
    } else {
      current = row.parent_checkpoint_id
        ? [...messages.get(row.parent_checkpoint_id)!]
        : [];
      for (const write of updates.get(row.parent_checkpoint_id || '') ?? [])
        current = mergeMessages(current, decodeLegacy(write.type, write.value));
    }
    const native = current.map((message, index) =>
      fromLegacyMessage(message, index),
    );
    messages.set(row.checkpoint_id, current);
    const timestamp =
      typeof checkpoint.ts === 'string' ? Date.parse(checkpoint.ts) : NaN;
    snapshots.set(row.checkpoint_id, {
      id: row.checkpoint_id,
      parent: row.parent_checkpoint_id,
      messages: native,
      context: stateFor(values, native),
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    });
  }
  return [...snapshots.values()];
}
export function readLegacyPlans(
  home: string,
  alreadyImported = new Set<string>(),
): {
  plans: LegacyImportPlan[];
  errors: MigrationReport['errors'];
  skipped: string[];
} {
  home = circleHome(home);
  const skipped: string[] = [];
  const indexPath = join(home, 'sessions.sqlite');
  const checkpointsPath = join(home, 'checkpoints.sqlite');
  if (!existsSync(indexPath) || !existsSync(checkpointsPath))
    return { plans: [], errors: [], skipped };
  const index = new DatabaseSync(indexPath, { readOnly: true });
  const db = new DatabaseSync(checkpointsPath, { readOnly: true });
  const plans: LegacyImportPlan[] = [];
  const errors: MigrationReport['errors'] = [];
  try {
    index.exec('BEGIN');
    db.exec('BEGIN');
    const sessions = index
      .prepare('SELECT * FROM sessions ORDER BY updated DESC')
      .all() as unknown as LegacySessionInfo[];
    const labelsExist = Boolean(
      index
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='labels'",
        )
        .get(),
    );
    for (const session of sessions) {
      try {
        const sourceKey = hash(
          indexPath + '\n' + checkpointsPath + '\n' + session.thread_id,
        );
        if (alreadyImported.has(sourceKey)) {
          skipped.push(session.thread_id);
          continue;
        }
        const allRows = db
          .prepare(
            'SELECT * FROM checkpoints WHERE thread_id = ? ORDER BY checkpoint_ns, checkpoint_id',
          )
          .all(session.thread_id) as unknown as LegacyCheckpointRow[];
        const allWrites = db
          .prepare(
            'SELECT * FROM writes WHERE thread_id = ? ORDER BY checkpoint_ns, checkpoint_id, task_id, idx',
          )
          .all(session.thread_id) as unknown as LegacyWriteRow[];
        const rows = allRows.filter((row) => row.checkpoint_ns === '');
        const writes = allWrites.filter((row) => row.checkpoint_ns === '');
        if (!rows.length) throw new Error('legacy session has no checkpoints');
        const labels = labelsExist
          ? Object.fromEntries(
              index
                .prepare(
                  'SELECT message_id, label FROM labels WHERE thread_id = ?',
                )
                .all(session.thread_id)
                .map((row) => [String(row.message_id), String(row.label)]),
            )
          : {};
        const raw = {
          session,
          labels,
          checkpoints: allRows.map((row) => ({
            ...row,
            checkpoint: Buffer.from(row.checkpoint).toString('base64'),
            metadata:
              row.metadata === null
                ? null
                : typeof row.metadata === 'string'
                  ? row.metadata
                  : Buffer.from(row.metadata).toString('base64'),
          })),
          writes: allWrites.map((row) => ({
            ...row,
            value: Buffer.from(row.value).toString('base64'),
          })),
        };
        const serialized = JSON.stringify(raw);
        const fingerprint = hash(serialized);
        const folder = join(home, 'migration-backups');
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const archive = join(
          folder,
          sourceKey.slice(0, 24) + '-' + fingerprint.slice(0, 16) + '.json',
        );
        if (!existsSync(archive))
          writeFileSync(archive, serialized + '\n', {
            mode: 0o600,
            flag: 'wx',
          });
        const snapshots = reconstructLegacy(rows, writes);
        let selected = session.leaf || rows.at(-1)!.checkpoint_id;
        if (!snapshots.some((snapshot) => snapshot.id === selected))
          throw new Error('legacy selected checkpoint is missing');
        if (!session.leaf) {
          const pending = writes.filter(
            (write) =>
              write.checkpoint_id === selected && write.channel === 'messages',
          );
          if (pending.length) {
            const base = snapshots.find(
              (snapshot) => snapshot.id === selected,
            )!;
            let records: LegacyMessage[] = base.messages.map(
              (message) => message.legacy_data!,
            );
            for (const write of pending)
              records = mergeMessages(
                records,
                decodeLegacy(write.type, write.value),
              );
            const current = records.map((record, index) =>
              fromLegacyMessage(record, index),
            );
            const key = selected + '#pending';
            snapshots.push({
              ...base,
              id: key,
              parent: selected,
              messages: current,
            });
            selected = key;
          }
        }
        plans.push({
          sourceKey,
          session,
          snapshots,
          selected,
          labels,
          receipt: {
            format: 1,
            source: checkpointsPath,
            thread: session.thread_id,
            rows: rows.length,
            writes: writes.length,
            fingerprint,
            archive,
          },
        });
      } catch (error) {
        errors.push({
          thread: session.thread_id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    index.exec('ROLLBACK');
    db.exec('ROLLBACK');
    return { plans, errors, skipped };
  } finally {
    index.close();
    db.close();
  }
}
