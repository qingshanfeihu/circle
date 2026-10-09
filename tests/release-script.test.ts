import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bump,
  changelogSection,
  check,
  readVersions,
} from '../scripts/release.js';
import { scratch } from './helpers.js';

function project(base: string, version: string, unreleased: string): string {
  const root = join(base, 'project');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'circle', version }, null, 2) + '\n',
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify(
      {
        name: 'circle',
        version,
        packages: { '': { name: 'circle', version } },
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(root, 'src/version.ts'),
    `export const VERSION = '${version}';\nexport const other = 1;\n`,
  );
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    `# Changelog\n\n## Unreleased\n${unreleased}\n## 0.5.0 - 2026-10-08\n\n- Python.\n`,
  );
  return root;
}

test('the release script sets every version file, dates the changelog and checks what a tag needs', (t) => {
  const root = project(scratch(t), '1.0.0', '\n- Rewritten in TypeScript.\n');
  // The files name 1.0.0 before it was ever released: that is allowed once.
  bump(root, '1.0.0', '2026-10-10');
  assert.deepEqual(
    new Set(Object.values(readVersions(root))),
    new Set(['1.0.0']),
  );
  const log = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /## Unreleased\n\n## 1\.0\.0 - 2026-10-10\n\n- Rewritten/);
  assert.equal(changelogSection(log, '1.0.0'), '- Rewritten in TypeScript.');
  check(root, '1.0.0');
  assert.throws(() => check(root, '1.0.1'), /do not say 1\.0\.1/);
  assert.throws(() => bump(root, '1.0.0'), /not newer/);
  assert.throws(() => bump(root, '1.0.1'), /Unreleased section .* is empty/);
  assert.match(
    readFileSync(join(root, 'src/version.ts'), 'utf8'),
    /export const other = 1;/,
  );
});

test('the release script refuses an older version, disagreeing files and a section without lines', (t) => {
  const root = project(scratch(t), '1.0.0', '\n- Change.\n');
  assert.throws(() => bump(root, '0.9.0'), /not newer/);
  assert.throws(() => bump(root, '1.1'), /not a version/);
  writeFileSync(
    join(root, 'src/version.ts'),
    "export const VERSION = '0.9.0';\n",
  );
  assert.throws(() => bump(root, '1.0.1'), /disagree/);
  assert.throws(() => check(root, '1.0.0'), /src\/version\.ts has 0\.9\.0/);
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    '## Unreleased\n\n## 1.0.0 - 2026-10-10\n\n## 0.5.0\n- x\n',
  );
  writeFileSync(
    join(root, 'src/version.ts'),
    "export const VERSION = '1.0.0';\n",
  );
  assert.throws(
    () => check(root, '1.0.0'),
    /section of CHANGELOG\.md is empty/,
  );
});

test('the release script prints the notes for the release page from the command line', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/release.ts', '--notes', 'v0.5.0'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^### Added\n\n- \*\*Background jobs\.\*\*/);
});
