import { resolve, relative, isAbsolute } from 'node:path';
export const APP_ORIGIN = 'circle://workbench';
export const MAX_FILE_BYTES = 4_000_000;
export const MAX_EXPORT_BYTES = 8_000_000;
export const MAX_TEXT_PREVIEW = 256_000;
export function trustedAppUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'circle:' &&
      url.host === 'workbench' &&
      url.pathname === '/index.html'
    );
  } catch {
    return false;
  }
}
export function assetPath(root: string, value: string) {
  const url = new URL(value);
  if (url.protocol !== 'circle:' || url.host !== 'workbench')
    throw Error('invalid application origin');
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    pathname.split('/').includes('..')
  )
    throw Error('invalid asset path');
  const path = resolve(
    root,
    '.' + (pathname === '/' ? '/index.html' : pathname),
  );
  const local = relative(root, path);
  if (local.startsWith('..') || isAbsolute(local))
    throw Error('asset is outside the application');
  return path;
}
export function validSaveName(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 180 ||
    /[\\/\0\r\n]/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw Error('invalid export name');
  return value;
}
export function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
export function boundedText(value: unknown, maxBytes: number) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes)
    throw Error('text exceeds the allowed size');
  return value;
}
