import { chmodSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fileInventory,
  targetFor,
  type ReleaseManifest,
} from '../src/install_layout.js';
// A small release directory whose program prints its version, for installer tests.
export function fixture(base: string, version: string): string {
  const root = join(base, 'release-' + version);
  for (const directory of ['runtime', 'app/dist/data', 'app/dist/prompts'])
    mkdirSync(join(root, directory), { recursive: true });
  cpSync(
    process.execPath,
    join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  if (process.platform !== 'win32')
    chmodSync(join(root, 'runtime/node'), 0o755);
  writeFileSync(
    join(root, 'app/package.json'),
    JSON.stringify({ type: 'module', version }),
  );
  writeFileSync(
    join(root, 'app/dist/cli.js'),
    `console.log(${JSON.stringify(version)});`,
  );
  writeFileSync(
    join(root, 'app/dist/install_manager.js'),
    '// fixture manager\n',
  );
  writeFileSync(
    join(root, 'app/dist/data/models_dev.json.gz'),
    'catalog fixture',
  );
  writeFileSync(
    join(root, 'app/dist/data/provider_profiles.json.gz'),
    'profile fixture',
  );
  writeFileSync(
    join(root, 'app/dist/prompts/circle_guidelines.md'),
    'fixture guidelines',
  );
  const manifest: ReleaseManifest = {
    schema: 'circle-release/v1',
    version,
    target: targetFor(),
    nodeVersion: process.versions.node,
    commit: 'a'.repeat(40),
    files: fileInventory(root),
  };
  writeFileSync(join(root, 'release.json'), JSON.stringify(manifest));
  return root;
}
