import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const COLOR_PARAMS = new Set([
  ...[30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
  ...[40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
  ...[90, 91, 92, 93, 94, 95, 96, 97],
  ...[100, 101, 102, 103, 104, 105, 106, 107],
]);
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(folder, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(folder, entry.name)]
        : [],
  );
}

test('colours come only from the palette: no hex value or colour SGR outside src/ink/theme.ts', () => {
  const found: string[] = [];
  for (const path of sources('src')) {
    const name = relative('src', path).split('\\').join('/');
    if (name === 'ink/theme.ts') continue;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (/['"`]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?['"`]/.test(line))
          found.push(`${name}:${index + 1}: hex colour`);
        for (const match of line.matchAll(
          /(?:\\x1b|\\u001b|\\033)\[([0-9;]*)m/g,
        ))
          if (
            match[1]!
              .split(';')
              .some((param) => COLOR_PARAMS.has(Number(param)))
          )
            found.push(`${name}:${index + 1}: colour code ${match[0]}`);
      });
  }
  assert.deepEqual(found, []);
});
