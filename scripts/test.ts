// `npm test`: the whole suite, through tsx. On CI a failing run goes once more
// with only its failed tests (Node's --test-rerun-failures keeps which tests
// already passed), so a test must fail twice to fail the check. A test that
// passes only the second time is named in the log.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
const files = [
  'tests/*.test.ts',
  'apps/desktop/test/upgrade-notice.test.ts',
  'apps/workbench/test/update-actions.test.ts',
];
const ci = Boolean(process.env.CI && process.env.CI !== 'false');
const extra = process.argv.slice(2);
const state = ci
  ? join(mkdtempSync(join(tmpdir(), 'circle-test-rerun-')), 'state.json')
  : undefined;

let status = 1;
for (let attempt = 1; attempt <= (ci ? 2 : 1); attempt++) {
  if (attempt > 1)
    console.log('# the suite failed; running only its failed tests again');
  const result = spawnSync(
    process.execPath,
    [
      tsx,
      '--test',
      // A test that never settles fails with its name instead of holding
      // the job until the job's own limit.
      ...(ci ? ['--test-timeout=240000'] : []),
      ...(state ? [`--test-rerun-failures=${state}`] : []),
      ...extra,
      ...files,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  status = result.status ?? 1;
  if (status === 0) {
    if (attempt > 1)
      console.log(
        '# passed only when the failed tests ran again: they are flaky',
      );
    break;
  }
}
if (state) rmSync(join(state, '..'), { recursive: true, force: true });
process.exitCode = status;
