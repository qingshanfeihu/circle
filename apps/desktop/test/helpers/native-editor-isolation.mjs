// This regression accepts the suite's existing isolated page. It never launches
// another app or bypasses editor input/save with a document-writing RPC.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { patience } from './patience.mjs';

const files = {
  'isolation-a.ts': 'export const DOCUMENT_A_ONLY = "alpha";\n',
  'isolation-b.md': '# DOCUMENT_B_ONLY\n\nMarkdown beta, not TypeScript.\n',
};
const marker = '.circle-editor-isolation-fixture.json';
export async function createNativeEditorIsolationFixture(workspace) {
  await writeFile(
    join(workspace, marker),
    JSON.stringify({ version: 1, files }),
    { flag: 'wx' },
  );
  for (const [name, text] of Object.entries(files))
    await writeFile(join(workspace, name), text, { flag: 'wx' });
  return Object.keys(files);
}

export async function runNativeEditorIsolation({ page, workspace, output }) {
  const ownership = JSON.parse(await readFile(join(workspace, marker), 'utf8'));
  assert.deepEqual(ownership, { version: 1, files });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const disk = (name) => readFile(join(workspace, name), 'utf8');
  const until = async (condition, label) => {
    const end = Date.now() + patience(15000);
    while (Date.now() < end) {
      if (await condition()) return;
      await page.waitForTimeout(25);
    }
    throw Error(`editor isolation regression: ${label}`);
  };
  const visibleText = () =>
    page
      .locator('.file-view .view-lines')
      .first()
      .evaluate((node) => node.textContent.replaceAll('\u00a0', ' '));
  const open = async (name, expected) => {
    const button = page
      .locator('.file-tree')
      .getByRole('button', { name, exact: true });
    if (!(await button.isVisible()))
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
    await button.click();
    await page
      .locator('.file-view-heading strong')
      .getByText(name, { exact: true })
      .waitFor();
    await until(async () => {
      try {
        return (await visibleText()).includes(expected);
      } catch {
        return false;
      }
    }, `title and body must both belong to ${name}`);
    await page.getByRole('button', { name: 'edit', exact: true }).click();
    await until(
      async () => (await visibleText()).includes(expected),
      `edit mode keeps ${name}'s model`,
    );
  };
  const appendSingleEdit = async (text) => {
    await page.locator('.file-view .view-lines').first().click();
    await page.keyboard.press(`${modifier}+a`);
    await page.keyboard.press('ArrowRight');
    // EditContext applies input asynchronously; confirm the actual buffer before navigation/save.
    await page.keyboard.insertText(text);
    await until(
      async () => (await visibleText()).includes(text.trim()),
      'inserted text reaches the active Monaco model',
    );
    await page.getByText('unsaved changes', { exact: true }).waitFor();
  };
  const save = () => page.keyboard.press(`${modifier}+s`);
  const a = 'isolation-a.ts',
    b = 'isolation-b.md';
  const aMarker = 'DOCUMENT_A_UNSAVED',
    bMarker = 'DOCUMENT_B_SAVED';
  assert.equal(await disk(a), files[a]);
  assert.equal(await disk(b), files[b]);
  await open(a, 'DOCUMENT_A_ONLY');
  await appendSingleEdit(aMarker);
  assert.equal(await disk(a), files[a], 'dirty A must stay off disk');
  await open(b, 'DOCUMENT_B_ONLY');
  assert.doesNotMatch(
    await visibleText(),
    /DOCUMENT_A_ONLY|DOCUMENT_A_UNSAVED/,
  );
  await appendSingleEdit(bMarker);
  await save();
  await until(
    async () => (await disk(b)).includes('DOCUMENT_B_SAVED'),
    'CmdS saves B',
  );
  assert.doesNotMatch(await disk(b), /DOCUMENT_A_ONLY|DOCUMENT_A_UNSAVED/);
  assert.equal(await disk(a), files[a], 'saving B cannot save A');
  await open(a, 'DOCUMENT_A_UNSAVED');
  await page.locator('.file-view .view-lines').first().click();
  await page.keyboard.press(`${modifier}+z`);
  await until(
    async () => !(await visibleText()).includes('DOCUMENT_A_UNSAVED'),
    'A Undo removes its actual buffer edit before saving',
  );
  await save();
  await until(
    async () => (await disk(a)) === files[a],
    'A Undo then CmdS restores exactly A',
  );
  assert.match(await disk(b), /DOCUMENT_B_SAVED/, 'A Undo cannot undo B');
  await open(b, 'DOCUMENT_B_SAVED');
  await page.locator('.file-view .view-lines').first().click();
  await page.keyboard.press(`${modifier}+z`);
  await until(
    async () => !(await visibleText()).includes('DOCUMENT_B_SAVED'),
    'B Undo removes its own edit before saving',
  );
  await save();
  await until(
    async () => (await disk(b)) === files[b],
    'B retains its independent Undo stack',
  );
  await open(a, 'DOCUMENT_A_ONLY');
  await open(b, 'DOCUMENT_B_ONLY');
  assert.equal(await disk(a), files[a]);
  assert.equal(await disk(b), files[b]);
  if (output)
    await page.screenshot({
      path: join(output, 'editor-document-isolation.png'),
    });
  return {
    checks: [
      'different-language A/B initial bodies match titles',
      'dirty A survives navigation',
      'CmdS writes only current B model',
      'A and B keep independent Undo and CmdS histories',
    ],
    exactDiskRestoration: true,
  };
}
