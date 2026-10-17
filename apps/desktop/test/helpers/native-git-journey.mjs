// The serialized native suite supplies its existing page. Never launches or focuses another app.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, realpath, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { patience } from './patience.mjs';
const exec = promisify(execFile);
const marker = '.circle-native-git-journey.json';
// filter.has is evaluated relative to each row; do not repeat its panel ancestor.
export function nativeGitFileRow(page, filename) {
  return page.locator('.native-git .change-entry').filter({
    has: page.getByRole('checkbox', { name: filename, exact: true }),
  });
}
const names = {
  first: 'git-journey-manual-first.txt',
  second: 'git-journey-manual-second.txt',
  conflict: 'git-journey-conflict.txt',
  hunks: 'git-journey-hunks.txt',
  unselected: 'git-journey-unselected.txt',
};
const hunkBaseline = Array.from(
  { length: 24 },
  (_, index) => `stable line ${index + 1}\n`,
).join('');
async function scratch(workspace) {
  const root = await realpath(workspace);
  const temp = await realpath(tmpdir());
  assert.ok(
    root.startsWith(temp + path.sep),
    'native Git helper only operates inside its temporary fixture',
  );
  return root;
}
export async function createNativeGitFixture(workspace) {
  await scratch(workspace);
  for (const name of [...Object.values(names), marker])
    await access(path.join(workspace, name)).then(
      () => {
        throw Error('Git fixture path already exists: ' + name);
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
  const id = randomUUID().replaceAll('-', '');
  await writeFile(
    path.join(workspace, marker),
    JSON.stringify({ version: 1, id, names }),
  );
  for (const name of [names.first, names.second, names.conflict])
    await writeFile(path.join(workspace, name), 'baseline\n');
  await writeFile(path.join(workspace, names.hunks), hunkBaseline);
  return { id, ...names };
}
export async function runNativeGitJourney({
  page,
  workspace,
  sessionId,
  output,
}) {
  const root = await scratch(workspace);
  const ownership = JSON.parse(await readFile(path.join(root, marker), 'utf8'));
  assert.equal(ownership.version, 1);
  assert.deepEqual(ownership.names, names);
  assert.match(ownership.id, /^[a-f0-9]{32}$/);
  assert.ok(output, 'Git native journey requires an evidence directory');
  await mkdir(output, { recursive: true });
  const git = async (...args) =>
    (
      await exec('git', ['--literal-pathspecs', '-C', root, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout;
  assert.equal(
    await realpath((await git('rev-parse', '--show-toplevel')).trim()),
    root,
  );
  assert.equal(
    (await git('diff', '--cached', '--name-only')).trim(),
    '',
    'fixture requires an empty index and will not reset other staged changes',
  );
  const origin = await git('remote', 'get-url', 'origin').then(
    (value) => value.trim(),
    () => null,
  );
  assert.equal(origin, null, 'fixture will not replace an existing origin');
  const originalBranch = (await git('symbolic-ref', '--short', 'HEAD')).trim();
  const branch = 'codex/native-git-' + ownership.id;
  const remote = path.join(
    path.resolve(output),
    'native-git-remote-' + ownership.id + '.git',
  );
  await access(remote).then(
    () => {
      throw Error('owned remote already exists');
    },
    (error) => {
      if (error.code !== 'ENOENT') throw error;
    },
  );
  const oldConfig = {};
  for (const key of ['user.name', 'user.email', 'commit.gpgsign'])
    oldConfig[key] = await git('config', '--local', '--get', key).then(
      (value) => value.trimEnd(),
      () => null,
    );
  const call = (service, method, params) =>
    page.evaluate(
      async ({ sessionId, service, method, params }) => {
        const reply = await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: { service, method, params },
        });
        if (!reply.ok) throw Error(reply.error);
        return reply.data;
      },
      { sessionId, service, method, params },
    );
  const until = async (predicate, label) => {
    const deadline = Date.now() + patience(15000);
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(50);
    }
    throw Error('native Git timed out: ' + label);
  };
  const panel = page.locator('.native-git');
  const waitForNativeIdle = async () =>
    until(
      () =>
        panel
          .getByRole('button', { name: 'push branch', exact: true })
          .isEnabled(),
      'native Git operation completed',
    );
  const refresh = async () => {
    const expected = await call('git', 'status', {});
    await panel
      .getByRole('button', { name: 'refresh', exact: true })
      .first()
      .click();
    await until(
      async () =>
        (await panel.getAttribute('aria-busy')) === 'false' &&
        (await panel.getAttribute('data-revision')) === expected.revision &&
        (await panel.getAttribute('data-branch')) === expected.branch,
      'refreshed native branch and revision',
    );
  };
  const snapshot = async (name) =>
    page.screenshot({ path: path.join(output, name + '.png') });
  const select = async (name) => {
    await refresh();
    for (const checkbox of await panel.getByRole('checkbox').all())
      await checkbox.uncheck();
    await panel.getByRole('checkbox', { name, exact: true }).check();
  };
  const commit = async (message, files) => {
    assert.deepEqual(
      (await git('diff', '--cached', '--name-only', '-z'))
        .split('\0')
        .filter(Boolean)
        .sort(),
      [...files].sort(),
      'only explicitly selected paths may reach the commit',
    );
    await panel.getByLabel('commit message', { exact: true }).fill(message);
    await panel
      .getByRole('button', {
        name: 'commit selected',
        exact: true,
      })
      .click();
    await until(
      async () => (await git('log', '-1', '--format=%s')).trim() === message,
      'commit disk effect',
    );
    await waitForNativeIdle();
    assert.deepEqual(
      (await git('show', '--format=', '--name-only', 'HEAD'))
        .trim()
        .split('\n')
        .sort(),
      [...files].sort(),
    );
  };
  const pushedHeads = [];
  const push = async () => {
    await refresh();
    await panel
      .getByRole('button', { name: 'push branch', exact: true })
      .click();
    await until(async () => {
      const head = (await git('rev-parse', 'HEAD')).trim();
      return (
        (
          await git(
            '--git-dir=' + remote,
            'rev-parse',
            'refs/heads/' + branch,
          ).catch(() => '')
        ).trim() === head
      );
    }, 'local bare receives exact feature head');
    await waitForNativeIdle();
    pushedHeads.push(
      (
        await git('--git-dir=' + remote, 'rev-parse', 'refs/heads/' + branch)
      ).trim(),
    );
  };
  const checks = [];
  let addedOrigin = false;
  let primaryFailure;
  try {
    await git('switch', '-c', branch);
    await git('config', '--local', 'user.name', 'Native Journey');
    await git(
      'config',
      '--local',
      'user.email',
      'native-journey@example.invalid',
    );
    await git('config', '--local', 'commit.gpgsign', 'false');
    await git(
      'add',
      '--',
      names.first,
      names.second,
      names.conflict,
      names.hunks,
    );
    await git('commit', '-m', 'Seed native Git fixture');
    const base = (await git('rev-parse', 'HEAD')).trim();
    await git('init', '--bare', remote);
    await git('remote', 'add', 'origin', remote);
    addedOrigin = true;
    await writeFile(path.join(root, names.first), 'baseline\nMANUAL_FIRST\n');
    await writeFile(
      path.join(root, names.unselected),
      'UNSELECTED_MUST_NOT_COMMIT\n',
    );
    const changesToggle = page.getByRole('button', {
      name: 'changes panel',
      exact: true,
    });
    if ((await changesToggle.getAttribute('aria-pressed')) !== 'true')
      await changesToggle.click();
    await page.locator('#inspector-changes-tab-git').click();
    await panel.waitFor();
    await select(names.first);
    await panel
      .getByRole('button', { name: 'stage selected', exact: true })
      .click();
    await until(
      async () =>
        (await git('diff', '--cached', '--', names.first)).includes(
          'MANUAL_FIRST',
        ),
      'actual first index',
    );
    await snapshot('git-native-first-staged');
    // Exercise the original hunk controls while unrelated selected work is staged.
    const hunkPath = path.join(root, names.hunks);
    // git apply replaces the file, so a read can fall between its removal and
    // the new copy; that is not the result yet.
    const readHunks = () =>
      readFile(hunkPath, 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
    const stagedText = hunkBaseline.replace('stable line 2\n', 'KEEP_STAGED\n');
    await writeFile(
      hunkPath,
      stagedText.replace('stable line 22\n', 'DISCARD_WORKING\n'),
    );
    const showHunks = async (scope) => {
      await refresh();
      await panel.getByRole('button', { name: scope, exact: true }).click();
      await waitForNativeIdle();
      await panel
        .getByRole('button', { name: names.hunks, exact: true })
        .click();
    };
    await showHunks('unstaged');
    await panel
      .locator('.native-git-hunk')
      .filter({ hasText: 'KEEP_STAGED' })
      .getByRole('button', { name: 'stage this hunk', exact: true })
      .click();
    await until(
      async () =>
        (await git('diff', '--cached', '--', names.hunks)).includes(
          'KEEP_STAGED',
        ),
      'real partial staging',
    );
    const preservedIndex = await git('diff', '--cached', '--binary');
    assert.ok(!preservedIndex.includes('DISCARD_WORKING'));
    assert.match(preservedIndex, /MANUAL_FIRST/);
    await showHunks('unstaged');
    page.once('dialog', (dialog) => dialog.accept());
    await panel
      .locator('.native-git-hunk')
      .filter({ hasText: 'DISCARD_WORKING' })
      .getByRole('button', { name: 'discard this hunk', exact: true })
      .click();
    await until(
      async () => (await readHunks()) === stagedText,
      'GUI hunk discard restores only working hunk',
    );
    assert.equal(await git('diff', '--cached', '--binary'), preservedIndex);
    assert.equal(
      await readFile(path.join(root, names.unselected), 'utf8'),
      'UNSELECTED_MUST_NOT_COMMIT\n',
    );
    await snapshot('git-native-hunk-discard-preserves-index');
    await showHunks('staged');
    await panel
      .locator('.native-git-hunk')
      .filter({ hasText: 'KEEP_STAGED' })
      .getByRole('button', { name: 'unstage this hunk', exact: true })
      .click();
    await until(
      async () => (await git('diff', '--cached', '--', names.hunks)) === '',
      'real hunk unstage',
    );
    const firstOnlyIndex = await git('diff', '--cached', '--binary');
    await showHunks('unstaged');
    page.once('dialog', (dialog) => dialog.accept());
    await panel
      .locator('.native-git-hunk')
      .filter({ hasText: 'KEEP_STAGED' })
      .getByRole('button', { name: 'discard this hunk', exact: true })
      .click();
    await until(
      async () => (await readHunks()) === hunkBaseline,
      'GUI hunk cleanup',
    );
    assert.equal(await git('diff', '--cached', '--binary'), firstOnlyIndex);
    checks.push(
      'GUI hunk discard restores disk while preserving partial index, staged unrelated file and unselected work',
    );
    await select(names.first);
    await commit('Record first native manual change', [names.first]);
    await push();
    checks.push(
      'native Git first commit contains only its explicit selected path',
    );
    await writeFile(path.join(root, names.second), 'baseline\nMANUAL_SECOND\n');
    await select(names.second);
    await panel
      .getByRole('button', { name: 'stage selected', exact: true })
      .click();
    await until(
      async () =>
        (await git('diff', '--cached', '--', names.second)).includes(
          'MANUAL_SECOND',
        ),
      'actual second index',
    );
    await commit('Record second native manual change', [names.second]);
    assert.match(
      await readFile(path.join(root, names.unselected), 'utf8'),
      /UNSELECTED/,
    );
    assert.equal((await git('ls-files', '--', names.unselected)).trim(), '');
    checks.push(
      'second consecutive GUI commit clears hidden old selections and preserves unselected work',
    );
    await push();
    assert.notEqual(pushedHeads[0], pushedHeads[1]);
    checks.push(
      'native GUI pushes the actual selected feature branch to owned local bare origin',
    );
    const side = branch + '-side';
    await git('switch', '-c', side, base);
    await writeFile(path.join(root, names.conflict), 'SIDE\n');
    await git('add', '--', names.conflict);
    await git('commit', '-m', 'Write side conflict');
    await git('switch', branch);
    await writeFile(path.join(root, names.conflict), 'FEATURE\n');
    await git('add', '--', names.conflict);
    await git('commit', '-m', 'Write feature conflict');
    await assert.rejects(git('merge', side));
    await refresh();
    await panel
      .getByRole('button', { name: 'continue merge', exact: true })
      .waitFor();
    await snapshot('git-native-real-conflict');
    assert.match(
      await readFile(path.join(root, names.conflict), 'utf8'),
      /<<<<<<<[\s\S]*=======/,
    );
    const conflictRow = nativeGitFileRow(page, names.conflict);
    await conflictRow
      .getByRole('button', { name: 'open file', exact: true })
      .click();
    const viewer = page.locator('.file-view');
    await viewer.waitFor();
    await viewer
      .locator('.file-view-filename strong')
      .getByText(names.conflict, { exact: true })
      .waitFor();
    await viewer.getByRole('button', { name: 'edit', exact: true }).click();
    await viewer
      .locator('.monaco-editor .view-lines')
      .last()
      .click({ position: { x: 80, y: 10 } });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('FEATURE\nSIDE\n');
    await viewer.getByText('unsaved changes', { exact: true }).waitFor();
    await viewer.getByRole('button', { name: 'save', exact: true }).click();
    await until(
      async () =>
        // The editor keeps the file's line endings: CRLF where Git wrote it so (Windows).
        (await readFile(path.join(root, names.conflict), 'utf8')).replace(
          /\r\n/g,
          '\n',
        ) === 'FEATURE\nSIDE\n',
      'Monaco conflict save actual disk',
    );
    assert.notEqual(
      (await git('ls-files', '-u')).trim(),
      '',
      'saving alone must not resolve the Git index',
    );
    await snapshot('git-native-monaco-conflict-saved');
    await viewer
      .getByRole('button', { name: 'close file', exact: true })
      .click();
    await select(names.conflict);
    await panel
      .getByRole('button', { name: 'stage selected', exact: true })
      .click();
    await until(
      async () => (await git('ls-files', '-u')).trim() === '',
      'resolved conflict is actually staged',
    );
    await panel
      .getByRole('button', { name: 'continue merge', exact: true })
      .click();
    await until(
      async () =>
        !(await git('rev-parse', '-q', '--verify', 'MERGE_HEAD').then(
          () => true,
          () => false,
        )),
      'native merge continue',
    );
    await waitForNativeIdle();
    assert.equal(
      (await git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')
        .length,
      3,
    );
    assert.equal(
      // Git writes CRLF on Windows (core.autocrlf); the content is what matters.
      (await readFile(path.join(root, names.conflict), 'utf8')).replace(
        /\r\n/g,
        '\n',
      ),
      'FEATURE\nSIDE\n',
    );
    checks.push(
      'real conflict resolves through original file panel Monaco typing and save, GUI staging and merge continue',
    );
    const abortSide = branch + '-abort';
    await git('switch', '-c', abortSide);
    await writeFile(path.join(root, names.conflict), 'ABORT_SIDE\n');
    await git('add', '--', names.conflict);
    await git('commit', '-m', 'Write abort side');
    await git('switch', branch);
    await writeFile(path.join(root, names.conflict), 'ABORT_FEATURE\n');
    await git('add', '--', names.conflict);
    await git('commit', '-m', 'Write abort feature');
    const beforeAbort = (await git('rev-parse', 'HEAD')).trim();
    await assert.rejects(git('merge', abortSide));
    await refresh();
    page.once('dialog', (dialog) => dialog.accept());
    await panel
      .getByRole('button', { name: 'abort merge', exact: true })
      .click();
    await until(
      async () =>
        !(await git('rev-parse', '-q', '--verify', 'MERGE_HEAD').then(
          () => true,
          () => false,
        )),
      'native merge abort',
    );
    await waitForNativeIdle();
    assert.equal((await git('rev-parse', 'HEAD')).trim(), beforeAbort);
    assert.equal(
      // Git writes CRLF on Windows (core.autocrlf); the content is what matters.
      (await readFile(path.join(root, names.conflict), 'utf8')).replace(
        /\r\n/g,
        '\n',
      ),
      'ABORT_FEATURE\n',
    );
    assert.match(
      await readFile(path.join(root, names.unselected), 'utf8'),
      /UNSELECTED/,
    );
    await refresh();
    await snapshot('git-native-aborted-conflict');
    checks.push(
      'native abort restores pre-merge head and conflict file while preserving unselected work',
    );
    const result = {
      checks,
      featureBranch: branch,
      pushedHeads,
      remote,
      remoteHead: (
        await git('--git-dir=' + remote, 'rev-parse', 'refs/heads/' + branch)
      ).trim(),
      currentHead: (await git('rev-parse', 'HEAD')).trim(),
      scope:
        'manual Git through native UI; real Agent task worktrees are verified by the task journey',
    };
    await writeFile(
      path.join(output, 'native-git-journey.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    return result;
  } catch (error) {
    primaryFailure = error;
    // Preserve the actual failed assertion before cleanup can encounter dirty
    // files. Never reset those files just to restore the fixture branch.
    await writeFile(
      path.join(output, 'native-git-failure.json'),
      JSON.stringify(
        {
          error: String(error),
          stack: error?.stack,
          checks,
          pushedHeads,
          branch: await git('branch', '--show-current').catch(String),
          status: await git('status', '--porcelain=v1').catch(String),
          index: await git('diff', '--cached', '--name-status').catch(String),
          firstDiff: await git('diff', '--', names.first).catch(String),
          panel: await panel.innerText().catch(String),
        },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    const cleanupErrors = [];
    const attemptCleanup = async (label, run) => {
      try {
        await run();
      } catch (error) {
        cleanupErrors.push({ label, error: String(error) });
      }
    };
    await attemptCleanup(
      'restore original branch without overwriting dirty files',
      async () => {
        if (
          (await git('symbolic-ref', '--short', 'HEAD').catch(() => ''))
            .trim()
            .startsWith(branch)
        ) {
          if (
            await git('rev-parse', '-q', '--verify', 'MERGE_HEAD').then(
              () => true,
              () => false,
            )
          )
            await git('merge', '--abort');
          await git('switch', originalBranch);
        }
      },
    );
    await attemptCleanup('remove owned fixture remote', async () => {
      if (
        addedOrigin &&
        (await git('remote', 'get-url', 'origin').catch(() => '')).trim() ===
          remote
      )
        await git('remote', 'remove', 'origin');
    });
    for (const [key, value] of Object.entries(oldConfig))
      await attemptCleanup('restore local config ' + key, async () => {
        if (value === null)
          await git('config', '--local', '--unset-all', key).catch((error) => {
            if (error.code !== 5) throw error;
          });
        else await git('config', '--local', key, value);
      });
    if (cleanupErrors.length) {
      await writeFile(
        path.join(output, 'native-git-cleanup-failure.json'),
        JSON.stringify(
          {
            primaryFailure: primaryFailure && String(primaryFailure),
            cleanupErrors,
          },
          null,
          2,
        ) + '\n',
      );
      if (!primaryFailure)
        throw Error(
          'native Git cleanup failed: ' + JSON.stringify(cleanupErrors),
        );
    }
  }
}
