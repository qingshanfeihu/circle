import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import type { Tool, ToolCall } from './types.js';
import { isRecord } from './settings.js';
export class RecoverableToolError extends Error {
  readonly recoverable = true;
}
export function canonical(name: string): string {
  const match = name.match(/^mcp__(.+?)__(.+)$/);
  return (match ? match[1] + '_' + match[2] : name)
    .replace(/[-_\s]+/g, '')
    .toLowerCase();
}
export function resolveName(
  name: string,
  candidates: string[],
): string | undefined {
  if (candidates.includes(name)) return name;
  const exactCase = candidates.filter(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (exactCase.length === 1) return exactCase[0];
  const loose = candidates.filter(
    (candidate) => canonical(candidate) === canonical(name),
  );
  return loose.length === 1 ? loose[0] : undefined;
}
export function repairUnicodeEscapes(text: string): string {
  let result = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char !== '\\' || next !== 'u') {
      result += char;
      if (char === '\\' && next === '\\') result += text[++index];
      continue;
    }
    let cursor = index + 2;
    let digits = '';
    while (cursor < text.length && digits.length < 4) {
      const current = text[cursor]!;
      if (/[0-9a-f]/i.test(current)) digits += current;
      else if (!/\s/u.test(current)) break;
      cursor++;
    }
    if (digits.length === 4) {
      result += '\\u' + digits;
      index = cursor - 1;
    } else result += char;
  }
  return result;
}
export function parseToolInput(text: string): unknown {
  if (!text.trim()) return {};
  for (const candidate of [text, repairUnicodeEscapes(text)])
    try {
      return JSON.parse(candidate);
    } catch {
      /* Try the unambiguous Unicode repair. */
    }
  return text;
}
function types(schema: Record<string, unknown>): Set<string> {
  const result = new Set(
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
  );
  for (const key of ['allOf', 'anyOf', 'oneOf'])
    if (Array.isArray(schema[key]))
      for (const branch of schema[key])
        if (isRecord(branch))
          for (const type of types(branch)) result.add(type);
  return result;
}
function normalize(
  value: unknown,
  schema: Record<string, unknown>,
  optional = false,
): unknown {
  const allowed = types(schema);
  if (value === null && optional && !allowed.has('null')) {
    if (allowed.has('array')) return [];
    if (allowed.has('object')) return {};
  }
  if (
    typeof value === 'string' &&
    !allowed.has('string') &&
    (allowed.has('array') || allowed.has('object'))
  ) {
    const parsed = parseToolInput(value);
    if (
      (Array.isArray(parsed) && allowed.has('array')) ||
      (isRecord(parsed) && allowed.has('object'))
    )
      value = parsed;
  }
  if (
    Array.isArray(value) &&
    allowed.has('string') &&
    !allowed.has('array') &&
    value.length === 1 &&
    typeof value[0] === 'string'
  )
    return value[0];
  if (Array.isArray(value))
    return value.map((item) =>
      isRecord(schema.items) ? normalize(item, schema.items) : item,
    );
  if (!isRecord(value)) return value;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const target = resolveName(key, keys) ?? key;
    if (Object.hasOwn(result, target))
      throw new RecoverableToolError(
        `arguments contain ambiguous aliases for field ${target}`,
      );
    const property = properties[target];
    result[target] = isRecord(property)
      ? normalize(item, property, !required.has(target))
      : item;
  }
  return result;
}
const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: true });
const validators = new WeakMap<Tool, ValidateFunction>();
function validationDetail(errors: ErrorObject[]): string {
  return (
    errors
      .slice(0, 6)
      .map(
        (error) =>
          `${error.instancePath || '<root>'}${error.keyword === 'required' ? '.' + String(error.params.missingProperty) : ''}: ${error.message || 'is invalid'}`,
      )
      .join('; ') +
    (errors.length > 6 ? `; +${errors.length - 6} more fields` : '')
  );
}
export function prepareToolCall(
  call: ToolCall,
  tools: Tool[],
): { tool: Tool; call: ToolCall } {
  if (call.argument_error) throw new RecoverableToolError(call.argument_error);
  let tool = tools.find((tool) => tool.name === call.name);
  if (!tool) {
    const resolved = resolveName(
      call.name,
      tools.map((tool) => tool.name),
    );
    const found = tools.find((tool) => tool.name === resolved);
    if (!found || found.effect !== 'read' || found.approval === true)
      throw new RecoverableToolError(`tool is not available: ${call.name}`);
    tool = found;
  }
  const args = normalize(structuredClone(call.args), tool.parameters);
  if (!isRecord(args))
    throw new RecoverableToolError('tool arguments must be an object');
  let validate = validators.get(tool);
  if (!validate) {
    validate = ajv.compile(tool.parameters);
    validators.set(tool, validate);
  }
  if (!validate(args))
    throw new RecoverableToolError(
      `${tool.name} was called with invalid arguments: ${validationDetail(validate.errors ?? [])}. Re-issue the call with arguments that satisfy the declared schema; no work was done.`,
    );
  return { tool, call: { ...call, name: tool.name, args } };
}
