import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

test('the version is the same in package.json, package-lock.json and src/version.ts', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[''].version, VERSION);
});
