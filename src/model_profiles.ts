import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { isRecord } from './settings.js';
export interface ModelProfile {
  max_input_tokens?: number;
  max_output_tokens?: number;
  reasoning_effort_levels?: string[];
  reasoning_output?: boolean;
  image_inputs?: boolean;
  pdf_inputs?: boolean;
  image_url_inputs?: boolean;
  tool_calling?: boolean;
}
let profiles: Record<string, Record<string, ModelProfile>> | undefined;
export function modelProfile(
  protocol: string,
  name: string,
): ModelProfile | undefined {
  if (!profiles) {
    try {
      const raw: unknown = JSON.parse(
        gunzipSync(
          readFileSync(
            join(import.meta.dirname, 'data', 'provider_profiles.json.gz'),
          ),
        ).toString('utf8'),
      );
      profiles = isRecord(raw)
        ? (raw as Record<string, Record<string, ModelProfile>>)
        : {};
    } catch {
      profiles = {};
    }
  }
  const models = profiles?.[protocol] ?? {};
  const tail = name.toLowerCase().split('/').at(-1);
  const entry = Object.entries(models).find(
    ([id]) =>
      id.toLowerCase() === name.toLowerCase() || id.toLowerCase() === tail,
  )?.[1];
  return entry ? structuredClone(entry) : undefined;
}
export const EFFORT_ORDER = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
export function fitEffort(requested: string, levels: string[]): string {
  const rank = EFFORT_ORDER.indexOf(requested);
  const available = EFFORT_ORDER.filter((level) => levels.includes(level));
  const below = available.filter(
    (level) =>
      EFFORT_ORDER.indexOf(level) <= (rank < 0 ? EFFORT_ORDER.length : rank),
  );
  return below.at(-1) ?? available[0] ?? requested;
}
export const THINKING_BUDGET: Record<string, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16000,
  xhigh: 16000,
  max: 31999,
};
