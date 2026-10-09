import { isCertificateError, TLS_HINT } from './net.js';
export interface ProbeResult {
  protocol: string;
  models: string[];
  inferred: boolean;
  base_url: string;
  status: 'discovered' | 'empty' | 'failed';
  detail: string;
}
const BAD_URL =
  'use an http(s) API base URL without credentials, query or fragment';
export function normalizeBaseUrl(baseUrl: string, protocol: string): string {
  if (!['openai', 'anthropic'].includes(protocol))
    throw new Error('protocol must be openai or anthropic');
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    // Not a URL at all: the same words as a URL of the wrong kind, as 0.5.0 said it
    throw new Error(BAD_URL);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.port === '0' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(BAD_URL);
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (protocol === 'anthropic')
    url.pathname = url.pathname.replace(/\/v1$/, '');
  return url.toString().replace(/\/+$/, '');
}
// What setup says the endpoint answered (0.5.0's ProbeResult.summary).
export function probeSummary(found: ProbeResult): string {
  if (found.status === 'failed' || found.inferred)
    return (
      'model discovery failed' +
      (found.inferred ? '; protocol is unverified' : '') +
      (found.detail ? ` (${found.detail})` : '')
    );
  if (!found.models.length)
    return `endpoint returned an empty model list (${found.protocol})`;
  return `discovered ${found.models.length} models (${found.protocol})`;
}
export function inferProtocolHint(base: string): string | undefined {
  if (/anthropic/i.test(base)) return 'anthropic';
  if (/openai|compatible-mode|openrouter|\/v1\/chat|azure/i.test(base))
    return 'openai';
  return undefined;
}
export async function resolveEndpoint(
  baseUrl: string,
  apiKey: string,
  options: { timeout?: number; protocol?: string } = {},
): Promise<ProbeResult> {
  const preferred = options.protocol || inferProtocolHint(baseUrl) || 'openai';
  if (options.protocol && !['openai', 'anthropic'].includes(options.protocol))
    throw new Error('protocol must be openai or anthropic');
  const failures: string[] = [];
  let empty: ProbeResult | undefined;
  let base: string;
  try {
    base = normalizeBaseUrl(baseUrl, 'openai');
  } catch {
    return {
      protocol: preferred,
      models: [],
      inferred: !options.protocol,
      base_url: '',
      status: 'failed',
      detail: 'invalid API base URL',
    };
  }
  if (!apiKey)
    return {
      protocol: preferred,
      models: [],
      inferred: !options.protocol,
      base_url: base,
      status: 'failed',
      detail: 'missing API key',
    };
  for (const protocol of options.protocol
    ? [options.protocol]
    : [preferred, preferred === 'openai' ? 'anthropic' : 'openai']) {
    const bases =
      protocol === 'anthropic'
        ? [normalizeBaseUrl(base, 'anthropic')]
        : /\/v\d+(beta\d*)?$/.test(new URL(base).pathname)
          ? [base]
          : [base, base + '/v1'];
    for (const resolved of bases) {
      try {
        const headers: Record<string, string> =
          protocol === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { Authorization: `Bearer ${apiKey}` };
        const response = await fetch(
          resolved + (protocol === 'anthropic' ? '/v1/models' : '/models'),
          { headers, signal: AbortSignal.timeout(options.timeout ?? 2500) },
        );
        if (!response.ok) {
          failures.push(`http ${response.status}`);
          continue;
        }
        const data = (await response.json()) as { data?: { id?: unknown }[] };
        if (
          !Array.isArray(data.data) ||
          data.data.some(
            (item) => typeof item?.id !== 'string' || !item.id.trim(),
          )
        ) {
          failures.push('invalid model list');
          continue;
        }
        const models = [...new Set(data.data.map((item) => String(item.id)))];
        const result: ProbeResult = {
          protocol,
          models,
          inferred: false,
          base_url: resolved,
          status: models.length ? 'discovered' : 'empty',
          detail: '',
        };
        if (models.length) return result;
        empty ??= result;
      } catch (error) {
        failures.push(
          isCertificateError(error)
            ? TLS_HINT
            : 'connection failed or invalid JSON',
        );
      }
    }
  }
  return (
    empty ?? {
      protocol: preferred,
      models: [],
      inferred: !options.protocol,
      base_url: base,
      status: 'failed',
      detail: [...new Set(failures)].join(', '),
    }
  );
}
