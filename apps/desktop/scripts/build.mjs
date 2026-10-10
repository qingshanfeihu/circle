import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: [join(root, 'src/preload.ts')],
  outfile: join(dist, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
});
await cp(join(root, '../workbench/dist'), join(dist, 'renderer'), {
  recursive: true,
});
await cp(join(root, 'assets'), join(dist, 'assets'), { recursive: true });
const svg = await readFile(join(root, 'assets/circle.svg'), 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } })
  .render()
  .asPng();
await writeFile(join(dist, 'assets/circle.png'), png);
const icoPng = new Resvg(svg, { fitTo: { mode: 'width', value: 256 } })
  .render()
  .asPng();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(icoPng.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile(join(dist, 'assets/circle.ico'), Buffer.concat([ico, icoPng]));
if (process.platform === 'darwin') {
  const icons = join(dist, 'circle.iconset');
  await mkdir(icons);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await writeFile(
        join(icons, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
        new Resvg(svg, { fitTo: { mode: 'width', value: size * scale } })
          .render()
          .asPng(),
      );
  execFileSync('iconutil', [
    '-c',
    'icns',
    icons,
    '-o',
    join(dist, 'assets/circle.icns'),
  ]);
  await rm(icons, { recursive: true, force: true });
}
await import('./notices.mjs');
console.log('Built native main/preload and bundled local renderer');
