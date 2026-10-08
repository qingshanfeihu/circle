import { decodeHTML } from 'entities';
export type FetchFunction = typeof fetch;
export function stripTags(text: string): string {
  return decodeHTML(
    text
      .replace(
        /<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,
        '',
      )
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}
export function parseSearchHtml(
  raw: string,
  query: string,
  numResults = 5,
  year = new Date().getUTCFullYear(),
): string {
  const links: { url: string; title: string }[] = [];
  const snippets = [
    ...raw.matchAll(
      /class=(["'])[^"']*result(?:__snippet|-snippet)[^"']*\1[^>]*>([\s\S]*?)<\/(?:a|td|div|tr)>/gi,
    ),
  ].map((match) => stripTags(match[2]!));
  for (const match of raw.matchAll(
    /<a\b[^>]*\bhref=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    let href = decodeHTML(match[2]!.trim());
    if (href.startsWith('//')) href = 'https:' + href;
    try {
      const source = new URL(href);
      if (source.searchParams.has('uddg'))
        href = source.searchParams.get('uddg')!;
      else if (source.hostname.endsWith('duckduckgo.com')) continue;
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      links.push({ url: url.toString(), title: stripTags(match[3]!) || href });
    } catch {
      /* Ignore navigation and malformed links. */
    }
  }
  if (!links.length)
    return `No results for ${JSON.stringify(query)} (year hint: ${year}).`;
  const lines = [
    `Web search results for ${JSON.stringify(query)} (as of ${year}):`,
    '',
  ];
  links
    .slice(0, Math.max(1, Math.min(10, numResults)))
    .forEach((link, index) => {
      lines.push(`${index + 1}. ${link.title}`, `   ${link.url}`);
      if (snippets[index]) lines.push('   ' + snippets[index]);
      lines.push('');
    });
  return lines.join('\n').trimEnd();
}
export async function limitedBody(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (size + next.value.byteLength > limit) {
        chunks.push(next.value.subarray(0, Math.max(0, limit - size)));
        truncated = true;
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
export async function webSearch(
  query: string,
  signal: AbortSignal,
  numResults = 5,
  request: FetchFunction = fetch,
): Promise<string> {
  const text = query.trim();
  if (!text) throw new Error('query is required');
  let last = '';
  for (const host of [
    'https://lite.duckduckgo.com/lite/',
    'https://html.duckduckgo.com/html/',
  ]) {
    signal.throwIfAborted();
    try {
      const url = new URL(host);
      url.searchParams.set('q', text);
      const response = await request(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: {
          'User-Agent': 'Circle/0.1 (+local coding agent)',
          Accept: 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await limitedBody(response, 500000);
      if (body.text) return parseSearchHtml(body.text, text, numResults);
    } catch (error) {
      signal.throwIfAborted();
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error('search failed: ' + (last || 'empty body'));
}
export function blockedHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !value ||
    ['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'].includes(value) ||
    value.endsWith('.local') ||
    value.endsWith('.localhost')
  )
    return true;
  if (
    /^(?:127\.|169\.254\.|10\.|192\.168\.)/.test(value) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(value) ||
    /^(?:fc|fd)[a-f0-9]{2}:|^fe[89ab][a-f0-9]:/.test(value)
  )
    return true;
  return false;
}
export async function webFetch(
  raw: string,
  format: string,
  signal: AbortSignal,
  request: FetchFunction = fetch,
): Promise<string> {
  let url = new URL(raw.trim());
  if (url.protocol === 'http:') url.protocol = 'https:';
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 10; redirect++) {
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error('use an http(s) URL without credentials');
    if (blockedHost(url.hostname))
      throw new Error(`refusing to fetch local/private host '${url.hostname}'`);
    signal.throwIfAborted();
    response = await request(url, {
      redirect: 'manual',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      headers: {
        'User-Agent': 'Circle/0.1 (+local coding agent)',
        Accept: 'text/*,application/json',
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('redirect has no location');
    url = new URL(location, url);
    if (redirect === 10) throw new Error('too many redirects');
  }
  if (!response?.ok)
    throw new Error(`HTTP ${response?.status} fetching ${url}`);
  const body = await limitedBody(response, 500000);
  const type = response.headers.get('content-type')?.toLowerCase() || 'unknown';
  let rendered = body.text;
  if (type.includes('json')) {
    try {
      rendered = JSON.stringify(JSON.parse(body.text), null, 2);
    } catch {
      /* A truncated JSON document remains text. */
    }
  } else if (
    format !== 'html' &&
    (type.includes('html') || /<html/i.test(body.text.slice(0, 200)))
  )
    rendered = stripTags(body.text);
  return `URL: ${url}\nContent-Type: ${type}\n${body.truncated ? '(truncated to 500000 bytes)\n' : ''}\n${rendered}`;
}
