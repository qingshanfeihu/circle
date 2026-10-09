import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  credentialsPath,
  settingsPath,
  circleHome,
  ensureHome,
  normalizeWorkspace,
} from './paths.js';

export interface ModelAuth {
  mode: string;
  protocol: string;
  base_url: string;
  model: string;
  api_key_ref: string;
  oauth_provider: string;
}
export interface CircleSettings {
  version: number;
  initialized: boolean;
  auth: ModelAuth;
  trusted_folders: string[];
  theme: 'auto' | 'dark' | 'light';
  mcp_servers: Record<string, unknown>[];
  extensions: Record<string, Record<string, unknown>>;
  credential_files: string[];
  update_check: boolean;
  default_thinking: string;
  enabled_models: string[];
  models: Record<string, Record<string, unknown>>;
  double_escape: 'tree' | 'fork' | 'none';
  hide_thinking: boolean;
  [key: string]: unknown;
}
export const defaultAuth = (): ModelAuth => ({
  mode: 'api_key',
  protocol: 'openai',
  base_url: '',
  model: '',
  api_key_ref: 'api_key',
  oauth_provider: '',
});
export const defaultSettings = (): CircleSettings => ({
  version: 1,
  initialized: false,
  auth: defaultAuth(),
  trusted_folders: [],
  theme: 'auto',
  mcp_servers: [],
  extensions: {},
  credential_files: [],
  update_check: true,
  default_thinking: '',
  enabled_models: [],
  models: {},
  double_escape: 'tree',
  hide_thinking: false,
});
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim())
    : [];
export function loadSettingsFromDict(
  raw: Record<string, unknown>,
): CircleSettings {
  const settings = { ...raw, ...defaultSettings() };
  const auth = isRecord(raw.auth) ? raw.auth : {};
  settings.auth = Object.fromEntries(
    Object.entries(defaultAuth()).map(([key, fallback]) => [
      key,
      String(auth[key] || fallback),
    ]),
  ) as unknown as ModelAuth;
  settings.version = Number(raw.version || 1);
  settings.initialized = Boolean(raw.initialized);
  settings.trusted_folders = strings(raw.trusted_folders);
  const theme = String(raw.theme || '')
    .trim()
    .toLowerCase();
  settings.theme = theme === 'dark' || theme === 'light' ? theme : 'auto';
  settings.mcp_servers = Array.isArray(raw.mcp_servers)
    ? raw.mcp_servers.filter(isRecord)
    : [];
  settings.extensions = isRecord(raw.extensions)
    ? (Object.fromEntries(
        Object.entries(raw.extensions).filter(([, value]) => isRecord(value)),
      ) as Record<string, Record<string, unknown>>)
    : {};
  settings.credential_files = strings(raw.credential_files);
  settings.enabled_models = strings(raw.enabled_models);
  settings.models = Object.fromEntries(
    Object.entries(isRecord(raw.models) ? raw.models : {}).flatMap(
      ([name, entry]) =>
        isRecord(entry) ? [[name, structuredClone(entry)]] : [],
    ),
  );
  settings.update_check =
    raw.update_check === undefined ? true : Boolean(raw.update_check);
  settings.default_thinking = String(raw.default_thinking || '')
    .trim()
    .toLowerCase();
  const double = String(raw.double_escape || '')
    .trim()
    .toLowerCase();
  settings.double_escape =
    double === 'fork' || double === 'none' ? double : 'tree';
  settings.hide_thinking = Boolean(raw.hide_thinking);
  return settings;
}
export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(temporary, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function loadSettings(home = circleHome()): CircleSettings {
  const path = settingsPath(home);
  if (!existsSync(path)) return defaultSettings();
  const raw = readJson(path);
  if (!isRecord(raw)) throw new Error('settings.json must contain an object');
  return loadSettingsFromDict(raw);
}
export function saveSettings(
  settings: CircleSettings,
  home = circleHome(),
): string {
  const path = settingsPath(ensureHome(home));
  let previous: Record<string, unknown> = {};
  try {
    const raw = readJson(path);
    if (isRecord(raw)) previous = raw;
  } catch {
    /* Initial setup can repair malformed settings. */
  }
  writePrivateJson(path, { ...previous, ...settings });
  return path;
}
export function loadCredentials(home = circleHome()): Record<string, string> {
  const path = credentialsPath(home);
  if (!existsSync(path)) return {};
  const raw = readJson(path);
  if (!isRecord(raw))
    throw new Error('credentials.json must contain an object');
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, String(value)]),
  );
}
export function saveCredentials(
  credentials: Record<string, string>,
  home = circleHome(),
): string {
  const path = credentialsPath(ensureHome(home));
  writePrivateJson(path, { ...loadCredentials(home), ...credentials });
  return path;
}
export function clearCredentials(home = circleHome()): string {
  const path = credentialsPath(ensureHome(home));
  writePrivateJson(path, {});
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'CIRCLE_MODEL',
  ])
    delete process.env[key];
  return path;
}
export function isReady(settings: CircleSettings): boolean {
  return (
    settings.initialized &&
    Boolean(
      settings.auth.model &&
      (settings.auth.mode === 'oauth'
        ? settings.auth.oauth_provider
        : settings.auth.base_url),
    )
  );
}
export function isFolderTrusted(
  settings: CircleSettings,
  workspace: string,
): boolean {
  return settings.trusted_folders.some(
    (folder) => normalizeWorkspace(folder) === normalizeWorkspace(workspace),
  );
}
export function trustFolder(
  settings: CircleSettings,
  workspace: string,
): CircleSettings {
  const copy = structuredClone(settings);
  const target = normalizeWorkspace(workspace);
  if (!copy.trusted_folders.includes(target)) copy.trusted_folders.push(target);
  return copy;
}
export function withConnection(
  auth: ModelAuth,
  home = circleHome(),
): CircleSettings {
  let out: CircleSettings;
  try {
    out = loadSettings(home);
  } catch {
    out = defaultSettings();
  }
  if (
    out.auth.base_url.replace(/\/+$/, '') !== auth.base_url.replace(/\/+$/, '')
  )
    out.enabled_models = [];
  return { ...out, initialized: true, auth };
}
export function applyAuthToEnviron(
  settings: CircleSettings,
  home = circleHome(),
): void {
  const credentials = loadCredentials(home);
  const key =
    credentials[settings.auth.api_key_ref] || credentials.api_key || '';
  const prefix =
    settings.auth.protocol === 'anthropic' ? 'ANTHROPIC' : 'OPENAI';
  if (settings.auth.base_url)
    process.env[`${prefix}_BASE_URL`] = settings.auth.base_url;
  if (key) process.env[`${prefix}_API_KEY`] = key;
  if (settings.auth.model) process.env.CIRCLE_MODEL = settings.auth.model;
}
export const PROJECT_KEYS = [
  'model',
  'default_thinking',
  'enabled_models',
  'double_escape',
  'hide_thinking',
  'theme',
  'credential_files',
] as const;
export type ProjectChanges = Record<string, [unknown, unknown]>;
export function applyProjectSettings(
  settings: CircleSettings,
  workspace: string,
): { changed: ProjectChanges; problems: string[] } {
  const path = join(workspace, '.circle', 'settings.json');
  const changed: ProjectChanges = {};
  if (!existsSync(path)) return { changed, problems: [] };
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (error) {
    return { changed, problems: [`${path} could not be read: ${error}`] };
  }
  if (!isRecord(raw))
    return { changed, problems: [`${path} should be a JSON object`] };
  const problems = Object.keys(raw)
    .filter(
      (key) => !PROJECT_KEYS.includes(key as (typeof PROJECT_KEYS)[number]),
    )
    .map((key) => `${path}: '${key}' is not a project setting`);
  const allowed = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        PROJECT_KEYS.includes(key as (typeof PROJECT_KEYS)[number]) &&
        key !== 'model',
    ),
  );
  const project = loadSettingsFromDict({ ...settings, ...allowed });
  if (
    typeof raw.model === 'string' &&
    raw.model.trim() &&
    raw.model.trim() !== settings.auth.model
  ) {
    changed.model = [settings.auth.model, raw.model.trim()];
    settings.auth.model = raw.model.trim();
  }
  for (const key of PROJECT_KEYS) {
    if (key === 'model' || !(key in raw)) continue;
    const theirs =
      key === 'credential_files'
        ? [
            ...new Set([
              ...settings.credential_files,
              ...project.credential_files,
            ]),
          ]
        : project[key];
    if (JSON.stringify(theirs) !== JSON.stringify(settings[key])) {
      changed[key] = [structuredClone(settings[key]), structuredClone(theirs)];
      settings[key] = theirs as never;
    }
  }
  return { changed, problems };
}
export function withoutProjectSettings(
  settings: CircleSettings,
  changes: ProjectChanges,
): CircleSettings {
  const copy = structuredClone(settings);
  for (const [key, [mine, theirs]] of Object.entries(changes)) {
    if (key === 'model') {
      if (copy.auth.model === theirs) copy.auth.model = String(mine);
    } else if (JSON.stringify(copy[key]) === JSON.stringify(theirs))
      copy[key] = structuredClone(mine);
  }
  return copy;
}
