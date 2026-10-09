import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { decode, encode, ExtData } from '@msgpack/msgpack';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CheckpointStore } from '../src/checkpoint_store.js';
import {
  readLegacyPlans,
  reconstructLegacy,
  type LegacyCheckpointRow,
} from '../src/legacy_sessions.js';
import { migrateLegacy } from '../src/migration.js';
import { decodeLegacy } from '../src/legacy_codec.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { fromJsonl, toJsonl } from '../src/session_export.js';
import { toSessionBundle } from '../src/session_export.js';
import { scratch, cleanup } from './helpers.js';
const digest = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
interface Truth {
  selected: string;
  snapshots: {
    id: string;
    parent: string | null;
    next: string[];
    values: { messages?: unknown[] };
  }[];
}
function fixture(t: Parameters<typeof scratch>[0]): {
  home: string;
  truth: Truth;
} {
  const home = scratch(t);
  const root = 'tests/fixtures/legacy-baseline';
  const manifest = JSON.parse(
    readFileSync(join(root, 'manifest.json'), 'utf8'),
  ) as { files: { name: string; sha256: string }[] };
  for (const file of manifest.files) {
    const bytes = gunzipSync(readFileSync(join(root, file.name + '.gz')));
    assert.equal(digest(bytes), file.sha256);
    writeFileSync(join(home, file.name), bytes);
  }
  return {
    home,
    truth: JSON.parse(readFileSync(join(home, 'truth.json'), 'utf8')),
  };
}
test('MessagePack migration reproduces every snapshot from the actual Python reader without executing constructors', (t) => {
  const { home, truth } = fixture(t);
  const read = readLegacyPlans(home);
  assert.deepEqual(read.errors, []);
  assert.equal(read.plans.length, 1);
  const plan = read.plans[0]!;
  assert.equal(plan.snapshots.length, truth.snapshots.length);
  for (const snapshot of plan.snapshots) {
    const original = truth.snapshots.find((item) => item.id === snapshot.id)!;
    assert.deepEqual(
      snapshot.messages.map((message) => message.legacy_data),
      original.values.messages ?? [],
    );
  }
  assert.equal(plan.selected, truth.selected);
  assert.equal(plan.labels['user-first'], 'original label');
  const first = plan.snapshots.find((item) => item.id === plan.selected)!;
  assert.equal(first.messages[3]!.thinking, 'synthetic reasoning');
  assert.equal(
    (first.messages[3]!.provider_content?.[0] as { signature: string })
      .signature,
    'synthetic signature',
  );
  const descriptor = new ExtData(
    2,
    encode(['subprocess', 'run', { args: ['must-not-execute'] }]),
  );
  const decoded = decodeLegacy('msgpack', encode(descriptor));
  assert.deepEqual(decoded, {
    __legacy_type__: 2,
    module: 'subprocess',
    name: 'run',
    args: { args: ['must-not-execute'] },
  });
  assert.throws(() => decodeLegacy('pickle', new Uint8Array()), /unsupported/);
});
test('migration retains branches and selected leaf, saves receipts, stays idempotent and does not alter the original databases', (t) => {
  const { home, truth } = fixture(t);
  const sourceFiles = ['checkpoints.sqlite', 'sessions.sqlite'];
  const original = sourceFiles.map((file) =>
    digest(readFileSync(join(home, file))),
  );
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  const read = readLegacyPlans(home);
  const plan = read.plans[0]!;
  assert.deepEqual(migrateLegacy(home, store), {
    imported: ['circle-legacy-main'],
    skipped: [],
    errors: [],
  });
  const selected = store.messages('circle-legacy-main');
  assert.deepEqual(
    selected.map((message) => message.legacy_data),
    truth.snapshots.find((snapshot) => snapshot.id === truth.selected)!.values
      .messages,
  );
  assert.equal(
    store.labels('circle-legacy-main')['user-first'],
    'original label',
  );
  for (const snapshot of plan.snapshots)
    assert.deepEqual(
      store
        .messages(
          'circle-legacy-main',
          store.legacyHead(plan.sourceKey, snapshot.id),
        )
        .map((message) => message.legacy_data),
      snapshot.messages.map((message) => message.legacy_data),
    );
  assert.ok(
    store
      .tree('circle-legacy-main')
      .some((node) => node.message.content === 'branch A answer'),
  );
  assert.ok(
    store
      .tree('circle-legacy-main')
      .some((node) => node.message.content === 'branch B answer'),
  );
  assert.equal(
    store.messages('circle-legacy-main').at(-1)!.content,
    'first answer',
  );
  const count = store.tree('circle-legacy-main').length;
  assert.deepEqual(migrateLegacy(home, store), {
    imported: [],
    skipped: ['circle-legacy-main'],
    errors: [],
  });
  assert.equal(store.tree('circle-legacy-main').length, count);
  assert.equal(store.migrationReceipts().length, 1);
  assert.deepEqual(
    sourceFiles.map((file) => digest(readFileSync(join(home, file)))),
    original,
  );
  const archive = String(store.migrationReceipts()[0]!.archive);
  const raw = JSON.parse(readFileSync(archive, 'utf8')) as {
    checkpoints: { checkpoint: string }[];
  };
  const source = new DatabaseSync(join(home, 'checkpoints.sqlite'), {
    readOnly: true,
  });
  cleanup(t, () => source.close());
  const rows = source
    .prepare('SELECT checkpoint FROM checkpoints ORDER BY checkpoint_id')
    .all();
  assert.deepEqual(
    raw.checkpoints.map((row) => Buffer.from(row.checkpoint, 'base64')),
    rows.map((row) => Buffer.from(row.checkpoint as Uint8Array)),
  );
  store.delete('circle-legacy-main');
  assert.deepEqual(migrateLegacy(home, store).skipped, ['circle-legacy-main']);
  assert.equal(store.list().length, 0);
});
test('runtime automatically discovers legacy sessions and does not replay historical tools when continued in another workspace', async (t) => {
  const { home } = fixture(t);
  const workspace = scratch(t);
  const model = new ScriptedModel([
    {
      message: {
        id: 'new-answer',
        role: 'assistant',
        content: 'continued without replay',
      },
    },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: defaultSettings(),
    model,
    session: 'circle-legacy-main',
    headless: true,
  });
  cleanup(t, () => runtime.close());
  assert.equal(runtime.migration.imported.length, 1);
  const original = runtime.store.get('circle-legacy-main')!;
  assert.notEqual(runtime.session.id, original.id);
  await runtime.harness.run('continue');
  assert.equal(model.requests.length, 1);
  assert.ok(
    model.requests[0]!.messages.some(
      (message) =>
        message.role === 'tool' &&
        message.content.includes('synthetic legacy result'),
    ),
  );
  assert.equal(
    runtime.store.messages(original.id).at(-1)!.content,
    'first answer',
  );
});
test('legacy inline snapshots, overwrites and removals are reconstructed without inventing messages', () => {
  const message = (id: string, content: string) =>
    new ExtData(
      5,
      encode([
        'langchain_core.messages.human',
        'HumanMessage',
        { id, type: 'human', content, additional_kwargs: {} },
        'model_validate_json',
      ]),
    );
  const row = (
    id: string,
    parent: string | null,
    channel_values: Record<string, unknown>,
  ): LegacyCheckpointRow => ({
    thread_id: 'fixture',
    checkpoint_ns: '',
    checkpoint_id: id,
    parent_checkpoint_id: parent,
    type: 'msgpack',
    checkpoint: encode({ channel_values, ts: '2026-10-08T00:00:00Z' }),
    metadata: null,
  });
  const rows = [
    row('1', null, { messages: [message('u1', 'old')] }),
    row('2', '1', {}),
    row('3', '2', { messages: new ExtData(7, encode([message('u2', 'new')])) }),
  ];
  const writes = [
    {
      thread_id: 'fixture',
      checkpoint_ns: '',
      checkpoint_id: '1',
      task_id: 'task',
      idx: 0,
      channel: 'messages',
      type: 'msgpack',
      value: encode([
        new ExtData(
          2,
          encode([
            'langchain_core.messages.modifier',
            'RemoveMessage',
            { id: 'u1', type: 'remove', content: '' },
          ]),
        ),
      ]),
    },
  ];
  const snapshots = reconstructLegacy(rows, writes);
  assert.deepEqual(
    snapshots.map((snapshot) =>
      snapshot.messages.map((message) => message.content),
    ),
    [['old'], [], ['new']],
  );
});
test('native and version-one exports preserve signed blocks, system messages and complete repeated-call rounds', () => {
  const legacy = [
    {
      type: 'system',
      data: { id: 'system', content: 'instructions', additional_kwargs: {} },
    },
    {
      type: 'ai',
      data: {
        id: 'ai',
        content: [
          { type: 'thinking', thinking: 'signed', signature: 'signature' },
          { type: 'text', text: 'answer' },
        ],
        additional_kwargs: {},
      },
    },
  ];
  const imported = fromJsonl(
    legacy.map((value) => JSON.stringify(value)).join('\n'),
  );
  assert.equal(imported.messages[0]!.role, 'system');
  assert.equal(
    (imported.messages[1]!.provider_content?.[0] as { signature: string })
      .signature,
    'signature',
  );
  const messages = [
    {
      id: 'a1',
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'reused', name: 'read', args: {} }],
    },
    { id: 't1', role: 'tool' as const, content: 'one', tool_call_id: 'reused' },
    {
      id: 'a2',
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id: 'reused', name: 'read', args: {} }],
    },
    { id: 't2', role: 'tool' as const, content: 'two', tool_call_id: 'reused' },
  ];
  const text = toJsonl(messages, {
    thread_id: 'test',
    title: '',
    workspace: '',
    model: '',
  });
  assert.deepEqual(fromJsonl(text).messages, messages);
});
test('different context states with identical message snapshots remain distinct after migration', (t) => {
  const { home } = fixture(t);
  const plan = readLegacyPlans(home).plans[0]!;
  const selected = plan.snapshots.find(
    (snapshot) => snapshot.id === plan.selected,
  )!;
  const changed = {
    ...selected,
    id: 'synthetic-context-change',
    parent: selected.id,
    context: { ...selected.context, prunedIds: ['result-marker'] },
  };
  const store = new CheckpointStore(scratch(t));
  cleanup(t, () => store.close());
  store.importLegacy({
    ...plan,
    snapshots: [...plan.snapshots, changed],
    selected: changed.id,
  });
  const before = store.legacyHead(plan.sourceKey, selected.id)!;
  const after = store.legacyHead(plan.sourceKey, changed.id)!;
  assert.notEqual(before, after);
  assert.deepEqual(
    store.messages(plan.session.thread_id, before),
    store.messages(plan.session.thread_id, after),
  );
  assert.deepEqual(
    store.contextState(plan.session.thread_id, before).prunedIds,
    [],
  );
  assert.deepEqual(
    store.contextState(plan.session.thread_id, after).prunedIds,
    ['result-marker'],
  );
});
test('failed imports roll back whole sessions and do not overwrite a colliding native session', (t) => {
  const { home } = fixture(t);
  const plan = readLegacyPlans(home).plans[0]!;
  const store = new CheckpointStore(scratch(t));
  cleanup(t, () => store.close());
  assert.throws(
    () => store.importLegacy({ ...plan, selected: 'missing' }),
    /selected checkpoint/,
  );
  assert.equal(store.list().length, 0);
  assert.equal(store.migrationReceipts().length, 0);
  const session = store.create(
    home,
    'native',
    'native original',
    plan.session.thread_id,
  );
  store.append(session.id, [
    { id: 'native', role: 'user', content: 'native data' },
  ]);
  assert.throws(() => store.importLegacy(plan), /conflicts/);
  assert.equal(store.messages(session.id)[0]!.content, 'native data');
  assert.equal(store.migrationReceipts().length, 0);
});
test('legacy child namespaces restore every native snapshot as owned records, augment earlier root imports and never resurrect deleted data', (t) => {
  const { home } = fixture(t);
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  assert.deepEqual(migrateLegacy(home, store).errors, []);
  // Add child scopes after the root marker exists, exercising upgrades from earlier builds.
  const db = new DatabaseSync(join(home, 'checkpoints.sqlite'));
  try {
    for (const namespace of ['task:parent', 'task:parent|task:child']) {
      db.prepare(
        "INSERT INTO checkpoints SELECT thread_id, ?, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata FROM checkpoints WHERE checkpoint_ns=''",
      ).run(namespace);
      db.prepare(
        "INSERT INTO writes SELECT thread_id, ?, checkpoint_id, task_id, idx, channel, type, value FROM writes WHERE checkpoint_ns=''",
      ).run(namespace);
    }
  } finally {
    db.close();
  }
  const before = ['sessions.sqlite', 'checkpoints.sqlite'].map((file) =>
    digest(readFileSync(join(home, file))),
  );
  const read = readLegacyPlans(
    home,
    store.importedLegacyKeys(),
    new Set(store.list(undefined, true).map((session) => session.id)),
  );
  assert.deepEqual(read.errors, []);
  assert.equal(read.plans.length, 2);
  const report = migrateLegacy(home, store);
  assert.deepEqual(report.errors, []);
  assert.equal(report.imported.length, 2);
  assert.equal(store.list().length, 1);
  const child = store.children('circle-legacy-main')[0]!;
  const nested = store.children(child.id)[0]!;
  assert.ok(nested);
  assert.equal(store.list(undefined, true).length, 3);
  for (const plan of read.plans)
    for (const snapshot of plan.snapshots)
      assert.deepEqual(
        store.messages(
          plan.session.thread_id,
          store.legacyHead(plan.sourceKey, snapshot.id),
        ),
        snapshot.messages,
      );
  assert.equal(
    fromJsonl(toSessionBundle(store, 'circle-legacy-main')).graph!.sessions
      .length,
    3,
  );
  assert.deepEqual(
    ['sessions.sqlite', 'checkpoints.sqlite'].map((file) =>
      digest(readFileSync(join(home, file))),
    ),
    before,
  );
  assert.deepEqual(migrateLegacy(home, store).imported, []);
  store.delete(child.id);
  assert.equal(store.get(nested.id), undefined);
  assert.deepEqual(migrateLegacy(home, store).imported, []);
  assert.equal(store.children('circle-legacy-main').length, 0);
  store.delete('circle-legacy-main');
  assert.deepEqual(migrateLegacy(home, store).imported, []);
  assert.equal(store.list(undefined, true).length, 0);
});
