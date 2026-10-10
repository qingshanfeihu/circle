import type { Session, Message, Attachment } from './types.ts';
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function isAttachment(value: unknown): value is Attachment {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.content === 'string' &&
    ['file', 'image', 'document', 'skill', 'paste'].includes(
      String(value.kind),
    ) &&
    (value.kind !== 'image' ||
      /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(value.content))
  );
}
export function isMessage(value: unknown): value is Message {
  if (
    !object(value) ||
    typeof value.id !== 'string' ||
    !(value.parentId === null || typeof value.parentId === 'string') ||
    !['user', 'assistant', 'tool', 'notice'].includes(String(value.role)) ||
    typeof value.text !== 'string' ||
    typeof value.at !== 'string'
  )
    return false;
  if (
    value.attachments !== undefined &&
    (!Array.isArray(value.attachments) ||
      !value.attachments.every(isAttachment))
  )
    return false;
  if (value.tool !== undefined) {
    const tool = value.tool;
    if (
      !object(tool) ||
      typeof tool.name !== 'string' ||
      typeof tool.id !== 'string' ||
      !object(tool.input) ||
      typeof tool.output !== 'string' ||
      !['running', 'success', 'error', 'waiting', 'unknown'].includes(
        String(tool.status),
      )
    )
      return false;
  }
  return true;
}
export function parsePreviewBundle(text: string, base: Session): Session {
  if (text.length > 4_000_000) throw Error('preview bundle exceeds 4 MB');
  const value: unknown = JSON.parse(text);
  if (
    !object(value) ||
    value.schema !== 'circle-workbench-preview/v1' ||
    !object(value.session)
  )
    throw Error(
      'not a Circle workbench preview bundle; native JSONL requires a runtime',
    );
  const source = value.session;
  if (
    !Array.isArray(source.messages) ||
    source.messages.length > 10000 ||
    !source.messages.every(isMessage) ||
    !Array.isArray(source.attachments) ||
    !source.attachments.every(isAttachment) ||
    typeof source.title !== 'string' ||
    typeof source.model !== 'string' ||
    !(source.leafId === null || typeof source.leafId === 'string')
  )
    throw Error('invalid session structure');
  const messages = source.messages as Message[];
  const nodes = new Map(messages.map((message) => [message.id, message]));
  if (
    nodes.size !== messages.length ||
    (source.leafId !== null && !nodes.has(source.leafId))
  )
    throw Error('invalid or duplicate message identity');
  for (const message of messages) {
    const seen = new Set<string>();
    let id: string | null = message.id;
    while (id) {
      if (seen.has(id) || !nodes.has(id))
        throw Error('broken or cyclic session tree');
      seen.add(id);
      id = nodes.get(id)!.parentId;
    }
  }
  return {
    ...base,
    title: source.title,
    model: source.model,
    messages: structuredClone(messages),
    leafId: source.leafId,
    attachments: structuredClone(source.attachments as Attachment[]),
    draft: typeof source.draft === 'string' ? source.draft : '',
    auto: false,
    state: 'idle',
    hiddenIds: [],
    undoStack: [],
  };
}
