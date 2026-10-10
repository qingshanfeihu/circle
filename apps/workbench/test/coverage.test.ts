import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SLASH } from '../../../src/tui/slash_commands.ts';
import { COMMAND_UI, PreviewRuntime } from '../src/model/state.ts';
import { BUILTIN_TOOL_INFO } from '../src/model/tool-info.ts';
import { KEY_ACTIONS } from '../src/model/shortcuts.ts';
test('every current Circle command and alias resolves to a frontend action', () => {
  assert.deepEqual(
    Object.keys(COMMAND_UI).sort(),
    BUILTIN_SLASH.map((item) => item.name).sort(),
  );
  for (const command of BUILTIN_SLASH)
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const runtime = new PreviewRuntime();
      const result = runtime.command(name);
      assert.notEqual(
        result.notice?.startsWith('unknown command'),
        true,
        `/${name}`,
      );
    }
});
test('tool catalog is bound to Circle documentation, including subagent-only tools', () => {
  const docs = readFileSync(
    fileURLToPath(new URL('../../../docs/tools.md', import.meta.url)),
    'utf8',
  );
  const names = [...docs.matchAll(/^\| `([^`]+)` \|/gm)].map((item) => item[1]);
  assert.deepEqual(
    BUILTIN_TOOL_INFO.map((item) => item.name).sort(),
    names.sort(),
  );
});
test('all configurable Circle key actions are represented', () => {
  const docs = readFileSync(
    fileURLToPath(new URL('../../../docs/keybindings.md', import.meta.url)),
    'utf8',
  );
  const section = docs
    .split('| Action | Default key |')[1]!
    .split('## Which key wins')[0]!;
  const actions = [...section.matchAll(/^\| `([^`]+)` \|/gm)].map(
    (item) => item[1],
  );
  assert.deepEqual(Object.keys(KEY_ACTIONS).sort(), actions.sort());
});
