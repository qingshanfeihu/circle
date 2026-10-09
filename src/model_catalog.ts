import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { isRecord, writePrivateJson, type CircleSettings } from './settings.js';
export const CATALOG_SCHEMA = 'circle.models-dev/v1';
export const FALLBACK_WINDOW = 128_000;
export const CATALOG_URL = 'https://models.dev/api.json';
export interface Rates {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  context_over_200k?: Rates;
}
export interface CatalogEntry {
  context?: number;
  output?: number;
  cost?: Rates;
}
export interface CatalogData {
  schema: typeof CATALOG_SCHEMA;
  providers: Record<
    string,
    { api: string; models: Record<string, CatalogEntry> }
  >;
}
export interface ModelFacts {
  model: string;
  contextWindow: number;
  windowKnown: boolean;
  windowSource: 'settings' | 'models.dev' | 'profile' | 'fallback';
  outputLimit?: number;
  rates?: Rates;
  provider: string;
  priceProvider: string;
}
const SDK_HOSTS: Record<string, string> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'generativelanguage.googleapis.com': 'google',
  'api.x.ai': 'xai',
  'api.mistral.ai': 'mistral',
  'api.groq.com': 'groq',
  'api.together.xyz': 'togetherai',
  'api.deepinfra.com': 'deepinfra',
  'api.cerebras.ai': 'cerebras',
  'api.perplexity.ai': 'perplexity',
};
const PLAN = /-(?:coding|code|token|step)-plan/;
const TWINS: Record<string, [string, string]> = {
  'kimi-code-plan-cn': ['moonshotai-cn', 'kimi-'],
  'kimi-code-plan-global': ['moonshotai', 'kimi-'],
};
const PRICE_KEYS = ['input', 'output', 'cache_read', 'cache_write'] as const;
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const price = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
function rates(raw: unknown): Rates | undefined {
  if (!isRecord(raw)) return undefined;
  const result: Rates = {};
  for (const key of PRICE_KEYS) if (price(raw[key])) result[key] = raw[key];
  const rawTier = isRecord(raw.context_over_200k) ? raw.context_over_200k : {};
  const tier = isRecord(raw.context_over_200k)
    ? Object.fromEntries(
        PRICE_KEYS.filter((key) => price(rawTier[key])).map((key) => [
          key,
          rawTier[key],
        ]),
      )
    : {};
  if (Object.keys(tier).length) result.context_over_200k = tier;
  return Object.keys(result).length ? result : undefined;
}
export function slimCatalog(raw: unknown): CatalogData {
  const providers: CatalogData['providers'] = Object.create(null);
  for (const [id, provider] of Object.entries(isRecord(raw) ? raw : {})) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const models: Record<string, CatalogEntry> = Object.create(null);
    for (const [name, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) continue;
      const limit = isRecord(model.limit) ? model.limit : {};
      const entry: CatalogEntry = {};
      if (whole(limit.context)) entry.context = limit.context;
      if (whole(limit.output)) entry.output = limit.output;
      const cost = rates(model.cost);
      if (cost) entry.cost = cost;
      if (Object.keys(entry).length) models[name] = entry;
    }
    if (Object.keys(models).length)
      providers[id] = {
        api: typeof provider.api === 'string' ? provider.api : '',
        models,
      };
  }
  return { schema: CATALOG_SCHEMA, providers };
}
export function validCatalog(raw: unknown): raw is CatalogData {
  if (
    !isRecord(raw) ||
    raw.schema !== CATALOG_SCHEMA ||
    !isRecord(raw.providers) ||
    !Object.keys(raw.providers).length
  )
    return false;
  for (const provider of Object.values(raw.providers)) {
    if (
      !isRecord(provider) ||
      typeof provider.api !== 'string' ||
      !isRecord(provider.models)
    )
      return false;
    for (const model of Object.values(provider.models)) {
      if (
        !isRecord(model) ||
        ['context', 'output'].some((key) => key in model && !whole(model[key]))
      )
        return false;
      if ('cost' in model) {
        const cost = model.cost;
        if (
          !isRecord(cost) ||
          PRICE_KEYS.some((key) => key in cost && !price(cost[key]))
        )
          return false;
        const tier = cost.context_over_200k;
        if (
          tier !== undefined &&
          (!isRecord(tier) ||
            PRICE_KEYS.some((key) => key in tier && !price(tier[key])))
        )
          return false;
      }
    }
  }
  return true;
}
export function endpointHost(url: string, protocol = ''): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return protocol === 'anthropic'
      ? 'api.anthropic.com'
      : protocol === 'openai'
        ? 'api.openai.com'
        : '';
  }
}
export function windowOverrides(raw: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(isRecord(raw) ? raw : {}).flatMap(([name, entry]) =>
      isRecord(entry) && whole(entry.context_window)
        ? [[name, entry.context_window]]
        : [],
    ),
  );
}
function find(
  models: Record<string, CatalogEntry>,
  name: string,
): CatalogEntry | undefined {
  if (Object.hasOwn(models, name)) return models[name];
  const low = name.toLowerCase(),
    tail = low.split('/').at(-1);
  return Object.entries(models).find(
    ([id]) =>
      id.toLowerCase() === low || id.toLowerCase().split('/').at(-1) === tail,
  )?.[1];
}
type Found = [string, CatalogEntry];
const priced = (entry: CatalogEntry): boolean =>
  Boolean((entry.cost?.input ?? 0) > 0 || (entry.cost?.output ?? 0) > 0);
function ordered(items: Found[], vendorFirst = false): Found[] {
  const vendors = new Set(Object.values(SDK_HOSTS));
  return [...items].sort(
    (a, b) =>
      (vendorFirst
        ? Number(!vendors.has(a[0])) - Number(!vendors.has(b[0]))
        : 0) ||
      Number(PLAN.test(a[0])) - Number(PLAN.test(b[0])) ||
      a[0].localeCompare(b[0], 'en'),
  );
}
export interface CatalogOptions {
  data?: CatalogData;
  snapshotPath?: string;
  request?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}
export class ModelCatalog {
  private data: CatalogData;
  source: 'cache' | 'snapshot' | 'injected' | 'none' = 'none';
  readonly cachePath: string;
  private refreshing?: Promise<boolean>;
  private controller?: AbortController;
  private closed = false;
  private factsCache = new Map<string, ModelFacts>();
  constructor(
    readonly home: string,
    readonly options: CatalogOptions = {},
  ) {
    this.cachePath = join(home, 'cache', 'models-dev.json');
    let data: unknown = options.data;
    if (data) this.source = 'injected';
    else {
      try {
        data = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        if (validCatalog(data)) this.source = 'cache';
      } catch {
        /* Fall back to the packaged snapshot. */
      }
      if (!validCatalog(data)) {
        try {
          data = JSON.parse(
            gunzipSync(
              readFileSync(
                options.snapshotPath ??
                  join(import.meta.dirname, 'data', 'models_dev.json.gz'),
              ),
            ).toString('utf8'),
          );
          this.source = 'snapshot';
        } catch {
          data = undefined;
        }
      }
    }
    this.data = validCatalog(data)
      ? structuredClone(data)
      : { schema: CATALOG_SCHEMA, providers: {} };
    if (!validCatalog(data)) this.source = 'none';
  }
  facts(
    model: string,
    settings: Pick<CircleSettings, 'auth' | 'models'>,
    profileWindow?: number,
  ): ModelFacts {
    model = model.trim();
    const key = JSON.stringify([
      model,
      settings.auth.base_url,
      settings.auth.protocol,
      settings.models,
      profileWindow,
      (this.options.env ?? process.env).CIRCLE_MODEL_CTX,
    ]);
    const cached = this.factsCache.get(key);
    if (cached) return structuredClone(cached);
    const providers = this.data.providers,
      host = endpointHost(settings.auth.base_url, settings.auth.protocol);
    const ids = Object.keys(providers)
      .filter((id) => endpointHost(providers[id]!.api) === host)
      .sort();
    const sdk = SDK_HOSTS[host];
    if (sdk && providers[sdk] && !ids.includes(sdk)) ids.push(sdk);
    const found: Found[] = ids.flatMap((id) => {
      const entry = find(providers[id]!.models, model);
      return entry ? [[id, entry] as Found] : [];
    });
    const paid = ordered(found.filter((item) => priced(item[1])));
    let windowItem = paid[0] ?? ordered(found)[0],
      priceItem = paid[0];
    if (!priceItem && windowItem) {
      for (const [id] of found)
        if (PLAN.test(id)) {
          const [twin, prefix] = TWINS[id] ?? [id.replace(PLAN, ''), ''];
          const models = providers[twin]?.models ?? {};
          const entry =
            find(models, model) ??
            (prefix ? find(models, prefix + model) : undefined);
          if (entry && priced(entry)) {
            priceItem = [twin, entry];
            break;
          }
        }
      if (!priceItem && !PLAN.test(windowItem[0]) && windowItem[1].cost)
        priceItem = windowItem;
    }
    if (!windowItem || !priceItem) {
      const named: Found[] = Object.entries(providers).flatMap(
        ([id, provider]) => {
          const entry = find(provider.models, model);
          return entry ? [[id, entry] as Found] : [];
        },
      );
      const namedWindow = ordered(
        named.filter((item) => whole(item[1].context)),
        true,
      )[0];
      const namedPrice = ordered(
        named.filter((item) => priced(item[1])),
        true,
      )[0];
      if (!windowItem) windowItem = namedWindow;
      if (
        !priceItem &&
        namedPrice &&
        (!windowItem || PLAN.test(windowItem[0]) || windowItem === namedWindow)
      )
        priceItem = namedPrice;
    }
    const overrides = windowOverrides(settings.models);
    const rawEnv = (
      this.options.env ?? process.env
    ).CIRCLE_MODEL_CTX?.trim().replaceAll('_', '');
    const every = rawEnv && /^\d+$/.test(rawEnv) ? Number(rawEnv) : undefined;
    const override = overrides[model] ?? (whole(every) ? every : undefined);
    const contextWindow =
      override ??
      windowItem?.[1].context ??
      (whole(profileWindow) ? profileWindow : FALLBACK_WINDOW);
    const windowSource: ModelFacts['windowSource'] =
      override !== undefined
        ? 'settings'
        : windowItem?.[1].context
          ? 'models.dev'
          : whole(profileWindow)
            ? 'profile'
            : 'fallback';
    const result: ModelFacts = {
      model,
      contextWindow,
      windowKnown: windowSource !== 'fallback',
      windowSource,
      outputLimit: windowItem?.[1].output,
      rates: priceItem?.[1].cost
        ? structuredClone(priceItem[1].cost)
        : undefined,
      provider: windowItem?.[0] ?? '',
      priceProvider: priceItem?.[0] ?? '',
    };
    this.factsCache.set(key, result);
    return structuredClone(result);
  }
  refresh(onRefreshed?: () => void): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.refreshing) return this.refreshing;
    this.controller = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(20_000),
    ]);
    this.refreshing = (async () => {
      try {
        const response = await (this.options.request ?? fetch)(CATALOG_URL, {
          signal,
          headers: { Accept: 'application/json', 'User-Agent': 'circle' },
        });
        if (!response.ok) return false;
        // Stream a bounded body; corrupt or changed remote data never replaces a valid copy.
        const reader = response.body?.getReader();
        if (!reader) return false;
        const chunks: Uint8Array[] = [];
        let size = 0;
        const abort = (): void => {
          void reader.cancel(signal.reason).catch(() => {});
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 32_000_000) throw new Error('catalog too large');
            chunks.push(value);
          }
        } finally {
          signal.removeEventListener('abort', abort);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        const data = slimCatalog(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (!validCatalog(data) || signal.aborted || this.closed) return false;
        mkdirSync(join(this.home, 'cache'), { recursive: true });
        writePrivateJson(this.cachePath, data);
        this.data = data;
        this.factsCache.clear();
        this.source = 'cache';
        try {
          onRefreshed?.();
        } catch {
          /* A display failure does not invalidate the data. */
        }
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      this.refreshing = undefined;
      this.controller = undefined;
    });
    return this.refreshing;
  }
  refreshIfStale(
    onRefreshed?: () => void,
    maxAge = 86_400_000,
  ): Promise<boolean> | undefined {
    if ((this.options.env ?? process.env).CIRCLE_NO_MODELS_REFRESH)
      return undefined;
    try {
      if (
        this.source === 'cache' &&
        Date.now() - statSync(this.cachePath).mtimeMs < maxAge
      )
        return undefined;
    } catch {
      /* No cache yet. */
    }
    return this.refresh(onRefreshed);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    await this.refreshing;
  }
}
