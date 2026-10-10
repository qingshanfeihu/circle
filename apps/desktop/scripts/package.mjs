import { createHash } from 'node:crypto';
import { packager } from '@electron/packager';
import { cp, mkdir, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, '.stage');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
await cp(join(root, '../../LICENSE'), join(stage, 'LICENSE'));
await cp(
  join(root, '../../THIRD_PARTY_NOTICES.md'),
  join(stage, 'THIRD_PARTY_NOTICES.md'),
);
await writeFile(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'circle-workbench',
      version: manifest.version,
      main: 'dist/main.cjs',
      description: manifest.description,
      license: 'MIT',
    },
    null,
    2,
  ) + '\n',
);
const platform = process.env.CIRCLE_DESKTOP_PLATFORM ?? process.platform;
const arch = process.env.CIRCLE_DESKTOP_ARCH ?? process.arch;
const paths = await packager({
  dir: stage,
  out: join(root, 'out'),
  name: 'Circle Workbench',
  platform,
  arch,
  electronVersion: manifest.devDependencies.electron,
  appBundleId: 'com.qingshanfeihu.circle.workbench',
  appCategoryType: 'public.app-category.developer-tools',
  icon:
    platform === 'darwin'
      ? join(root, 'dist/assets/circle.icns')
      : platform === 'win32'
        ? join(root, 'dist/assets/circle.ico')
        : join(root, 'dist/assets/circle.png'),
  asar: true,
  overwrite: true,
  prune: false,
});
for (const path of paths) console.log(path);
const artifactPaths = paths.map((path) =>
  platform === 'darwin'
    ? join(path, 'Circle Workbench.app/Contents/Resources/app.asar')
    : join(path, 'resources/app.asar'),
);
if (platform === 'darwin' && process.platform === 'darwin') {
  const image = join(
    root,
    'out',
    `Circle-Workbench-${manifest.version}-${arch}.dmg`,
  );
  const content = join(root, '.stage-dmg');
  await rm(content, { recursive: true, force: true });
  await mkdir(content);
  await cp(
    join(paths[0], 'Circle Workbench.app'),
    join(content, 'Circle Workbench.app'),
    { recursive: true },
  );
  await symlink('/Applications', join(content, 'Applications'));
  await rm(image, { force: true });
  execFileSync(
    'hdiutil',
    [
      'create',
      '-volname',
      'Circle Workbench',
      '-srcfolder',
      content,
      '-ov',
      '-format',
      'UDZO',
      image,
    ],
    { stdio: 'inherit' },
  );
  await rm(content, { recursive: true, force: true });
  artifactPaths.push(image);
  console.log(image);
}
await writeFile(
  join(root, 'out/artifact-receipt.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      version: manifest.version,
      electron: manifest.devDependencies.electron,
      platform,
      arch,
      artifacts: await Promise.all(
        artifactPaths.map(async (path) => ({
          path: relative(join(root, 'out'), path).split('\\').join('/'),
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        })),
      ),
    },
    null,
    2,
  ) + '\n',
);
