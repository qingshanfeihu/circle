import { runsUnder } from './process-tree.mjs';
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { journeyNodeCommand } from './native-journey-platform.mjs';
import { assertRenderedTerminalMatch } from './native-terminal-rendered-match.mjs';
export const commandHandoffPrompt =
  'NATIVE_COMMAND_HANDOFF: run the owned interactive fixture';
export async function createNativeCommandHandoffFixture(workspace, nodePath) {
  const file = 'native-command-handoff.cjs';
  await writeFile(
    join(workspace, file),
    `const fs=require('node:fs');\nfs.appendFileSync('native-command-starts','once\\n');\nfs.writeFileSync('native-command-pid',String(process.pid));\nif(process.stdin.isTTY)process.stdin.setRawMode(true);\nlet line='';process.stdin.on('data',bytes=>{fs.appendFileSync('native-command-input',bytes);line+=bytes.toString();if(/[\\r\\n]/.test(line)){process.stdout.write('HANDOFF_ECHO:'+line);line='';}});\nprocess.stdin.resume();\nconsole.log('HANDOFF_READY '+process.pid);\nsetInterval(()=>{},1000);\n`,
    { flag: 'wx' },
  );
  return {
    files: [file],
    nodePath,
    route: {
      id: 'native-command-handoff',
      match: { role: 'parent', firstUser: commandHandoffPrompt },
      replies: [
        {
          message: {
            id: 'handoff-call',
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'native-handoff-execute',
                name: 'execute',
                args: {
                  command: journeyNodeCommand(
                    nodePath,
                    join(workspace, file),
                  ).trimEnd(),
                },
              },
            ],
          },
        },
        {
          message: {
            id: 'handoff-finished',
            role: 'assistant',
            content: 'Owned command handoff finished.',
          },
        },
      ],
    },
  };
}
/** Mutations are original UI actions; IPC below only observes the real owner/PTY. */
export async function runNativeCommandHandoffJourney({
  page,
  workspace,
  parentSessionId,
  state,
  until,
  output,
}) {
  const receipt = {
    status: 'running',
    scope:
      'one actual parent-owned command; child ownership and previous-process history are covered separately',
  };
  const draft = await page
    .getByRole('textbox', { name: 'message', exact: true })
    .inputValue();
  let owner,
    target,
    stopped = false;
  const query = async (method, params) => {
    const reply = await page.evaluate(
      ({ sessionId, method, params }) =>
        window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: { service: 'terminal', method, params },
        }),
      { sessionId: owner, method, params },
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    return reply.data;
  };
  const gone = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
  };
  try {
    await page
      .locator('.sidebar')
      .getByRole('button', { name: 'new session', exact: true })
      .click();
    const home = page.locator('.home:visible');
    await home.waitFor();
    const homeMessage = home.getByRole('textbox', {
      name: 'message',
      exact: true,
    });
    await homeMessage.fill(commandHandoffPrompt);
    assert.equal(await homeMessage.inputValue(), commandHandoffPrompt);
    await home
      .getByRole('button', { name: 'send message', exact: true })
      .click();
    await until(async () => {
      owner = (await state()).activeSessionId;
      return owner && owner !== parentSessionId;
    }, 'dedicated command conversation exists');
    await until(async () => {
      const snapshot = await state();
      const pending = snapshot.interactions.filter(
        (item) => item.sessionId === owner && item.status === 'pending',
      );
      if (pending.length) {
        assert.equal(pending.length, 1);
        await page
          .getByRole('button', { name: 'allow once', exact: true })
          .click();
      }
      return readFile(join(workspace, 'native-command-pid'), 'utf8')
        .then(Number)
        .catch((error) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
    }, 'original command approval starts the owned process');
    receipt.observedProcess = {
      pid: Number(
        await readFile(join(workspace, 'native-command-pid'), 'utf8'),
      ),
      starts: await readFile(join(workspace, 'native-command-starts'), 'utf8'),
      workspace,
      ownerSessionId: owner,
    };
    const ownSession = (await state()).sessions.find(
      (item) => item.id === owner,
    );
    assert(ownSession);
    const ownWorkspace = (await state()).workspaces.find(
      (item) => item.id === ownSession.workspaceId,
    );
    assert(ownWorkspace);
    assert.equal(await realpath(ownWorkspace.path), await realpath(workspace));
    const pid = Number(
      await readFile(join(workspace, 'native-command-pid'), 'utf8'),
    );
    assert(Number.isSafeInteger(pid) && pid > 0);
    const resolved = await query('resolveCommand', {
      sourceSessionId: owner,
      toolCallId: 'native-handoff-execute',
    });
    assert.equal(resolved.available, true, JSON.stringify(resolved));
    target = resolved.target;
    assert.equal(target.executionSessionId, owner);
    assert.equal(target.toolCallId, 'native-handoff-execute');
    const groups = page.locator('.main-stack .conversation .tool-group');
    await groups.waitFor({ state: 'visible' });
    assert.equal(
      await groups.count(),
      1,
      'the dedicated conversation has its one original command group',
    );
    const groupSummary = groups.locator(':scope > .tool-summary');
    if ((await groupSummary.getAttribute('aria-expanded')) !== 'true')
      await groupSummary.click();
    const card = groups.locator('.tool-call').filter({
      has: page
        .locator('.tool-target')
        .filter({ hasText: 'native-command-handoff.cjs' }),
    });
    assert.equal(await card.count(), 1);
    const head = card.locator('.tool-head');
    if ((await head.getAttribute('aria-expanded')) !== 'true')
      await head.click();
    await card
      .getByRole('button', { name: 'open in terminal', exact: true })
      .click();
    const terminal = page.locator('.native-terminal:visible');
    const observed = async () => {
      const result = await query('command', {
        target,
        action: 'list',
        params: {},
      });
      assert.equal(result.available, true);
      assert.equal(result.value.length, 1);
      return result.value[0];
    };
    const before = await observed();
    assert.equal(before.id, target.terminal.id);
    // The card's process is the command's root; the program runs as it or under it.
    assert.ok(
      await runsUnder(pid, before.managedCommand.commandPid),
      `${pid} runs under command root ${before.managedCommand.commandPid}`,
    );
    assert.equal(
      await readFile(join(workspace, 'native-command-starts'), 'utf8'),
      'once\n',
    );
    const surface = terminal.locator(`#terminal-${target.terminal.id}:visible`);
    await surface.waitFor();
    const textarea = surface.locator(
      '.xterm-helper-textarea:visible:not([readonly])',
    );
    // The command's input opens once its capabilities arrive.
    await textarea.first().waitFor();
    assert.equal(
      await textarea.count(),
      1,
      'only the resolved original command has a writable visible input',
    );
    await textarea.focus();
    const input = 'NATIVE_HANDOFF_INPUT';
    await page.keyboard.type(input);
    await page.keyboard.press('Enter');
    await until(
      async () =>
        (
          await readFile(join(workspace, 'native-command-input'), 'utf8').catch(
            () => '',
          )
        ).includes(input),
      'the original process receives real native keyboard input',
    );
    receipt.displayEvidence = await assertRenderedTerminalMatch({
      panel: terminal,
      surface,
      text: 'HANDOFF_ECHO:' + input,
      until,
    });
    await page.screenshot({ path: join(output, 'command-handoff-live.png') });
    await terminal
      .getByRole('button', { name: 'stop terminal', exact: true })
      .click();
    let final;
    await until(async () => {
      final = await observed();
      return (
        ['exited', 'failed', 'interrupted'].includes(final.status) &&
        gone(pid) &&
        final.managedCommand.completion.rootExit &&
        final.managedCommand.completion.controlledGroupEmpty &&
        final.managedCommand.completion.transportAndLogClosed
      );
    }, 'original managed process and transport fully stop');
    stopped = true;
    await until(
      async () =>
        !(await state()).jobs.some(
          (job) =>
            job.sessionId === owner &&
            ['running', 'stopping'].includes(job.state),
        ),
      'the original registry settles after the stop',
    );
    assert.equal(
      await readFile(join(workspace, 'native-command-starts'), 'utf8'),
      'once\n',
    );
    assert.equal(
      Number(await readFile(join(workspace, 'native-command-pid'), 'utf8')),
      pid,
    );
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
    receipt.owner = owner;
    receipt.target = target;
    receipt.before = before;
    receipt.final = final;
    receipt.pidGone = true;
    receipt.startCount = 1;
    await page.screenshot({
      path: join(output, 'command-handoff-stopped.png'),
    });
    receipt.status = 'passed';
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'command-handoff-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    receipt.stopped = stopped;
    try {
      await page
        .locator(`.sidebar .session-link[href="#/session/${parentSessionId}"]`)
        // The original sidebar deliberately lists the same owner in recent and project sections.
        .first()
        .click();
      await page.waitForFunction(
        (id) => location.hash === '#/session/' + id,
        parentSessionId,
      );
      const parentConversation = page.locator(
        '.main-stack .conversation:visible',
      );
      await parentConversation.waitFor();
      assert.equal(
        await parentConversation
          .getByRole('textbox', { name: 'message', exact: true })
          .inputValue(),
        draft,
      );
      receipt.parentDraftPreserved = true;
    } catch (error) {
      receipt.status = 'failed';
      receipt.returnError = String(error);
      throw error;
    } finally {
      await writeFile(
        join(output, 'command-handoff-receipt.json'),
        JSON.stringify(receipt, null, 2),
      );
    }
  }
}
