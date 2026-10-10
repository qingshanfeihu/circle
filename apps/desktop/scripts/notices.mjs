import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const renderer = join(root, '../workbench');
const lock = JSON.parse(
  await readFile(join(renderer, 'package-lock.json'), 'utf8'),
);
const entries = [];
for (const [relative, record] of Object.entries(lock.packages)) {
  if (!relative || record.dev || !relative.startsWith('node_modules/'))
    continue;
  const folder = join(renderer, relative);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  const files = (await readdir(folder)).filter((name) =>
    /^(license|licence|copying|notice)(\.|$)/i.test(name),
  );
  const texts = [];
  for (const file of files) {
    try {
      texts.push(await readFile(join(folder, file), 'utf8'));
    } catch {}
  }
  entries.push(
    `## ${metadata.name} ${metadata.version}\n\nLicense: ${metadata.license ?? 'see package'}\n${metadata.repository ? JSON.stringify(metadata.repository) : ''}\n\n${texts.join('\n\n')}`,
  );
}
await mkdir(join(root, 'dist'), { recursive: true });
await writeFile(
  join(root, 'dist/FRONTEND_NOTICES.md'),
  '# Frontend dependency notices\n\nDependencies bundled into the Circle workbench renderer. Electron includes its own notices in the application bundle.\n\n' +
    entries.join('\n\n---\n\n') +
    '\n',
);
console.log('Collected ' + entries.length + ' frontend dependency notices');
