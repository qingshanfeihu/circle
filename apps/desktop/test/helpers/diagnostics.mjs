import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export function observePage(page, events) {
  page.on('pageerror', (error) => events.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') events.push(message.text());
  });
  page.on('requestfailed', (request) =>
    events.push(request.url() + ': ' + request.failure()?.errorText),
  );
}
export async function captureFailure(page, error, events, output) {
  const details = {
    error: String(error),
    events,
    url: page?.url(),
    body: await page
      ?.locator('body')
      .innerText()
      .catch(() => ''),
  };
  if (page)
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(details, null, 2) + '\n',
  );
  console.error(JSON.stringify(details));
}
