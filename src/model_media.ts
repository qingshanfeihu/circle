import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import type {
  ImageBlockParam,
  DocumentBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type { MediaAttachment, Message } from './types.js';
import { validateAttachments } from './media.js';

export function checkRequestMedia(messages: Message[]): void {
  let size = 0;
  for (const message of messages) {
    if (!message.attachments) continue;
    if (!['user', 'tool'].includes(message.role))
      throw new Error('attachments require a user or tool message');
    validateAttachments(message.attachments);
    size += message.attachments.reduce(
      (sum, item) => sum + item.data.length,
      0,
    );
  }
  if (size > 28 * 1024 * 1024)
    throw new Error(
      'media in this request exceeds 28 MiB of encoded data; compact the conversation or use smaller files',
    );
}
export function openAIContent(
  text: string,
  attachments: MediaAttachment[] = [],
): ChatCompletionContentPart[] {
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((item): ChatCompletionContentPart =>
      item.kind === 'image'
        ? {
            type: 'image_url',
            image_url: { url: `data:${item.mime_type};base64,${item.data}` },
          }
        : {
            type: 'file',
            file: {
              filename: item.filename,
              file_data: `data:application/pdf;base64,${item.data}`,
            },
          },
    ),
  ];
}
export function anthropicContent(
  text: string,
  attachments: MediaAttachment[] = [],
): (TextBlockParam | ImageBlockParam | DocumentBlockParam)[] {
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...attachments.map((item): ImageBlockParam | DocumentBlockParam =>
      item.kind === 'image'
        ? {
            type: 'image',
            source: {
              type: 'base64',
              media_type: item.mime_type as Exclude<
                MediaAttachment['mime_type'],
                'application/pdf'
              >,
              data: item.data,
            },
          }
        : {
            type: 'document',
            title: item.filename,
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: item.data,
            },
          },
    ),
  ];
}
