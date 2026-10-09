// Sets and checks the version and the changelog for a release.
//
//   npm run release -- 1.0.1            set 1.0.1 in the version files and date `## Unreleased`
//   npm run release -- --check 1.0.1    the tag, the version files and the changelog agree
//   npm run release -- --notes 1.0.1    print the changelog section for the release page
//
// It does not commit, tag or push; docs/development/releasing.md has the steps.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareVersions, validVersion } from '../src/version.js';

export class ReleaseError extends Error {}
const FILES = ['package.json', 'package-lock.json', 'src/version.ts'];
const CHANGELOG = 'CHANGELOG.md';
const VERSION_LINE = /^(export const VERSION = ')([^']*)(';)$/m;

export function readVersions(root: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, FILES[0]!), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, FILES[1]!), 'utf8'));
  return {
    'package.json': manifest.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'src/version.ts':
      VERSION_LINE.exec(readFileSync(join(root, FILES[2]!), 'utf8'))?.[2] ?? '',
  };
}
// The body under `## <version>` or `## <version> - <date>`, up to the next `## ` heading.
export function changelogSection(
  text: string,
  version: string,
): string | undefined {
  const lines = text.split('\n');
  const escaped = version.replace(/[.+]/g, '\\$&');
  const start = lines.findIndex((line) =>
    new RegExp(`^## ${escaped}(\\s+-\\s+.*)?$`).test(line),
  );
  if (start < 0) return undefined;
  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith('## '),
  );
  if (end < 0) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}
export function check(root: string, version: string): void {
  const versions = readVersions(root);
  const wrong = Object.entries(versions).filter(
    ([, value]) => value !== version,
  );
  if (wrong.length)
    throw new ReleaseError(
      `the version files do not say ${version}: ` +
        wrong.map(([file, value]) => `${file} has ${value}`).join(', '),
    );
  const section = changelogSection(
    readFileSync(join(root, CHANGELOG), 'utf8'),
    version,
  );
  if (section === undefined)
    throw new ReleaseError(`CHANGELOG.md has no '## ${version}' section`);
  if (!section)
    throw new ReleaseError(
      `the '## ${version}' section of CHANGELOG.md is empty`,
    );
}
function dirty(root: string): string[] {
  if (!existsSync(join(root, '.git'))) return [];
  const result = spawnSync(
    'git',
    ['status', '--porcelain', '--', ...FILES, CHANGELOG],
    { cwd: root, encoding: 'utf8' },
  );
  return (result.stdout || '').split('\n').filter((line) => line.trim());
}
export function bump(
  root: string,
  version: string,
  today = new Date().toISOString().slice(0, 10),
): void {
  if (!validVersion(version) || version.includes('-') || version.includes('+'))
    throw new ReleaseError(`'${version}' is not a version like 1.0.1`);
  const versions = new Set(Object.values(readVersions(root)));
  if (versions.size !== 1)
    throw new ReleaseError(
      `the version files disagree: ${[...versions].join(', ')}`,
    );
  const current = [...versions][0]!;
  let log = readFileSync(join(root, CHANGELOG), 'utf8');
  // The files may already name a version that has never been released (1.0.0 was set by hand).
  if (
    compareVersions(version, current) < 0 ||
    (compareVersions(version, current) === 0 &&
      changelogSection(log, version) !== undefined)
  )
    throw new ReleaseError(`${version} is not newer than ${current}`);
  const changed = dirty(root);
  if (changed.length)
    throw new ReleaseError(
      'these files have uncommitted changes; commit them first:\n  ' +
        changed.join('\n  '),
    );
  const heading = /^## Unreleased[ \t]*$/m.exec(log);
  if (!heading)
    throw new ReleaseError("CHANGELOG.md has no '## Unreleased' section");
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(log.slice(after));
  const body = next ? log.slice(after, after + next.index) : log.slice(after);
  if (!body.trim())
    throw new ReleaseError(
      'the Unreleased section of CHANGELOG.md is empty; nothing to release',
    );
  log =
    log.slice(0, heading.index) +
    `## Unreleased\n\n## ${version} - ${today}` +
    log.slice(after);
  writeFileSync(join(root, CHANGELOG), log);
  for (const file of ['package.json', 'package-lock.json']) {
    const path = join(root, file);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    value.version = version;
    if (file === 'package-lock.json') value.packages[''].version = version;
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  }
  const source = join(root, 'src/version.ts');
  writeFileSync(
    source,
    readFileSync(source, 'utf8').replace(VERSION_LINE, `$1${version}$3`),
  );
}
function main(argv: string[]): number {
  const root = resolve(import.meta.dirname, '..');
  const mode = argv.find((arg) => arg === '--check' || arg === '--notes');
  const version = argv.find((arg) => !arg.startsWith('--'))?.replace(/^v/, '');
  if (!version) {
    process.stderr.write('usage: release [--check|--notes] X.Y.Z\n');
    return 2;
  }
  try {
    if (mode === '--check') {
      check(root, version);
      process.stdout.write(`ok: ${version}\n`);
    } else if (mode === '--notes') {
      const section = changelogSection(
        readFileSync(join(root, CHANGELOG), 'utf8'),
        version,
      );
      if (section === undefined)
        throw new ReleaseError(`CHANGELOG.md has no '## ${version}' section`);
      process.stdout.write(section + '\n');
    } else {
      bump(root, version);
      process.stdout.write(
        `Set ${version} in ${FILES.join(', ')} and ${CHANGELOG}.\n\n` +
          'Read the diff, run the tests, then:\n\n' +
          `  git add ${FILES.join(' ')} ${CHANGELOG}\n` +
          `  git commit -m "Release ${version}"\n` +
          `  git tag v${version}\n` +
          `  git push origin main v${version}\n\n` +
          'The push of the tag starts the release workflow.\n',
      );
    }
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error;
    process.stderr.write(`release: ${error.message}\n`);
    return 1;
  }
  return 0;
}
if (resolve(process.argv[1] ?? '') === import.meta.filename)
  process.exit(main(process.argv.slice(2)));
