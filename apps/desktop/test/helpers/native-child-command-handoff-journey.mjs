import { commandLineOf, runsUnder } from './process-tree.mjs';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import { assertRenderedTerminalMatch } from './native-terminal-rendered-match.mjs';

export const childCommandParentPrompt =
  'NATIVE_CHILD_COMMAND_HANDOFF: delegate one owned interactive command';
export const childCommandTaskPrompt =
  'NATIVE_CHILD_COMMAND_WORKER: preserve the original PTY identity';
export const childCommandTaskId = 'native-child-command-worker';
export const childCommandToolCallId = 'native-child-handoff-execute';
export const childCommandInput = 'NATIVE_CHILD_HANDOFF_INPUT\r';
const acceptance =
  'Inspect original child process identity and parent draft continuity';
const files = {
  source: 'native-child-command-handoff.cjs',
  pid: 'native-child-command-pid',
  starts: 'native-child-command-starts',
  input: 'native-child-command-input',
};
const answer = (id, content, tool_calls) => ({
  message: {
    id,
    role: 'assistant',
    content,
    ...(tool_calls ? { tool_calls } : {}),
  },
});
const readSource = (id) => ({
  id,
  name: 'read_file',
  args: { file_path: files.source },
});

/** Commit these explicit files to the synthetic repository before creating child worktrees. */
export async function createNativeChildCommandHandoffFixture(
  workspace,
  nodePath,
) {
  const source = `const fs=require('node:fs');\nfs.appendFileSync('${files.starts}','once\\n');\nfs.writeFileSync('${files.pid}',String(process.pid));\nif(process.stdin.isTTY)process.stdin.setRawMode(true);\nlet line='';process.stdin.on('data',bytes=>{fs.appendFileSync('${files.input}',bytes);line+=bytes.toString();if(/[\\r\\n]/.test(line)){process.stdout.write('CHILD_HANDOFF_ECHO:'+line);line='';}});\nprocess.stdin.resume();\nconsole.log('CHILD_HANDOFF_READY '+process.pid);\nsetInterval(()=>{},1000);\n`;
  await writeFile(join(workspace, files.source), source, { flag: 'wx' });
  return {
    files: [files.source],
    source,
    paths: { ...files },
    nodePath,
    parentPrompt: childCommandParentPrompt,
    taskPrompt: childCommandTaskPrompt,
    taskId: childCommandTaskId,
    toolCallId: childCommandToolCallId,
    routes: [
      {
        id: 'native-child-command-parent',
        match: { role: 'parent', firstUser: childCommandParentPrompt },
        replies: [
          answer('native-child-delegate', '', [
            {
              id: 'native-child-parent-enqueue',
              name: 'native_tasks_enqueue',
              args: {
                operationId: 'native-child-command-enqueue',
                tasks: [
                  {
                    id: childCommandTaskId,
                    prompt: childCommandTaskPrompt,
                    access: 'write',
                    acceptanceCriteria: [acceptance],
                  },
                ],
              },
            },
          ]),
          answer(
            'native-child-parent-finished',
            'The owned child is scheduled. Its original command remains addressable from its agent card.',
          ),
        ],
      },
      {
        id: 'native-child-command-worker',
        match: {
          role: 'worker',
          taskPrompt: childCommandTaskPrompt,
          access: 'write',
        },
        replies: [
          answer('native-child-command-call', '', [
            readSource('native-child-worker-read'),
            {
              id: childCommandToolCallId,
              name: 'execute',
              args: {
                command:
                  (process.platform === 'win32' ? '' : 'exec ') +
                  journeyNodeCommand(nodePath, files.source).trimEnd(),
                timeout: 600,
                background: false,
              },
            },
          ]),
          answer(
            'native-child-command-finished',
            'The original child command stopped; inspect the actual persisted command receipt and stdin bytes.',
          ),
        ],
      },
      {
        id: 'native-child-command-reviewer',
        match: {
          role: 'reviewer',
          taskPrompt: childCommandTaskPrompt,
          access: 'write',
        },
        replies: [
          answer('native-child-review-read', '', [
            readSource('native-child-reviewer-read'),
          ]),
          answer(
            'native-child-review-result',
            JSON.stringify({
              checks: [
                {
                  criterion: acceptance,
                  status: 'needs_review',
                  evidence:
                    'Source inspection alone cannot confirm native keyboard input and the parent draft. The human native journey must inspect those effects.',
                  sources: [{ path: files.source, line: 1 }],
                },
              ],
            }),
          ),
        ],
      },
    ],
  };
}
const save = (output, name, value) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2));
// Windows soon gives a finished process's id to a new process, so a live id
// is the old child only while that process still runs the fixture's script.
const gone = async (pid) => !(await commandLineOf(pid))?.includes(files.source);
const optionalRead = (workspace, file) =>
  readFile(join(workspace, file), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
const composer = (page) =>
  page.getByRole('textbox', { name: 'message', exact: true });
const sessionView = (page, id) =>
  page.evaluate(
    (id) =>
      JSON.parse(
        localStorage.getItem('circle.workbench.live.views.v1') ?? '{}',
      ).views?.find((entry) => entry[0] === id)?.[1] ?? {},
    id,
  );
async function call(
  page,
  sessionId,
  service,
  method,
  params = {},
  requireSuccess = true,
) {
  const reply = await page.evaluate(
    ({ sessionId, service, method, params }) =>
      window.circleDesktop.runtimeCommand({
        id: crypto.randomUUID(),
        name: 'workspace-service',
        sessionId,
        payload: { service, method, params },
      }),
    { sessionId, service, method, params },
  );
  if (requireSuccess) assert.equal(reply.ok, true, JSON.stringify(reply));
  return requireSuccess ? reply.data : reply;
}
async function selectParent(page, id, state, until) {
  await page
    .locator(`.sidebar .session-link[href="#/session/${id}"]`)
    .first()
    .click();
  await until(
    async () => (await state()).activeSessionId === id,
    'the true parent conversation is selected',
  );
  const main = page
    .locator('.agent-record:visible')
    .getByRole('button', { name: 'main', exact: true });
  if (await main.isVisible()) await main.click();
  await composer(page).waitFor();
}
async function openAgent(page, parentId, agentId, state) {
  const snapshot = await state();
  assert.equal(snapshot.activeSessionId, parentId);
  const agent = snapshot.agents.find(
    (item) => item.id === agentId && item.sessionId === parentId,
  );
  assert(
    agent && agent.resourceSessionId === agentId,
    'the original parent maps a real child resource session',
  );
  const groups = page.locator('.main-stack .conversation:visible .tool-group');
  await groups.first().waitFor();
  for (const group of await groups.all())
    if (
      (await group
        .locator(':scope > .tool-summary')
        .getAttribute('aria-expanded')) !== 'true'
    )
      await group.locator(':scope > .tool-summary').click();
  const link = page
    .locator('.main-stack .tool-agent-links button')
    .filter({ has: page.getByText(agent.name, { exact: true }) });
  await link.waitFor();
  assert.equal(
    await link.count(),
    1,
    'the original task tool card owns exactly this agent entry',
  );
  await link.click();
  const record = page.locator('.agent-record:visible');
  await record.getByText(agent.id, { exact: true }).waitFor();
  return { agent, record };
}
async function commandCard(page, record) {
  const card = record
    .locator('.tool-call')
    .filter({ has: page.locator('.tool-head code[title="execute"]') });
  assert.equal(await card.count(), 1);
  const head = card.locator('.tool-head');
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click();
  return card;
}
async function approve(page, ownerId, callId, state, until) {
  await until(
    async () =>
      (await state()).interactions.some(
        (item) =>
          item.sessionId === ownerId &&
          item.callId === callId &&
          item.kind === 'approval' &&
          item.status === 'pending',
      ),
    'the actual owner requests its original approval',
  );
  assert.equal(
    (await state()).activeSessionId,
    ownerId,
    'approvals are answered only from their real conversation',
  );
  await page.getByRole('button', { name: 'allow once', exact: true }).click();
}

/** UI performs scheduling, approval, child navigation, typing and stop; RPC observes ownership or tests a denied boundary. */
export async function runNativeChildCommandHandoffJourney({
  page,
  workspace,
  parentSessionId: returnSessionId,
  state,
  until,
  output,
  fixture,
}) {
  const receipt = {
    status: 'running',
    checks: [],
    scope:
      'real delegated write worker PTY plus a distinct readonly reviewer; no fabricated readonly worker permission',
  };
  const originalDraft = await composer(page).inputValue();
  let ownerId,
    worker,
    target,
    stopped = false;
  try {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'new session', exact: true })
      .click();
    const home = page.locator('.home:visible');
    await home.waitFor();
    await home
      .getByRole('textbox', { name: 'message', exact: true })
      .fill(childCommandParentPrompt);
    await home
      .getByRole('button', { name: 'send message', exact: true })
      .click();
    await until(async () => {
      ownerId = (await state()).activeSessionId;
      return ownerId && ownerId !== returnSessionId;
    }, 'the delegated command has its own original parent conversation');
    await approve(page, ownerId, 'native-child-parent-enqueue', state, until);
    await until(async () => {
      worker = (await call(page, ownerId, 'tasks', 'list')).find(
        (task) => task.spec.id === childCommandTaskId,
      );
      return worker?.runtimeSessionId && worker.worktree;
    }, 'real task attempt binds its worker session and worktree');
    assert.equal(worker.spec.sessionId, ownerId);
    assert.equal(worker.spec.access, 'write');
    assert.notEqual(worker.runtimeSessionId, ownerId);
    assert.notEqual(await realpath(worker.worktree), await realpath(workspace));
    const parentDraft = 'NATIVE_CHILD_PARENT_UNSENT_DRAFT';
    await composer(page).fill(parentDraft);
    await until(
      async () => (await sessionView(page, ownerId)).draft === parentDraft,
      'parent unsent draft is durably present in the original composer',
    );
    let opened = await openAgent(page, ownerId, worker.runtimeSessionId, state);
    assert.equal(
      opened.agent.readOnly,
      false,
      'the write worker does not pretend to have readonly source authority',
    );
    await opened.record
      .getByRole('button', { name: 'open task conversation', exact: true })
      .click();
    await until(
      async () => (await state()).activeSessionId === worker.runtimeSessionId,
      'approval navigation selects the real child session',
    );
    await approve(
      page,
      worker.runtimeSessionId,
      childCommandToolCallId,
      state,
      until,
    );
    let pid;
    await until(async () => {
      pid = Number(await optionalRead(worker.worktree, fixture.paths.pid));
      return Number.isSafeInteger(pid) && pid > 0;
    }, 'the actual child process records its own PID');
    assert.equal(
      await optionalRead(workspace, fixture.paths.pid),
      '',
      'the same command never ran in the parent workspace',
    );
    assert.equal(
      await optionalRead(worker.worktree, fixture.paths.starts),
      'once\n',
    );
    await selectParent(page, ownerId, state, until);
    assert.equal(await composer(page).inputValue(), parentDraft);
    opened = await openAgent(page, ownerId, worker.runtimeSessionId, state);
    target = (
      await call(page, ownerId, 'terminal', 'resolveCommand', {
        sourceSessionId: worker.runtimeSessionId,
        toolCallId: childCommandToolCallId,
      })
    ).target;
    assert(target, 'real child execute receipt resolves');
    assert.equal(target.executionSessionId, worker.runtimeSessionId);
    const card = await commandCard(page, opened.record);
    await card
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const terminal = page.locator('.native-terminal:visible');
    const surface = terminal.locator(`#terminal-${target.terminal.id}:visible`);
    await surface.waitFor();
    const listing = await call(page, ownerId, 'terminal', 'command', {
      target,
      action: 'list',
    });
    assert.equal(listing.available, true);
    assert.equal(listing.value.length, 1);
    // The card's process is the command's root; the program runs as it or under it.
    assert.ok(
      await runsUnder(pid, listing.value[0].managedCommand.commandPid),
      `${pid} runs under command root ${listing.value[0].managedCommand.commandPid}`,
    );
    assert.equal(listing.value[0].id, target.terminal.id);
    assert.equal(listing.capabilities.input, true);
    await surface.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(childCommandInput.slice(0, -1));
    await page.keyboard.press('Enter');
    await until(
      async () =>
        (await optionalRead(worker.worktree, fixture.paths.input)) ===
        childCommandInput,
      'the original child process receives exact native keyboard bytes',
    );
    receipt.inputEvidence = {
      childInput: await optionalRead(worker.worktree, fixture.paths.input),
      childStarts: await optionalRead(worker.worktree, fixture.paths.starts),
      originalCommandPid: pid,
      terminalCols: listing.value[0].cols,
    };
    receipt.displayEvidence = await assertRenderedTerminalMatch({
      panel: terminal,
      surface,
      text: 'CHILD_HANDOFF_ECHO:' + childCommandInput.trimEnd(),
      until,
    });
    assert.equal(await optionalRead(workspace, fixture.paths.input), '');
    assert.equal((await sessionView(page, ownerId)).draft, parentDraft);
    await page.screenshot({
      path: join(output, 'child-command-handoff-live.png'),
    });
    await terminal
      .getByRole('button', { name: 'stop terminal', exact: true })
      .click();
    await until(async () => {
      const result = await call(page, ownerId, 'terminal', 'command', {
        target,
        action: 'list',
      });
      const end = result.value?.[0];
      return (
        result.available &&
        end &&
        (await gone(pid)) &&
        end.managedCommand.completion.rootExit &&
        end.managedCommand.completion.controlledGroupEmpty &&
        end.managedCommand.completion.transportAndLogClosed
      );
    }, 'the child root, controlled group and PTY/log really close');
    stopped = true;
    await until(async () => {
      worker = (await call(page, ownerId, 'tasks', 'list')).find(
        (task) => task.spec.id === childCommandTaskId,
      );
      return (
        worker?.state === 'needs_review' &&
        worker.reviewers?.some((item) => item.sessionId)
      );
    }, 'the true independent reviewer finishes at a human review boundary');
    const reviewer = worker.reviewers[0];
    assert.notEqual(reviewer.sessionId, worker.runtimeSessionId);
    await opened.record
      .getByRole('button', { name: 'main', exact: true })
      .click();
    opened = await openAgent(page, ownerId, reviewer.sessionId, state);
    assert.equal(opened.agent.task.role, 'reviewer');
    assert.equal(opened.agent.readOnly, true);
    const source = opened.record
      .locator('.tool-call')
      .filter({ has: page.locator('.tool-head code[title="read_file"]') });
    assert.equal(await source.count(), 1);
    const sourceHead = source.locator('.tool-head');
    if ((await sourceHead.getAttribute('aria-expanded')) !== 'true')
      await sourceHead.click();
    await source
      .getByRole('button', { name: 'open file', exact: true })
      .click();
    const file = page.locator('.file-view:visible');
    await file.locator('.file-source-readonly').waitFor();
    assert.equal(
      await file.getByRole('button', { name: 'save', exact: true }).isEnabled(),
      false,
    );
    const doc = await call(page, reviewer.sessionId, 'documents', 'read', {
      path: fixture.paths.source,
    });
    assert.equal(doc.content.replace(/\r\n/g, '\n'), fixture.source);
    const denied = await call(
      page,
      reviewer.sessionId,
      'documents',
      'save',
      {
        path: fixture.paths.source,
        content: 'DENIED_REVIEWER_SAVE',
        expectedRevision: doc.revision,
      },
      false,
    );
    assert.equal(denied.ok, false);
    assert.match(denied.error, /read-only agent source/);
    // A reviewer worktree is a Git checkout, which writes CRLF on Windows.
    const text = async (root) =>
      (await readFile(join(root, fixture.paths.source), 'utf8')).replace(
        /\r\n/g,
        '\n',
      );
    assert.equal(await text(reviewer.workspace), fixture.source);
    assert.equal(await text(workspace), fixture.source);
    await page.screenshot({
      path: join(output, 'child-command-readonly-reviewer-source.png'),
    });
    await page.getByRole('button', { name: 'close file', exact: true }).click();
    await opened.record
      .getByRole('button', { name: 'main', exact: true })
      .click();
    assert.equal(await composer(page).inputValue(), parentDraft);
    assert.equal(
      await optionalRead(worker.worktree, fixture.paths.starts),
      'once\n',
    );
    Object.assign(receipt, {
      status: 'passed',
      ownerId,
      workerSessionId: worker.runtimeSessionId,
      reviewerSessionId: reviewer.sessionId,
      childWorktree: worker.worktree,
      target,
      pid,
      parentDraft,
      paths: fixture.paths,
      stopped,
      taskId: childCommandTaskId,
      source: fixture.source,
    });
    receipt.checks.push(
      'original native_tasks tool card opens its actual child',
      'approval uses the real child conversation',
      'same original child PTY receives exact native bytes once',
      'parent unsent draft and same-name parent files remain unchanged',
      'distinct real readonly reviewer source rejects saving',
    );
    return receipt;
  } catch (error) {
    Object.assign(receipt, {
      status: 'failed',
      error: String(error),
      ownerId,
      worker,
      target,
    });
    await page
      .screenshot({ path: join(output, 'child-command-handoff-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    receipt.stopped = stopped;
    if (target && !stopped)
      receipt.cleanup = await call(
        page,
        ownerId,
        'terminal',
        'command',
        { target, action: 'close' },
        false,
      ).catch((error) => ({ error: String(error) }));
    try {
      await selectParent(page, returnSessionId, state, until);
      assert.equal(await composer(page).inputValue(), originalDraft);
      receipt.originalParentDraftPreserved = true;
    } finally {
      await save(output, 'child-command-handoff-receipt.json', receipt);
    }
  }
}

/** Call after the driver's existing real application quit/relaunch, not a renderer reload. */
export async function runNativeChildCommandAfterRestart({
  page,
  parentSessionId: returnSessionId,
  state,
  until,
  output,
  previous,
}) {
  assert.equal(
    previous.status,
    'passed',
    'live child handoff must pass before restart history',
  );
  const receipt = {
    status: 'running',
    actualAppRestartRequired: true,
    priorTarget: previous.target,
  };
  const returnDraft = await composer(page).inputValue();
  try {
    assert(await gone(previous.pid), 'the original child process remains gone');
    await selectParent(page, previous.ownerId, state, until);
    assert.equal(await composer(page).inputValue(), previous.parentDraft);
    const opened = await openAgent(
      page,
      previous.ownerId,
      previous.workerSessionId,
      state,
    );
    const resolution = await call(
      page,
      previous.ownerId,
      'terminal',
      'resolveCommand',
      {
        sourceSessionId: previous.workerSessionId,
        toolCallId: childCommandToolCallId,
      },
    );
    assert.equal(resolution.available, true);
    assert.deepEqual(resolution.target, previous.target);
    assert.deepEqual(resolution.capabilities, {
      read: true,
      input: false,
      stop: false,
      addToDraft: false,
    });
    await (
      await commandCard(page, opened.record)
    )
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const terminal = page.locator('.native-terminal:visible');
    const surface = terminal.locator(
      `#terminal-${previous.target.terminal.id}:visible`,
    );
    await surface.waitFor();
    receipt.displayEvidence = await assertRenderedTerminalMatch({
      panel: terminal,
      surface,
      text: 'CHILD_HANDOFF_ECHO:' + childCommandInput.trimEnd(),
      until,
    });
    assert.equal(
      await terminal
        .getByRole('button', { name: 'restart terminal', exact: true })
        .isEnabled(),
      false,
    );
    assert.equal(
      await terminal
        .getByRole('button', { name: 'stop terminal', exact: true })
        .isEnabled(),
      false,
    );
    const denied = await call(
      page,
      previous.ownerId,
      'terminal',
      'command',
      {
        target: resolution.target,
        action: 'write',
        params: { data: 'MUST_NOT_RELAUNCH' },
      },
      false,
    );
    assert.equal(
      denied.ok,
      false,
      'the archived parent cannot regain live stdin capability',
    );
    assert(denied.error);
    assert.equal(
      await optionalRead(previous.childWorktree, previous.paths.starts),
      'once\n',
    );
    assert.equal(
      Number(await optionalRead(previous.childWorktree, previous.paths.pid)),
      previous.pid,
    );
    assert.equal(
      await optionalRead(previous.childWorktree, previous.paths.input),
      childCommandInput,
    );
    assert(await gone(previous.pid));
    assert(
      !(await state()).jobs.some(
        (job) =>
          job.sessionId === previous.workerSessionId &&
          ['running', 'stopping'].includes(job.state),
      ),
    );
    Object.assign(receipt, {
      status: 'passed',
      pidGone: true,
      noNewProcess: true,
      startCount: 1,
      sameTarget: true,
    });
    await page.screenshot({
      path: join(output, 'child-command-after-app-restart-readonly.png'),
    });
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'child-command-restart-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    try {
      await selectParent(page, returnSessionId, state, until);
      assert.equal(await composer(page).inputValue(), returnDraft);
    } finally {
      await save(output, 'child-command-restart-receipt.json', receipt);
    }
  }
}
