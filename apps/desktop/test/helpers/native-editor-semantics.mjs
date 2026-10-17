// Supplemental journey: the main editor driver already verifies definition,
// multi-file semantic rename and unsaved diagnostics. Never launches an app.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { patience } from './patience.mjs';
import { saveWithShortcut } from './native-editor-save.mjs';
export const nativeEditorFormatShortcut = (platform = process.platform) =>
  platform === 'linux' ? 'Control+Shift+i' : 'Alt+Shift+f';
const file = 'editor-supplement.ts';
// Explicit module scope prevents unrelated script fixtures from redeclaring value.
const initial = 'const value=1;\nconsole.log(value);\nexport {};\n';
export async function createNativeEditorSemanticsFixture(workspace) {
  await writeFile(join(workspace, file), initial, { flag: 'wx' });
  return { file };
}
export async function runNativeEditorSemantics({
  page,
  workspace,
  sessionId,
  output,
  assertDevToolsClosed,
}) {
  const checks = [];
  const observed = {};
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const disk = () => readFile(join(workspace, file), 'utf8');
  assert.equal(await disk(), initial);
  const call = (method, params) =>
    page.evaluate(
      async ({ sessionId, method, params }) => {
        const reply = await window.circleDesktop.runtimeCommand({
          id: crypto.randomUUID(),
          name: 'workspace-service',
          sessionId,
          payload: {
            service: 'language',
            method: 'request',
            params: { method, ...params },
          },
        });
        if (!reply.ok) throw Error(reply.error);
        return reply.data;
      },
      { sessionId, method, params },
    );
  const until = async (condition, label) => {
    const end = Date.now() + patience(15000);
    while (Date.now() < end) {
      if (await condition()) return;
      await page.waitForTimeout(30);
    }
    throw Error(label);
  };
  try {
    if (process.platform === 'linux')
      assert.equal(
        typeof assertDevToolsClosed,
        'function',
        'Linux native journey must inspect actual Electron DevTools state',
      );
    await assertDevToolsClosed?.();
    const refs = await call('references', { path: file, line: 1, column: 8 });
    observed.references = refs;
    assert(refs.some((r) => r.path === file && r.range.startLineNumber === 1));
    assert(refs.some((r) => r.path === file && r.range.startLineNumber === 2));
    checks.push('actual declaration and usage references');
    const draft = 'const object = { member: 1 };\nobject.';
    const completion = await call('completion', {
      path: file,
      content: draft,
      line: 2,
      column: 8,
    });
    assert(completion.some((c) => c.label === 'member'));
    assert.equal(await disk(), initial, 'unsaved completion cannot write disk');
    checks.push('completion reads an unsaved object member');
    const entry = page
      .locator('.file-tree')
      .getByRole('button', { name: file, exact: true });
    if (!(await entry.isVisible()))
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
    await entry.click();
    await page
      .locator('.file-view-heading strong')
      .getByText(file, { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'edit', exact: true }).click();
    const lines = page.locator('.native-code-editor .view-lines').first();
    await until(
      async () => (await lines.textContent()).includes('console.log'),
      'correct supplemental model',
    );
    await lines.click();
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.press('ArrowLeft');
    for (let n = 0; n < 12; n++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.insertText('2');
    await until(
      async () =>
        (await lines.textContent())
          .replaceAll('\u00a0', ' ')
          .includes('value=2'),
      'range replacement must update selected digit',
    );
    await page.getByText('unsaved changes', { exact: true }).waitFor();
    assert.equal(
      await disk(),
      initial,
      'range replacement stays in buffer until save',
    );
    // Monaco binds document format differently on Linux.
    await page.keyboard.press(nativeEditorFormatShortcut());
    await assertDevToolsClosed?.();
    await until(
      async () =>
        (await lines.textContent())
          .replaceAll('\u00a0', ' ')
          .includes('value = 2'),
      'format shortcut applies real language edits',
    );
    await assertDevToolsClosed?.();
    await saveWithShortcut(
      page,
      modifier,
      async () =>
        (await disk()) ===
        'const value = 2;\nconsole.log(value);\nexport { };\n',
      'range replacement and format save exact expected disk bytes',
    );
    checks.push('native range replacement and formatting save exact content');
    if (output) {
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: join(output, 'editor-semantics.png') });
    }
    return { checks, final: await disk() };
  } catch (error) {
    if (output) {
      await mkdir(output, { recursive: true });
      await page
        .screenshot({ path: join(output, 'editor-semantics-failure.png') })
        .catch(() => {});
      await writeFile(
        join(output, 'editor-semantics-failure.json'),
        JSON.stringify(
          { checks, observed, error: String(error), disk: await disk() },
          null,
          2,
        ),
      );
    }
    throw error;
  }
}
