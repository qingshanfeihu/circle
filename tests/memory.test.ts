import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  memorySourcePaths,
  formatMemorySources,
} from '../src/memory_sources.js';
import { buildSystemPrompt } from '../src/system_prompt.js';
import { defaultRunOptions } from '../src/run_options.js';
import { scratch } from './helpers.js';
test('memory discovery follows account, personal and workspace priorities and excludes duplicate instruction identities', (t) => {
  const root = scratch(t);
  const workspace = join(root, 'project');
  const home = join(root, 'data');
  const user = join(root, 'user');
  for (const directory of [
    workspace,
    home,
    join(user, '.agents'),
    join(workspace, '.circle'),
  ])
    mkdirSync(directory, { recursive: true });
  const account = join(home, 'MEMORY.md');
  const personal = join(user, '.agents', 'AGENTS.md');
  const project = join(workspace, 'AGENTS.md');
  const local = join(workspace, '.circle', 'AGENTS.md');
  for (const [path, content] of [
    [account, 'account memory'],
    [personal, 'personal instructions'],
    [project, 'project instructions'],
    [local, 'nested instructions'],
  ])
    writeFileSync(path!, content!);
  assert.deepEqual(
    memorySourcePaths(workspace, home, user),
    [account, personal, project, local].map((path) => realpathSync(path)),
  );
  const text = formatMemorySources(workspace, home, [project], false, user);
  assert.match(text, /account memory/);
  assert.match(text, /personal instructions/);
  assert.ok(!text.includes('project instructions'));
  assert.match(text, /nested instructions/);
  const noContext = formatMemorySources(workspace, home, [], true, user);
  assert.match(noContext, /account memory/);
  assert.ok(!noContext.includes('instructions'));
});
test('real prompt assembly includes account memory once and no-context leaves MEMORY.md available', (t) => {
  const root = scratch(t);
  const workspace = join(root, 'project');
  const home = join(root, 'data');
  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    'unique project instruction marker',
  );
  writeFileSync(join(home, 'MEMORY.md'), 'unique account memory marker');
  const options = defaultRunOptions();
  const first = buildSystemPrompt(
    workspace,
    'test-model',
    'openai',
    options,
    home,
  );
  assert.equal(first.split('unique project instruction marker').length - 1, 1);
  assert.equal(first.split('unique account memory marker').length - 1, 1);
  options.no_context_files = true;
  const second = buildSystemPrompt(
    workspace,
    'test-model',
    'openai',
    options,
    home,
  );
  assert.ok(!second.includes('unique project instruction marker'));
  assert.match(second, /unique account memory marker/);
});
