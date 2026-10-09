import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import type { MediaAttachment, Message } from './types.js';
import { isRecord } from './settings.js';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MIME: Record<string, MediaAttachment['mime_type']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
export function mediaType(
  path: string,
): MediaAttachment['mime_type'] | undefined {
  return MIME[extname(path).toLowerCase()];
}
export function summaryMessages(messages: Message[]): unknown[] {
  return messages.map(
    ({
      attachments,
      provider_content: _provider,
      legacy_data: _legacy,
      ...message
    }) => ({
      ...message,
      ...(attachments?.length
        ? {
            attachments: attachments.map(
              ({ data: _data, ...receipt }) => receipt,
            ),
          }
        : {}),
    }),
  );
}
export function makeAttachment(
  bytes: Buffer,
  mime: MediaAttachment['mime_type'],
  filename: string,
): MediaAttachment {
  if (!Object.values(MIME).includes(mime))
    throw new Error('unsupported attachment MIME type');
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES)
    throw new Error('attachment must contain 1 byte to 20 MiB');
  return {
    kind: mime === 'application/pdf' ? 'document' : 'image',
    mime_type: mime,
    filename: basename(filename.replaceAll('\\', '/')),
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
export function validateAttachments(
  value: unknown,
): asserts value is MediaAttachment[] {
  if (!Array.isArray(value) || value.length > 16)
    throw new Error('invalid attachments');
  for (const item of value) {
    if (
      !isRecord(item) ||
      !Object.values(MIME).includes(
        item.mime_type as MediaAttachment['mime_type'],
      ) ||
      item.kind !==
        (item.mime_type === 'application/pdf' ? 'document' : 'image') ||
      typeof item.filename !== 'string' ||
      !item.filename ||
      /[\x00-\x1f\x7f/\\]/.test(item.filename) ||
      typeof item.data !== 'string' ||
      item.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ||
      item.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(item.data)
    )
      throw new Error('invalid attachment');
    const bytes = Buffer.from(item.data, 'base64');
    if (
      !bytes.length ||
      bytes.toString('base64') !== item.data ||
      bytes.length > MAX_MEDIA_BYTES ||
      item.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('attachment bytes do not match their receipt');
  }
}
export function attachmentFromBase64(
  data: string,
  mime: MediaAttachment['mime_type'],
  filename: string,
): MediaAttachment {
  if (
    data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data)
  )
    throw new Error('invalid attachment base64');
  const item = makeAttachment(Buffer.from(data, 'base64'), mime, filename);
  if (item.data !== data) throw new Error('invalid attachment base64');
  validateAttachments([item]);
  return item;
}
export function inlineLegacyAttachments(
  blocks: unknown[],
  filename = 'attachment',
): MediaAttachment[] {
  const items: MediaAttachment[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const source = isRecord(block.source) ? block.source : undefined;
    const file = isRecord(block.file) ? block.file : undefined;
    const image = isRecord(block.image_url)
      ? block.image_url.url
      : block.image_url;
    const uri = typeof image === 'string' ? image : file?.file_data;
    const match =
      typeof uri === 'string' ? /^data:([^;,]+);base64,(.*)$/s.exec(uri) : null;
    const mime = block.mime_type ?? source?.media_type ?? match?.[1];
    const data =
      block.base64 ??
      (source?.type === 'base64' ? source.data : undefined) ??
      match?.[2];
    if (
      typeof mime !== 'string' ||
      typeof data !== 'string' ||
      !Object.values(MIME).includes(mime as MediaAttachment['mime_type'])
    )
      continue;
    const name =
      typeof file?.filename === 'string'
        ? file.filename
        : `${filename.replaceAll('\\', '/').split('/').at(-1)}-${items.length + 1}.${mime.split('/')[1]}`;
    items.push(
      attachmentFromBase64(data, mime as MediaAttachment['mime_type'], name),
    );
  }
  validateAttachments(items);
  return items;
}
export async function readAttachment(
  path: string,
  signal: AbortSignal,
): Promise<MediaAttachment> {
  const mime = mediaType(path);
  if (!mime) throw new Error('unsupported attachment file type');
  signal.throwIfAborted();
  const input = createReadStream(path, { signal });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      length += chunk.length;
      if (length > MAX_MEDIA_BYTES)
        throw new Error('attachment exceeds 20 MiB; use a smaller file');
      chunks.push(chunk);
    }
  } finally {
    input.destroy();
  }
  signal.throwIfAborted();
  return makeAttachment(Buffer.concat(chunks), mime, basename(path));
}
