import { decode, ExtensionCodec } from '@msgpack/msgpack';
import { isRecord } from './settings.js';
export interface LegacyConstructor {
  __legacy_type__: number;
  module: string;
  name: string;
  args: unknown;
  method?: string;
}
export function isConstructor(value: unknown): value is LegacyConstructor {
  return (
    isRecord(value) &&
    typeof value.__legacy_type__ === 'number' &&
    typeof value.module === 'string' &&
    typeof value.name === 'string'
  );
}
const codec = new ExtensionCodec();
for (let type = 0; type <= 7; type++)
  codec.register({
    type,
    encode: () => null,
    decode: (bytes) => {
      const value: unknown = decode(bytes, { extensionCodec: codec });
      if (type === 7) return { __delta_snapshot__: value };
      if (type === 6)
        throw new Error('unsupported array serialization in legacy checkpoint');
      if (
        !Array.isArray(value) ||
        typeof value[0] !== 'string' ||
        typeof value[1] !== 'string'
      )
        throw new Error('invalid legacy constructor descriptor');
      return {
        __legacy_type__: type,
        module: value[0],
        name: value[1],
        args: value[2],
        ...(typeof value[3] === 'string' ? { method: value[3] } : {}),
      } satisfies LegacyConstructor;
    },
  });
function jsonConstructors(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonConstructors);
  if (!isRecord(value)) return value;
  if (
    value.type === 'constructor' &&
    Array.isArray(value.id) &&
    isRecord(value.kwargs)
  ) {
    const path = value.id.map(String);
    return {
      __legacy_type__: 2,
      module: path.slice(0, -1).join('.'),
      name: path.at(-1)!,
      args: jsonConstructors(value.kwargs),
    } satisfies LegacyConstructor;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonConstructors(item)]),
  );
}
export function decodeLegacy(type: string, bytes: Uint8Array): unknown {
  if (type === 'null') return null;
  if (type === 'msgpack') return decode(bytes, { extensionCodec: codec });
  if (type === 'json')
    return jsonConstructors(JSON.parse(Buffer.from(bytes).toString('utf8')));
  if (type === 'bytes' || type === 'bytearray') return bytes;
  throw new Error(`unsupported legacy serialization: ${type}`);
}
export function unwrapSnapshot(value: unknown): unknown {
  return isRecord(value) && Object.hasOwn(value, '__delta_snapshot__')
    ? value.__delta_snapshot__
    : value;
}
export function constructorData(value: unknown): unknown {
  return isConstructor(value) && [2, 4, 5].includes(value.__legacy_type__)
    ? value.args
    : value;
}
