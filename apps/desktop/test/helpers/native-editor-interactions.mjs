// Invoked by the serialized native driver on its existing isolated application.
// All language interactions below originate in the visible editor keyboard UI.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patience } from './patience.mjs';
export const interactionFile = 'editor-keyboard-interactions.ts';
export const interactionSource =
  'const referenceTarget = 1;\nconsole.log(referenceTarget);\nexport {};\n';
export async function createNativeEditorInteractionsFixture(workspace) {
  await writeFile(join(workspace, interactionFile), interactionSource, {
    flag: 'wx',
  });
  return { file: interactionFile };
}
export async function runNativeEditorInteractions({ page, workspace, output }) {
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const disk = () => readFile(join(workspace, interactionFile), 'utf8');
  const observed = {};
  const until = async (predicate, label) => {
    const deadline = Date.now() + patience(15000);
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(30);
    }
    throw Error(label);
  };
  const frame = async (name) => {
    if (!output) return;
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, `${name}.png`) });
  };
  try {
    assert.equal(await disk(), interactionSource);
    const entry = page.locator('.file-tree').getByRole('button', {
      name: interactionFile,
      exact: true,
    });
    if (!(await entry.isVisible()))
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
    await entry.click();
    await page
      .locator('.file-view-heading strong')
      .getByText(interactionFile, {
        exact: true,
      })
      .waitFor();
    await page.getByRole('button', { name: 'edit', exact: true }).click();
    const lines = page.locator('.native-code-editor .view-lines').first();
    const text = async () =>
      (await lines.textContent()).replaceAll('\u00a0', ' ');
    await until(
      async () => (await text()).includes('const referenceTarget'),
      'actual fixture body must load before keyboard navigation',
    );
    await lines.click();
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+F12');
    const references = page.locator('.reference-zone-widget');
    await references.waitFor({ state: 'visible' });
    // One module, two locations: require the actual declaration and usage rows,
    // not merely the title or a language-service result delivered out of band.
    const declaration = references.locator('.monaco-list-row').filter({
      hasText: 'const referenceTarget = 1;',
    });
    const usage = references.locator('.monaco-list-row').filter({
      hasText: 'console.log(referenceTarget);',
    });
    await declaration.waitFor({ state: 'visible' });
    await usage.waitFor({ state: 'visible' });
    observed.references = await references.innerText();
    await frame('native-editor-reference-widget');
    await usage.click();
    await page.keyboard.press('Escape');
    assert.equal(
      await disk(),
      interactionSource,
      'references cannot edit disk',
    );
    await lines.click();
    await page.keyboard.press(`${modifier}+a`);
    const draft =
      'const object = { uniqueMember: 42, uniqueOther: 7 };\nobject.uni';
    await page.keyboard.insertText(draft);
    await until(
      async () => (await text()).includes('object.uni'),
      'actual unsaved completion prefix must reach Monaco',
    );
    await page.getByText('unsaved changes', { exact: true }).waitFor();
    await page.keyboard.press('Control+Space');
    const suggestion = page
      .locator('.suggest-widget.visible .monaco-list-row')
      .filter({ hasText: 'uniqueMember' });
    await suggestion.waitFor({ state: 'visible' });
    await page
      .locator('.suggest-widget.visible .monaco-list-row')
      .filter({ hasText: 'uniqueOther' })
      .waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('.suggest-widget.visible .monaco-list-row').count(),
      2,
      'arrow selection requires multiple actual offers',
    );
    observed.suggestion = await suggestion.innerText();
    await frame('native-editor-completion-widget');
    // Monaco intentionally lets arrows move the editor for one focused offer.
    // Two real prefix matches exercise suggestion navigation before acceptance.
    // Never insert the expected completion.
    await page.keyboard.press('ArrowDown');
    await page
      .locator('.suggest-widget.visible .monaco-list-row.focused')
      .filter({ hasText: 'uniqueOther' })
      .waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowUp');
    await page
      .locator('.suggest-widget.visible .monaco-list-row.focused')
      .filter({ hasText: 'uniqueMember' })
      .waitFor({ state: 'visible' });
    await page.keyboard.press('Enter');
    await until(
      async () => (await text()).includes('object.uniqueMember'),
      'keyboard acceptance must insert the actual offered member',
    );
    assert.equal(
      await disk(),
      interactionSource,
      'accepted completion stays unsaved',
    );
    await page.keyboard.press(`${modifier}+s`);
    const expected =
      'const object = { uniqueMember: 42, uniqueOther: 7 };\nobject.uniqueMember';
    await until(
      async () => (await disk()) === expected,
      'accepted completion must save exact disk bytes',
    );
    observed.final = await disk();
    await frame('native-editor-interactions-final');
    return {
      checks: [
        'actual references UI shows declaration and usage',
        'actual completion popup keyboard acceptance and exact saved bytes',
      ],
      observed,
    };
  } catch (error) {
    observed.error = String(error);
    observed.disk = await disk().catch(String);
    observed.focus = await page
      .evaluate(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
      }))
      .catch(String);
    await frame('native-editor-interactions-failure').catch(() => {});
    if (output)
      await writeFile(
        join(output, 'editor-interactions-failure.json'),
        JSON.stringify(observed, null, 2),
      );
    throw error;
  }
}
