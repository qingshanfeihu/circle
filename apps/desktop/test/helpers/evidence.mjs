import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function sourceEvidence() {
  const root = fileURLToPath(new URL('../../../..', import.meta.url));
  const files = [];
  async function walk(folder) {
    for (const entry of await readdir(join(root, folder), {
      withFileTypes: true,
    })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|mjs|css|json|html)$/.test(path)) files.push(path);
    }
  }
  for (const folder of [
    'apps/workbench/src',
    'apps/workbench/test',
    'apps/desktop/src',
    'apps/desktop/test',
    'apps/desktop/scripts',
  ])
    await walk(folder);
  for (const path of [
    'apps/workbench/package.json',
    'apps/workbench/package-lock.json',
    'apps/workbench/tsconfig.json',
    'apps/workbench/vite.config.ts',
    'apps/workbench/index.html',
    'apps/desktop/package.json',
    'apps/desktop/package-lock.json',
    'apps/desktop/tsconfig.json',
    'src/tui/slash_commands.ts',
    'src/ink/theme.ts',
    'docs/tools.md',
    'docs/keybindings.md',
  ])
    files.push(path);
  return Promise.all(
    files.sort().map(async (path) => ({
      path,
      sha256: createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex'),
    })),
  );
}
export async function rendererEvidence(desktopRoot) {
  const root = join(desktopRoot, 'dist');
  const files = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (!path.endsWith('.map')) files.push(path);
    }
  }
  await walk(root);
  return Promise.all(
    files.sort().map(async (path) => ({
      path: relative(root, path).split('\\').join('/'),
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    })),
  );
}
